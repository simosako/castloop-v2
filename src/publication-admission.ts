import { z } from "zod";
import { controlRequestSchema, episodeCommitSchema, episodeRevisionSchema, parseControlRequest, parseEpisodeRevision, parseJobStatus, parseLifecycleProgress,
  permitsControlAction, showCommitSchema, stageControlRequest, stagePayloadKey, stageUploadProgressSchema,
  stageUploadRequestSchema, publicationCommitKey, publicationRequestSchema } from "../packages/shared/src/index";
import type { EpisodeCommit, EpisodeRevision, PublicationRequest, ShowCommit, StageAsset, StageUploadProgress, StageUploadRequest } from "../packages/shared/src/index";
import { claimShowOperation, controlRequestHash, readEpisodeLifecycle, requireOwnedOperation } from "./lifecycle-control";
import type { LifecycleControlEnv, OwnedShowControlSnapshot } from "./lifecycle-control";
import { canonicalEnclosureUrl } from "./media-url";
import { parsePublicAssetPath } from "./public-assets";
import { stageManifestHash } from "./staging-upload";

export { publicationCommitKey, publicationRequestSchema } from "../packages/shared/src/index";
export type { PublicationRequest } from "../packages/shared/src/index";
export type PublicationOperation = { showId: string; jobId: string; generation: number };
export type PublicationCommitTarget = { kind: "show" | "episode"; showId: string; jobId: string; episodeId?: string };
export type OwnedPublication = { frozen: PublicationRequest; control: OwnedShowControlSnapshot };

export class InvalidFrozenPublication extends Error {
  constructor() { super("Publication commit does not match its frozen request and target"); }
}

export function parsePublicationCommitKey(key: string): PublicationCommitTarget | null {
  const parts = key.split("/");
  if (parts[0] !== "staging" || parts.at(-1) !== "commit.json" ||
    !controlRequestSchema.shape.show_id.safeParse(parts[2]).success || !z.uuid().safeParse(parts.at(-2)).success) return null;
  if (parts[1] === "shows" && parts.length === 5) return { kind: "show", showId: parts[2]!, jobId: parts[3]! };
  if (parts[1] === "episodes" && parts.length === 6 && controlRequestSchema.shape.episode_id.unwrap().safeParse(parts[3]).success) {
    return { kind: "episode", showId: parts[2]!, episodeId: parts[3]!, jobId: parts[4]! };
  }
  return null;
}

async function readFrozenRequest(env: LifecycleControlEnv, jobId: string): Promise<PublicationRequest> {
  const object = await env.CASTLOOP_BUCKET.get(`system/jobs/${jobId}/publication.json`);
  if (!object || object.size < 1 || object.size > 16384) throw new InvalidFrozenPublication();
  const source = await object.text();
  try { return publicationRequestSchema.parse(JSON.parse(source)); }
  catch { throw new InvalidFrozenPublication(); }
}

export async function readFrozenPublicationCommit(env: LifecycleControlEnv, key: string): Promise<PublicationRequest | null> {
  const target = parsePublicationCommitKey(key);
  if (!target) throw new InvalidFrozenPublication();
  const object = await env.CASTLOOP_BUCKET.get(key);
  if (!object) return null;
  if (object.size < 1 || object.size > 16384) throw new InvalidFrozenPublication();
  const source = await object.text();
  let marker: ShowCommit | EpisodeCommit;
  try { marker = z.union([showCommitSchema, episodeCommitSchema]).parse(JSON.parse(source)); }
  catch { throw new InvalidFrozenPublication(); }
  if (marker.kind !== target.kind || marker.show_id !== target.showId || marker.job_id !== target.jobId ||
    (marker.kind === "episode" ? marker.episode_id : undefined) !== target.episodeId) throw new InvalidFrozenPublication();
  const frozen = await readFrozenRequest(env, marker.job_id);
  const controlObject = await env.CASTLOOP_BUCKET.get(`system/jobs/${marker.job_id}/request.toml`);
  if (!controlObject || controlObject.size < 1 || controlObject.size > 16384) throw new InvalidFrozenPublication();
  const controlSource = await controlObject.text();
  let request;
  try { request = parseControlRequest(controlSource); }
  catch { throw new InvalidFrozenPublication(); }
  if (JSON.stringify(marker) !== JSON.stringify(frozen.commit) || JSON.stringify(request) !== JSON.stringify(frozen.request)) {
    throw new InvalidFrozenPublication();
  }
  return frozen;
}

export async function requireOwnedPublication(env: LifecycleControlEnv, operation: PublicationOperation,
  options: { allowPublishedResult?: boolean } = {}): Promise<OwnedPublication> {
  const control = await requireOwnedOperation(env, operation.showId, operation.jobId, operation.generation);
  const frozen = await readFrozenRequest(env, operation.jobId);
  const request = frozen.request;
  if (request.job_id !== operation.jobId || request.show_id !== operation.showId || request.expected_show_generation + 1 !== operation.generation ||
    control.value.owner.action !== "publish" || await controlRequestHash(request) !== control.value.owner.request_sha256 ||
    !permitsControlAction(control.value.lifecycle, "publish") || request.kind === "episode" && control.value.lifecycle !== "active") {
    throw new InvalidFrozenPublication();
  }
  if (request.kind === "episode") {
    const episode = await readEpisodeLifecycle(env, operation.showId, request.episode_id!);
    const ownResult = options.allowPublishedResult && episode?.lifecycle === "active" && episode.last_job_id === operation.jobId &&
      episode.generation === request.expected_episode_generation! + 1;
    if (!episode || !permitsControlAction(episode.lifecycle, "publish") || episode.generation !== request.expected_episode_generation && !ownResult) {
      throw new InvalidFrozenPublication();
    }
    if (ownResult) {
      const object = await env.CASTLOOP_BUCKET.get(`system/jobs/${operation.jobId}/progress.toml`);
      if (!object || object.size > 16384) throw new InvalidFrozenPublication();
      const progress = parseLifecycleProgress(await object.text());
      if (progress.job_id !== operation.jobId || progress.show_id !== operation.showId || progress.show_generation !== operation.generation ||
        progress.action !== "publish" || progress.kind !== "episode" || progress.episode_id !== request.episode_id ||
        progress.request_sha256 !== control.value.owner.request_sha256 || !progress.purge_confirmed ||
        !["visibility", "finished"].includes(progress.phase)) throw new InvalidFrozenPublication();
    }
  }
  return { frozen, control };
}

type StagedProof = { request: StageUploadRequest; progress: StageUploadProgress };
async function readStagedProof(env: LifecycleControlEnv, frozen: PublicationRequest, operationId: string): Promise<StagedProof> {
  const requestObject = await env.CASTLOOP_BUCKET.get(`system/jobs/${operationId}/upload.json`);
  const progressObject = await env.CASTLOOP_BUCKET.get(`system/jobs/${operationId}/upload-progress.json`);
  const statusObject = await env.CASTLOOP_BUCKET.get(`system/jobs/${operationId}/status.toml`);
  if (!requestObject || !progressObject || !statusObject || [requestObject, progressObject, statusObject].some((object) => object.size < 1 || object.size > 16384)) {
    throw new Error("Publication requires retained staging verification records");
  }
  const request = stageUploadRequestSchema.parse(await requestObject.json<unknown>());
  const progress = stageUploadProgressSchema.parse(await progressObject.json<unknown>());
  const status = parseJobStatus(await statusObject.text());
  if (request.operation_id !== operationId || request.draft_job_id !== frozen.commit.job_id || request.show_id !== frozen.commit.show_id ||
    request.kind !== frozen.commit.kind || request.episode_id !== frozen.request.episode_id ||
    request.expected_show_generation + 1 > frozen.request.expected_show_generation ||
    request.expected_episode_generation !== frozen.request.expected_episode_generation ||
    progress.operation_id !== operationId || progress.show_id !== request.show_id || progress.show_generation !== request.expected_show_generation + 1 ||
    progress.manifest_sha256 !== await stageManifestHash(request) || progress.phase !== "finished" || progress.outcome !== "staged" ||
    progress.verified_assets.length !== request.payloads.length || status.schema_version !== 2 || status.state !== "completed" ||
    status.action !== "stage" || status.job_id !== operationId || status.show_id !== request.show_id || status.kind !== request.kind ||
    status.episode_id !== request.episode_id || status.show_generation !== progress.show_generation ||
    status.request_sha256 !== await controlRequestHash(stageControlRequest(request))) {
    throw new Error("Staging verification does not match the publication target and generations");
  }
  return { request, progress };
}

export async function verifyPublicationStaging(env: LifecycleControlEnv, operation: PublicationOperation,
  options: { publishedCandidate?: EpisodeRevision } = {}): Promise<PublicationRequest> {
  const { frozen } = await requireOwnedPublication(env, operation);
  const expected = new Map<StageAsset, { sha256: string; length?: number }>();
  if (frozen.commit.kind === "show") {
    expected.set("show_metadata", { sha256: frozen.commit.metadata_sha256 });
    expected.set(`cover_${frozen.commit.cover_extension}`, { sha256: frozen.commit.cover_sha256 });
  } else {
    if (frozen.commit.metadata_sha256) expected.set("episode_metadata", { sha256: frozen.commit.metadata_sha256 });
    if (frozen.commit.audio_sha256) expected.set("audio", { sha256: frozen.commit.audio_sha256, length: frozen.commit.audio_length_bytes });
    const currentObject = await env.CASTLOOP_BUCKET.get(`public/episodes/${operation.showId}/${frozen.commit.episode_id}/metadata.toml`);
    if (currentObject && (currentObject.size < 1 || currentObject.size > 1_000_000)) throw new Error("Published Episode snapshot is oversized");
    const current = currentObject ? parseEpisodeRevision(await currentObject.text()) : null;
    const lifecycle = await readEpisodeLifecycle(env, operation.showId, frozen.commit.episode_id);
    const candidate = options.publishedCandidate ? episodeRevisionSchema.parse(options.publishedCandidate) : null;
    const ownCurrent = candidate && candidate.revision_id === operation.jobId && candidate.episode_id === frozen.commit.episode_id &&
      JSON.stringify(current) === JSON.stringify(candidate);
    if (!ownCurrent && (frozen.commit.base_revision_id ? current?.revision_id !== frozen.commit.base_revision_id || lifecycle?.lifecycle !== "active" :
      current !== null || lifecycle?.lifecycle !== "draft")) throw new Error("Publication base revision no longer matches its Episode");
    if (current?.episode_id !== undefined && current.episode_id !== frozen.commit.episode_id) throw new Error("Published Episode snapshot targets another Episode");
    if (current) {
      const history = await env.CASTLOOP_BUCKET.get(`public/episodes/${operation.showId}/${frozen.commit.episode_id}/revisions/${current.revision_id}.toml`);
      if (!history || history.size < 1 || history.size > 1_000_000 || JSON.stringify(parseEpisodeRevision(await history.text())) !== JSON.stringify(current)) {
        throw new Error("Publication base revision history is missing or inconsistent");
      }
      if (!frozen.commit.audio_sha256) {
        const asset = parsePublicAssetPath(new URL(canonicalEnclosureUrl(current, operation.showId, "https://publication-validation.invalid")).pathname);
        if (asset?.kind !== "audio" || asset.showId !== operation.showId || asset.episodeId !== frozen.commit.episode_id) {
          throw new Error("Publication base revision has an invalid immutable audio reference");
        }
        const audio = await env.CASTLOOP_BUCKET.head(asset.key);
        if (!audio || audio.size !== current.length_bytes || audio.customMetadata?.sha256 !== current.sha256) {
          throw new Error("Publication base audio is missing or inconsistent");
        }
      }
    }
  }
  const checked = new Set<StageAsset>();
  for (const operationId of frozen.staged_uploads) {
    const proof = await readStagedProof(env, frozen, operationId);
    for (const payload of proof.request.payloads) {
      const wanted = expected.get(payload.asset);
      const verified = proof.progress.verified_assets.find((asset) => asset.asset === payload.asset);
      if (!wanted || checked.has(payload.asset) || wanted.sha256 !== payload.sha256 || wanted.length !== undefined && wanted.length !== payload.length_bytes ||
        !verified || verified.sha256 !== payload.sha256 || verified.length_bytes !== payload.length_bytes) {
        throw new Error("Publication payload does not match its staging verification evidence");
      }
      const head = await env.CASTLOOP_BUCKET.head(stagePayloadKey(proof.request, payload.asset));
      if (!head || head.etag !== verified.etag || head.size !== verified.length_bytes) throw new Error("Staged payload changed after verification");
      checked.add(payload.asset);
    }
  }
  if (checked.size !== expected.size) throw new Error("Publication staging verification is incomplete");
  await requireOwnedPublication(env, operation);
  return frozen;
}

export async function claimPublicationOperation(env: LifecycleControlEnv, input: unknown): Promise<PublicationOperation> {
  const frozen = publicationRequestSchema.parse(input);
  const markerKey = publicationCommitKey(frozen.commit);
  if (await env.CASTLOOP_BUCKET.head(markerKey)) {
    const previous = await readFrozenPublicationCommit(env, markerKey);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(frozen)) throw new InvalidFrozenPublication();
  }
  const key = `system/jobs/${frozen.request.job_id}/publication.json`;
  const written = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(frozen), { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (!written && JSON.stringify(await readFrozenRequest(env, frozen.request.job_id)) !== JSON.stringify(frozen)) {
    throw new Error("Publication job ID already has a different frozen manifest");
  }
  await claimShowOperation(env, frozen.request);
  const operation = { showId: frozen.request.show_id, jobId: frozen.request.job_id, generation: frozen.request.expected_show_generation + 1 };
  await requireOwnedPublication(env, operation);
  return operation;
}

export async function commitOwnedPublication(env: LifecycleControlEnv, operation: PublicationOperation): Promise<{ key: string; created: boolean }> {
  const snapshot = await requireOwnedPublication(env, operation);
  const key = publicationCommitKey(snapshot.frozen.commit);
  const existing = await readFrozenPublicationCommit(env, key);
  if (existing) return { key, created: false };
  if (snapshot.control.value.owner.state !== "reserved" || snapshot.control.value.owner.execution_id) {
    throw new Error("Only unstarted publication admission can create its commit marker");
  }
  const frozen = await verifyPublicationStaging(env, operation);
  const latest = await requireOwnedPublication(env, operation);
  if (latest.control.value.owner.state !== "reserved" || latest.control.value.owner.execution_id) throw new Error("Publication started before its commit marker");
  const written = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(frozen.commit), { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (written) return { key, created: true };
  const raced = await readFrozenPublicationCommit(env, key);
  if (!raced || JSON.stringify(raced) !== JSON.stringify(frozen)) throw new InvalidFrozenPublication();
  return { key, created: false };
}
