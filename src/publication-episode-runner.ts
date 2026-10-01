import { episodeDraftFromRevision, episodeRevisionSchema, lifecycleFailureForPhase, lifecycleJobStatusSchema, lifecycleProgressSchema,
  parseEpisodeDraft, parseEpisodeLifecycle, parseEpisodeRevision, parseServiceConfig, parseShowMetadata, stringifyLifecycleToml,
  stringifyToml, validateId } from "../packages/shared/src/index";
import type { EpisodeCommit, EpisodeRevision, LifecycleProgress } from "../packages/shared/src/index";
import { finishShowOperation, readShowControl, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { readLifecycleFeedInputs } from "./lifecycle-feed";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { readLifecycleJobJournal, writeLifecycleJobStatus, writeLifecycleProgress } from "./lifecycle-job-store";
import { advanceLifecycleFeedGeneration } from "./lifecycle-mutations";
import { canonicalEnclosureUrl } from "./media-url";
import { publicationCommitKey, readFrozenPublicationCommit, requireOwnedPublication, verifyPublicationStaging } from "./publication-admission";
import { publicationChecksum, readPublicationBytes, renderPublicationFeed } from "./publication-inputs";
import type { PublicationEffects } from "./publication-inputs";
import { digestStageStream } from "./staging-verification";
import type { StageStreamDigest } from "./staging-verification";

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

async function uniqueGuid(env: LifecycleFeedEnv, execution: ShowExecution, revision: EpisodeRevision): Promise<void> {
  const prefix = `public/episodes/${execution.showId}/`;
  const cursors = new Set<string>();
  const keys = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  do {
    const page = await env.CASTLOOP_BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) {
      if (!object.key.startsWith(prefix) || keys.has(object.key) || keys.size >= 10000) throw new Error("Episode GUID inventory is inconsistent or oversized");
      keys.add(object.key);
      const parts = object.key.slice(prefix.length).split("/");
      if (parts.at(-1) !== "metadata.toml") continue;
      if (parts.length !== 2) throw new Error("Invalid current Episode metadata key");
      const episodeId = validateId(parts[0], "episode");
      bytes += object.size;
      if (object.size < 1 || object.size > 1_000_000 || bytes > 8_000_000) throw new Error("Episode GUID inventory exceeds its metadata budget");
      const metadata = await env.CASTLOOP_BUCKET.get(object.key, { onlyIf: { etagMatches: object.etag } });
      if (!metadata || !("body" in metadata) || !metadata.body || metadata.etag !== object.etag || metadata.size !== object.size) {
        throw new Error("Episode GUID inventory changed during validation");
      }
      const current = parseEpisodeRevision(await metadata.text());
      if (current.episode_id !== episodeId) throw new Error("Episode GUID inventory targets another Episode");
      if (episodeId !== revision.episode_id && current.guid === revision.guid) throw new Error("Episode GUID is already used by another Episode");
    }
    await requireShowExecution(env, execution);
    if (!page.truncated) break;
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("Episode GUID inventory cursor did not advance");
    cursors.add(page.cursor);
    cursor = page.cursor;
  } while (true);
}

async function persistAudio(env: LifecycleFeedEnv, execution: ShowExecution, commit: EpisodeCommit,
  digest: StageStreamDigest): Promise<void> {
  if (!commit.audio_sha256 || !commit.audio_length_bytes) return;
  const key = `public/podcasts/${execution.showId}/episodes/${commit.episode_id}/${execution.jobId}.mp3`;
  await requireShowExecution(env, execution);
  if (!await env.CASTLOOP_BUCKET.head(key)) {
    const sourceKey = `staging/episodes/${execution.showId}/${commit.episode_id}/${execution.jobId}/audio.mp3`;
    const source = await env.CASTLOOP_BUCKET.head(sourceKey);
    if (!source || source.size !== commit.audio_length_bytes) throw new Error("Episode staging audio has an unexpected size");
    const object = await env.CASTLOOP_BUCKET.get(sourceKey, { onlyIf: { etagMatches: source.etag } });
    if (!object || !("body" in object) || !object.body || object.etag !== source.etag || object.size !== source.size) {
      throw new Error("Episode staging audio changed before streaming");
    }
    await requireShowExecution(env, execution);
    await env.CASTLOOP_BUCKET.put(key, object.body, { onlyIf: new Headers({ "If-None-Match": "*" }), sha256: commit.audio_sha256,
      httpMetadata: { contentType: "audio/mpeg" }, customMetadata: { sha256: commit.audio_sha256 } });
  }
  const head = await env.CASTLOOP_BUCKET.head(key);
  if (!head || head.size !== commit.audio_length_bytes || head.customMetadata?.sha256 !== commit.audio_sha256) {
    throw new Error("Immutable published audio is missing or inconsistent");
  }
  const object = await env.CASTLOOP_BUCKET.get(key, { onlyIf: { etagMatches: head.etag } });
  if (!object || !("body" in object) || !object.body || object.etag !== head.etag || object.size !== head.size) {
    throw new Error("Immutable published audio changed before verification");
  }
  if (await digest(object.body, commit.audio_length_bytes) !== commit.audio_sha256) throw new Error("Immutable published audio checksum does not match its commit");
  const latest = await env.CASTLOOP_BUCKET.head(key);
  if (!latest || latest.etag !== head.etag || latest.size !== head.size) throw new Error("Immutable published audio changed during verification");
  await requireShowExecution(env, execution);
}

export async function runOwnedEpisodePublication(env: LifecycleFeedEnv, execution: ShowExecution,
  effects: PublicationEffects, options: { digest?: StageStreamDigest } = {}): Promise<void> {
  const existing = await readShowControl(env, execution.showId);
  const receipt = existing?.value.last_finished_operation;
  if (receipt?.job_id === execution.jobId && receipt.generation === execution.generation && receipt.execution_id === execution.executionId) {
    await finishShowOperation(env, execution);
    return;
  }
  const owned = await requireOwnedPublication(env, execution, { allowPublishedResult: true });
  if (owned.frozen.commit.kind !== "episode") throw new Error("Episode publication requires an Episode commit");
  const marker = await readFrozenPublicationCommit(env, publicationCommitKey(owned.frozen.commit));
  if (!marker || JSON.stringify(marker) !== JSON.stringify(owned.frozen)) throw new Error("Episode publication has no matching frozen commit");
  const commit = owned.frozen.commit;
  const journal = await readLifecycleJobJournal(env, execution);
  let progress = journal.progress ?? lifecycleProgressSchema.parse({ schema_version: 1, ...journal.identity, phase: "admitted",
    deleted_objects: 0, purge_confirmed: false, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
  if (journal.status?.state === "published") { await finishShowOperation(env, execution); return; }
  if (journal.status?.state === "completed" || journal.status?.state === "abandoned") throw new Error("Episode publication status is incompatible");
  if (!["admitted", "validating", "feed", "purge", "visibility", "finished"].includes(progress.phase) ||
    progress.purge_confirmed !== ["visibility", "finished"].includes(progress.phase)) throw new Error("Episode publication progress is incompatible");
  const target = { showId: execution.showId, episodeId: commit.episode_id };
  let failurePhase = progress.phase;
  async function guard(): Promise<void> {
    await requireShowExecution(env, execution);
    await requireOwnedPublication(env, execution, { allowPublishedResult: true });
    await effects.checkDeliveryGate(target);
    await requireShowExecution(env, execution);
  }
  async function recordProgress(phase: LifecycleProgress["phase"], purged = false): Promise<void> {
    const next = lifecycleProgressSchema.parse({ ...progress, phase, purge_confirmed: purged,
      updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    await writeLifecycleProgress(env, execution, next);
    progress = next;
  }
  async function recordStatus(state: "processing" | "retrying" | "published"): Promise<void> {
    await writeLifecycleJobStatus(env, execution, lifecycleJobStatusSchema.parse({ schema_version: 2, ...journal.identity,
      state, phase: progress.phase, ...(state === "published" ? { result_lifecycle: "active" } : {}),
      ...(state === "retrying" ? lifecycleFailureForPhase(failurePhase) : {}) }));
  }
  try {
    await guard();
    if (["admitted", "validating", "feed"].includes(progress.phase)) {
      failurePhase = "validating";
      if (progress.phase !== "feed") await recordProgress("validating");
      await recordStatus("processing");
      const prefix = `public/episodes/${execution.showId}/${commit.episode_id}`;
      const base = commit.base_revision_id ? parseEpisodeRevision(text(await readPublicationBytes(env,
        `${prefix}/revisions/${commit.base_revision_id}.toml`, 1_000_000))) : null;
      if (base && (base.revision_id !== commit.base_revision_id || base.episode_id !== commit.episode_id)) throw new Error("Episode base revision targets another snapshot");
      let draft = base ? episodeDraftFromRevision(base) : null;
      if (commit.metadata_sha256) {
        const bytes = await readPublicationBytes(env, `staging/episodes/${execution.showId}/${commit.episode_id}/${execution.jobId}/episode.toml`, 1_000_000);
        if (await publicationChecksum(bytes) !== commit.metadata_sha256) throw new Error("Episode metadata differs from its frozen commit");
        draft = parseEpisodeDraft(text(bytes));
      }
      if (!draft || draft.episode_id !== commit.episode_id || base && (draft.guid !== base.guid || draft.published_at !== base.published_at)) {
        throw new Error("Episode identity and publication date must remain unchanged");
      }
      const show = parseShowMetadata(text(await readPublicationBytes(env, `system/shows/${execution.showId}/show.toml`, 1_000_000)));
      const service = parseServiceConfig(text(await readPublicationBytes(env, "system/service.toml", 16384)));
      if (show.show_id !== execution.showId) throw new Error("Episode publication targets another Show snapshot");
      const extension = show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
      const cover = await env.CASTLOOP_BUCKET.head(`public/podcasts/${execution.showId}/cover.${extension}`);
      if (!cover || cover.size < 1 || cover.size > 5_000_000) throw new Error("Published Show cover is missing or oversized");
      const revision = episodeRevisionSchema.parse({ ...draft, revision_id: execution.jobId,
        enclosure_url: commit.audio_sha256 ? `${service.public_base_url.replace(/\/$/, "")}/podcasts/${execution.showId}/episodes/${commit.episode_id}/${execution.jobId}.mp3` :
          canonicalEnclosureUrl(base!, execution.showId, service.public_base_url), content_type: "audio/mpeg",
        length_bytes: commit.audio_length_bytes ?? base!.length_bytes, duration_seconds: commit.duration_seconds ?? base!.duration_seconds,
        sha256: commit.audio_sha256 ?? base!.sha256, updated_at: commit.committed_at });
      await verifyPublicationStaging(env, execution, { publishedCandidate: revision });
      await uniqueGuid(env, execution, revision);
      failurePhase = "feed";
      await recordProgress("feed");
      await guard();
      await persistAudio(env, execution, commit, options.digest ?? digestStageStream);
      const inputs = await readLifecycleFeedInputs(env, execution, { candidate: revision });
      if (!inputs.writeFeed) throw new Error("Episode lifecycle does not permit publication feed writing");
      const feed = renderPublicationFeed(show, inputs.episodes, service.public_base_url, extension);
      const historyKey = `${prefix}/revisions/${execution.jobId}.toml`;
      await guard();
      const history = await env.CASTLOOP_BUCKET.put(historyKey, stringifyToml(revision), { onlyIf: new Headers({ "If-None-Match": "*" }) });
      if (!history && JSON.stringify(parseEpisodeRevision(text(await readPublicationBytes(env, historyKey, 1_000_000)))) !== JSON.stringify(revision)) {
        throw new Error("Immutable Episode revision already contains different metadata");
      }
      for (const [key, data, contentType] of [[`${prefix}/metadata.toml`, stringifyToml(revision), undefined],
        [`public/podcasts/${execution.showId}/feed.xml`, feed, "application/rss+xml; charset=utf-8"]] as const) {
        await guard();
        const previous = await env.CASTLOOP_BUCKET.head(key);
        await requireShowExecution(env, execution);
        const written = await env.CASTLOOP_BUCKET.put(key, data, {
          onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ "If-None-Match": "*" }),
          ...(contentType ? { httpMetadata: { contentType } } : {}),
        });
        if (!written) throw new Error("Episode publication output changed before writing");
      }
      await advanceLifecycleFeedGeneration(env, execution);
      await recordProgress("purge");
    }
    if (progress.phase === "purge") {
      failurePhase = "purge";
      await recordStatus("processing");
      await guard();
      await effects.purge(target);
      await guard();
      await recordProgress("visibility", true);
    }
    if (progress.phase === "visibility") {
      failurePhase = "visibility";
      await guard();
      const key = `system/episode-lifecycle/${execution.showId}/${commit.episode_id}.toml`;
      const object = await env.CASTLOOP_BUCKET.get(key);
      if (!object || object.size > 16384) throw new Error("Episode lifecycle is missing or oversized");
      const episode = parseEpisodeLifecycle(await object.text());
      const expected = owned.frozen.request.expected_episode_generation!;
      if (!(episode.lifecycle === "active" && episode.last_job_id === execution.jobId && episode.generation === expected + 1)) {
        if (episode.show_id !== execution.showId || episode.episode_id !== commit.episode_id || !["draft", "active"].includes(episode.lifecycle) ||
          episode.generation !== expected || expected === Number.MAX_SAFE_INTEGER) throw new Error("Episode lifecycle changed before opening publication");
        await requireShowExecution(env, execution);
        const written = await env.CASTLOOP_BUCKET.put(key, stringifyLifecycleToml({ ...episode, lifecycle: "active", generation: expected + 1,
          last_job_id: execution.jobId }), { onlyIf: { etagMatches: object.etag } });
        if (!written) throw new Error("Episode lifecycle changed before opening publication");
      }
      await recordProgress("finished", true);
    }
    if (progress.phase !== "finished") throw new Error("Episode publication cannot finish from its current phase");
    failurePhase = "finished";
    await recordStatus("published");
    await finishShowOperation(env, execution);
  } catch (error) {
    const current = await readShowControl(env, execution.showId);
    if (current?.value.last_finished_operation?.job_id === execution.jobId && current.value.last_finished_operation.generation === execution.generation &&
      current.value.last_finished_operation.execution_id === execution.executionId) throw error;
    const saved = await readLifecycleJobJournal(env, execution);
    if (saved.status?.state !== "published" && saved.progress?.phase !== "finished") { progress = saved.progress ?? progress; await recordStatus("retrying"); }
    throw error;
  }
}
