import { episodeDraftFromRevision, episodeRevisionSchema, lifecycleFailureForPhase, lifecycleJobStatusSchema, lifecycleProgressSchema,
  parseEpisodeDraft, parseEpisodeLifecycle, parseEpisodeRevision, parseServiceConfig, parseShowMetadata, stringifyLifecycleToml,
  sameEpisodeIdentity, stringifyToml } from "../packages/shared/src/index";
import type { EpisodeCommit, EpisodeRevision, LifecycleProgress } from "../packages/shared/src/index";
import { finishShowOperation, readShowControl, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { readLifecycleFeedInputs } from "./lifecycle-feed";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { readLifecycleJobJournal, writeLifecycleJobStatus, writeLifecycleProgress } from "./lifecycle-job-store";
import { advanceLifecycleFeedGeneration } from "./lifecycle-mutations";
import { canonicalEnclosureUrl } from "./media-url";
import { publicationCommitKey, readFrozenPublicationCommit, requireOwnedPublication, verifyPublicationStaging } from "./publication-admission";
import { matchesPublishedAudio, publicationChecksum, readPublicationBytes, renderPublicationFeed } from "./publication-inputs";
import type { PublicationEffects } from "./publication-inputs";
import { measureWorkerPhase } from "./worker-timing";
import { ensureEpisodeCatalog } from "./episode-catalog";
import { parsePublicationInput, PublicationValidationFailure } from "./publication-validation";

function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

async function uniqueGuid(env: LifecycleFeedEnv, execution: ShowExecution, revision: EpisodeRevision,
  base: EpisodeRevision | null): Promise<void> {
  const catalog = await ensureEpisodeCatalog(env, execution);
  const previous = catalog.value.entries.find((entry) => entry.revision.episode_id === revision.episode_id)?.revision;
  if (base && JSON.stringify(previous) !== JSON.stringify(base) &&
    !(catalog.value.applied_job_id === execution.jobId && JSON.stringify(previous) === JSON.stringify(revision))) {
    throw new Error("Episode catalog no longer matches its immutable base revision");
  }
  if (catalog.value.entries.some((entry) => entry.revision.episode_id !== revision.episode_id && entry.revision.guid === revision.guid)) {
    throw new PublicationValidationFailure();
  }
  await requireShowExecution(env, execution);
}

async function persistAudio(env: LifecycleFeedEnv, execution: ShowExecution, commit: EpisodeCommit): Promise<void> {
  if (!commit.audio_sha256 || !commit.audio_length_bytes) return;
  const sha256 = commit.audio_sha256;
  const key = `public/podcasts/${execution.showId}/episodes/${commit.episode_id}/${execution.jobId}.mp3`;
  await measureWorkerPhase(execution.jobId, "publication.audio_owner", () => requireShowExecution(env, execution));
  if (!await measureWorkerPhase(execution.jobId, "publication.audio_target_head", () => env.CASTLOOP_BUCKET.head(key))) {
    const sourceKey = `staging/episodes/${execution.showId}/${commit.episode_id}/${execution.jobId}/audio.mp3`;
    const source = await measureWorkerPhase(execution.jobId, "publication.audio_source_head", () => env.CASTLOOP_BUCKET.head(sourceKey));
    if (!source || source.size !== commit.audio_length_bytes) throw new Error("Episode staging audio has an unexpected size");
    const object = await measureWorkerPhase(execution.jobId, "publication.audio_source_get", () =>
      env.CASTLOOP_BUCKET.get(sourceKey, { onlyIf: { etagMatches: source.etag } }));
    try {
      if (!object || !("body" in object) || !object.body || object.etag !== source.etag || object.version !== source.version || object.size !== source.size) {
        throw new Error("Episode staging audio changed before streaming");
      }
      const body = object.body;
      await measureWorkerPhase(execution.jobId, "publication.audio_owner", () => requireShowExecution(env, execution));
      await measureWorkerPhase(execution.jobId, "publication.audio_put", () => env.CASTLOOP_BUCKET.put(key, body, {
        onlyIf: new Headers({ "If-None-Match": "*" }), sha256,
        httpMetadata: { contentType: "audio/mpeg" }, customMetadata: { sha256 },
      }));
    } finally {
      if (object && "body" in object && object.body && !object.body.locked) {
        const body = object.body;
        await measureWorkerPhase(execution.jobId, "publication.body_cancel", () => body.cancel());
      }
    }
  }
  const head = await measureWorkerPhase(execution.jobId, "publication.audio_verify_head", () => env.CASTLOOP_BUCKET.head(key));
  if (!matchesPublishedAudio(head, commit.audio_length_bytes, commit.audio_sha256)) {
    throw new Error("Immutable published audio is missing or inconsistent");
  }
  await measureWorkerPhase(execution.jobId, "publication.audio_recheck", () => requireShowExecution(env, execution));
}

export async function runOwnedEpisodePublication(env: LifecycleFeedEnv, execution: ShowExecution,
  effects: PublicationEffects): Promise<void | "failed"> {
  const existing = await measureWorkerPhase(execution.jobId, "publication.runner_control", () => readShowControl(env, execution.showId));
  const receipt = existing?.value.last_finished_operation;
  if (receipt?.job_id === execution.jobId && receipt.generation === execution.generation && receipt.execution_id === execution.executionId) {
    await measureWorkerPhase(execution.jobId, "publication.owner_release", () => finishShowOperation(env, execution));
    return;
  }
  const owned = await measureWorkerPhase(execution.jobId, "publication.runner_manifest", () =>
    requireOwnedPublication(env, execution, { allowPublishedResult: true }));
  if (owned.frozen.commit.kind !== "episode") throw new Error("Episode publication requires an Episode commit");
  const marker = await measureWorkerPhase(execution.jobId, "publication.frozen_commit", () =>
    readFrozenPublicationCommit(env, publicationCommitKey(owned.frozen.commit)));
  if (!marker || JSON.stringify(marker) !== JSON.stringify(owned.frozen)) throw new Error("Episode publication has no matching frozen commit");
  const commit = owned.frozen.commit;
  const journal = await measureWorkerPhase(execution.jobId, "publication.journal_read", () => readLifecycleJobJournal(env, execution));
  if (journal.status?.state === "failed") return "failed";
  const canRejectInputs = !journal.progress || ["admitted", "validating"].includes(journal.progress.phase);
  let progress = journal.progress ?? lifecycleProgressSchema.parse({ schema_version: 1, ...journal.identity, phase: "admitted",
    deleted_objects: 0, purge_confirmed: false, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
  if (journal.status?.state === "published") {
    await measureWorkerPhase(execution.jobId, "publication.owner_release", () => finishShowOperation(env, execution));
    return;
  }
  if (journal.status?.state === "completed" || journal.status?.state === "abandoned") throw new Error("Episode publication status is incompatible");
  if (!["admitted", "validating", "feed", "purge", "visibility", "finished"].includes(progress.phase) ||
    progress.purge_confirmed !== ["visibility", "finished"].includes(progress.phase)) throw new Error("Episode publication progress is incompatible");
  const target = { showId: execution.showId, episodeId: commit.episode_id };
  let failurePhase = progress.phase;
  async function guard(): Promise<void> {
    await measureWorkerPhase(execution.jobId, "publication.guard", async () => {
      const current = await measureWorkerPhase(execution.jobId, "publication.guard_owner", () =>
        requireOwnedPublication(env, execution, { allowPublishedResult: true }));
      if (current.control.value.owner.state !== "processing" || current.control.value.owner.execution_id !== execution.executionId) {
        throw new Error("Invocation no longer owns the execution token");
      }
      await measureWorkerPhase(execution.jobId, "publication.guard_delivery", () => effects.checkDeliveryGate(target));
      await measureWorkerPhase(execution.jobId, "publication.guard_recheck", () => requireShowExecution(env, execution));
    });
  }
  async function recordProgress(phase: LifecycleProgress["phase"], purged = false): Promise<void> {
    const next = lifecycleProgressSchema.parse({ ...progress, phase, purge_confirmed: purged,
      updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    await measureWorkerPhase(execution.jobId, `publication.progress.${phase}`, () => writeLifecycleProgress(env, execution, next));
    progress = next;
  }
  async function recordStatus(state: "processing" | "retrying" | "failed" | "published"): Promise<void> {
    await measureWorkerPhase(execution.jobId, `publication.status_write.${state}`, () => writeLifecycleJobStatus(env, execution, lifecycleJobStatusSchema.parse({ schema_version: 2, ...journal.identity,
      state, phase: progress.phase, ...(state === "published" ? { result_lifecycle: "active" } : {}),
      ...(state === "retrying" || state === "failed" ? lifecycleFailureForPhase(failurePhase) : {}) })));
  }
  try {
    await guard();
    if (["admitted", "validating", "feed"].includes(progress.phase)) {
      failurePhase = "validating";
      if (progress.phase !== "feed") await recordProgress("validating");
      await recordStatus("processing");
      const { prefix, base, show, service, extension, revision } = await measureWorkerPhase(execution.jobId, "publication.snapshots", async () => {
        const prefix = `public/episodes/${execution.showId}/${commit.episode_id}`;
        const base = commit.base_revision_id ? parseEpisodeRevision(text(await readPublicationBytes(env,
          `${prefix}/revisions/${commit.base_revision_id}.toml`, 1_000_000))) : null;
        if (base && (base.revision_id !== commit.base_revision_id || base.episode_id !== commit.episode_id)) throw new Error("Episode base revision targets another snapshot");
        let draft = base ? episodeDraftFromRevision(base) : null;
        if (commit.metadata_sha256) {
          const bytes = await readPublicationBytes(env, `staging/episodes/${execution.showId}/${commit.episode_id}/${execution.jobId}/episode.toml`, 1_000_000);
          if (await publicationChecksum(bytes) !== commit.metadata_sha256) throw new PublicationValidationFailure();
          draft = parsePublicationInput(() => parseEpisodeDraft(text(bytes)));
        }
        if (!draft || draft.episode_id !== commit.episode_id || base && !sameEpisodeIdentity(draft, base)) {
          throw new PublicationValidationFailure();
        }
        const show = parseShowMetadata(text(await readPublicationBytes(env, `system/shows/${execution.showId}/show.toml`, 1_000_000)));
        const service = parseServiceConfig(text(await readPublicationBytes(env, "system/service.toml", 16384)));
        if (show.show_id !== execution.showId) throw new Error("Episode publication targets another Show snapshot");
        const extension: "jpg" | "png" = show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
        const cover = await env.CASTLOOP_BUCKET.head(`public/podcasts/${execution.showId}/cover.${extension}`);
        if (!cover || cover.size < 1 || cover.size > 5_000_000) throw new Error("Published Show cover is missing or oversized");
        const revision = episodeRevisionSchema.parse({ ...draft, revision_id: execution.jobId,
          enclosure_url: commit.audio_sha256 ? `${service.public_base_url.replace(/\/$/, "")}/podcasts/${execution.showId}/episodes/${commit.episode_id}/${execution.jobId}.mp3` :
            canonicalEnclosureUrl(base!, execution.showId, service.public_base_url), content_type: "audio/mpeg",
          length_bytes: commit.audio_length_bytes ?? base!.length_bytes, duration_seconds: commit.duration_seconds ?? base!.duration_seconds,
          sha256: commit.audio_sha256 ?? base!.sha256, updated_at: commit.committed_at });
        return { prefix, base, show, service, extension, revision };
      });
      await measureWorkerPhase(execution.jobId, "publication.verify_staging", () => verifyPublicationStaging(env, execution, { publishedCandidate: revision }));
      await measureWorkerPhase(execution.jobId, "publication.unique_guid", () => uniqueGuid(env, execution, revision, base));
      failurePhase = "feed";
      await recordProgress("feed");
      await guard();
      await measureWorkerPhase(execution.jobId, "publication.audio", () => persistAudio(env, execution, commit));
      const inputs = await measureWorkerPhase(execution.jobId, "publication.feed_inputs", () => readLifecycleFeedInputs(env, execution, { candidate: revision }));
      if (!inputs.writeFeed) throw new Error("Episode lifecycle does not permit publication feed writing");
      const feed = renderPublicationFeed(show, inputs.episodes, service.public_base_url, extension);
      const historyKey = `${prefix}/revisions/${execution.jobId}.toml`;
      await guard();
      const history = await measureWorkerPhase(execution.jobId, "publication.history_write", () =>
        env.CASTLOOP_BUCKET.put(historyKey, stringifyToml(revision), { onlyIf: new Headers({ "If-None-Match": "*" }) }));
      if (!history && JSON.stringify(parseEpisodeRevision(text(await readPublicationBytes(env, historyKey, 1_000_000)))) !== JSON.stringify(revision)) {
        throw new Error("Immutable Episode revision already contains different metadata");
      }
      for (const [key, data, contentType] of [[`${prefix}/metadata.toml`, stringifyToml(revision), undefined],
        [`public/podcasts/${execution.showId}/feed.xml`, feed, "application/rss+xml; charset=utf-8"]] as const) {
        await guard();
        const previous = await env.CASTLOOP_BUCKET.head(key);
        await requireShowExecution(env, execution);
        const written = await measureWorkerPhase(execution.jobId, contentType ? "publication.feed_write" : "publication.metadata_write", () => env.CASTLOOP_BUCKET.put(key, data, {
          onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ "If-None-Match": "*" }),
          ...(contentType ? { httpMetadata: { contentType } } : {}),
        }));
        if (!written) throw new Error("Episode publication output changed before writing");
      }
      await measureWorkerPhase(execution.jobId, "publication.feed_generation", () => advanceLifecycleFeedGeneration(env, execution));
      await recordProgress("purge");
    }
    if (progress.phase === "purge") {
      failurePhase = "purge";
      await recordStatus("processing");
      await guard();
      await measureWorkerPhase(execution.jobId, "publication.purge", () => effects.purge(target));
      await guard();
      await recordProgress("visibility", true);
    }
    if (progress.phase === "visibility") {
      failurePhase = "visibility";
      await guard();
      await measureWorkerPhase(execution.jobId, "publication.visibility", async () => {
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
      });
      await recordProgress("finished", true);
    }
    if (progress.phase !== "finished") throw new Error("Episode publication cannot finish from its current phase");
    failurePhase = "finished";
    await recordStatus("published");
    await measureWorkerPhase(execution.jobId, "publication.owner_release", () => finishShowOperation(env, execution));
  } catch (error) {
    let rejected = false;
    await measureWorkerPhase(execution.jobId, "publication.failure_record", async () => {
      const current = await readShowControl(env, execution.showId);
      if (current?.value.last_finished_operation?.job_id === execution.jobId && current.value.last_finished_operation.generation === execution.generation &&
        current.value.last_finished_operation.execution_id === execution.executionId) return;
      const saved = await readLifecycleJobJournal(env, execution);
      if (saved.status?.state !== "published" && saved.progress?.phase !== "finished") {
        progress = saved.progress ?? progress;
        rejected = canRejectInputs && error instanceof PublicationValidationFailure &&
          ["admitted", "validating"].includes(progress.phase);
        await recordStatus(rejected ? "failed" : "retrying");
      }
    });
    if (rejected) return "failed";
    throw error;
  }
}
