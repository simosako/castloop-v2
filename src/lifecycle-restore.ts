import { episodeLifecycleSchema, lifecycleFailureForPhase, lifecycleJobStatusSchema, lifecycleProgressSchema,
  parseControlRequest, parseEpisodeLifecycle, parseServiceConfig, parseShowControl, parseShowMetadata,
  stringifyLifecycleToml } from "../packages/shared/src/index";
import type { EpisodeRevision, LifecycleProgress, ServiceConfig, ShowMetadata } from "../packages/shared/src/index";
import { finishShowOperation, readShowControl, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { readLifecycleFeedInputs } from "./lifecycle-feed";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { readLifecycleJobJournal, writeLifecycleJobStatus, writeLifecycleProgress } from "./lifecycle-job-store";
import { advanceLifecycleFeedGeneration } from "./lifecycle-mutations";

export type RestoreFeedSnapshot = {
  show: ShowMetadata;
  service: ServiceConfig;
  coverExtension: "jpg" | "png";
  episodes: EpisodeRevision[];
};
export type RestoreTarget = { showId: string; episodeId?: string };
export type RestoreEffects = {
  writeFeed: (snapshot: RestoreFeedSnapshot) => Promise<void>;
  purge: (target: RestoreTarget) => Promise<void>;
  checkDeliveryGate: (target: RestoreTarget) => Promise<void>;
};

async function readRestoreSnapshot(env: LifecycleFeedEnv, execution: ShowExecution): Promise<RestoreFeedSnapshot> {
  const current = await requireShowExecution(env, execution);
  const owner = current.value.owner!;
  if (owner.action !== "restore" || (owner.kind === "show" ? current.value.lifecycle !== "unpublished" : current.value.lifecycle !== "active")) {
    throw new Error("Restore target or its parent is no longer eligible");
  }
  const [showObject, serviceObject] = await Promise.all([
    env.CASTLOOP_BUCKET.get(`system/shows/${execution.showId}/show.toml`), env.CASTLOOP_BUCKET.get("system/service.toml"),
  ]);
  if (!showObject || !serviceObject || showObject.size < 1 || showObject.size > 1_000_000 ||
    serviceObject.size < 1 || serviceObject.size > 16384) throw new Error("Published Show or service snapshot is missing or oversized");
  const show = parseShowMetadata(await showObject.text());
  const service = parseServiceConfig(await serviceObject.text());
  if (show.show_id !== execution.showId) throw new Error("Published Show snapshot does not match its target");
  const coverExtension = show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
  const cover = await env.CASTLOOP_BUCKET.head(`public/podcasts/${execution.showId}/cover.${coverExtension}`);
  if (!cover || !Number.isSafeInteger(cover.size) || cover.size < 1 || cover.size > 5_000_000) {
    throw new Error("Published cover is missing or has an invalid size");
  }
  const feed = await readLifecycleFeedInputs(env, execution);
  if (!feed.writeFeed) throw new Error("Restore cannot prepare its public feed");
  const latest = await requireShowExecution(env, execution);
  if (latest.etag !== current.etag) throw new Error("Show control changed during restore validation");
  return { show, service, coverExtension, episodes: feed.episodes };
}

async function openRestoredTarget(env: LifecycleFeedEnv, execution: ShowExecution): Promise<void> {
  const journal = await readLifecycleJobJournal(env, execution);
  if (journal.identity.action !== "restore" || journal.progress?.phase !== "visibility" || !journal.progress.purge_confirmed) {
    throw new Error("Opening restored delivery requires durable prepared and purged progress");
  }
  const current = await requireShowExecution(env, execution);
  if (current.value.last_feed_job_id !== execution.jobId) throw new Error("Restore feed generation has not advanced");
  if (journal.identity.kind === "show") {
    if (current.value.lifecycle === "active") return;
    if (current.value.lifecycle !== "unpublished") throw new Error("Show is no longer eligible for restoration");
    const value = parseShowControl({ ...current.value, lifecycle: "active" });
    const written = await env.CASTLOOP_BUCKET.put(`system/show-publications/${execution.showId}.json`, JSON.stringify(value), {
      onlyIf: { etagMatches: current.etag },
    });
    if (!written) throw new Error("Show changed before restoration");
    return;
  }
  if (current.value.lifecycle !== "active") throw new Error("Episode restoration requires an active parent Show");
  const episodeId = journal.identity.episode_id!;
  const key = `system/episode-lifecycle/${execution.showId}/${episodeId}.toml`;
  const [object, frozen] = await Promise.all([env.CASTLOOP_BUCKET.get(key),
    env.CASTLOOP_BUCKET.get(`system/jobs/${execution.jobId}/request.toml`)]);
  if (!object || !frozen || object.size > 16384 || frozen.size > 16384) throw new Error("Restore records are missing or oversized");
  const episode = parseEpisodeLifecycle(await object.text());
  const request = parseControlRequest(await frozen.text());
  if (episode.show_id !== execution.showId || episode.episode_id !== episodeId) throw new Error("Episode restore target does not match its key");
  if (episode.lifecycle === "active" && episode.last_job_id === execution.jobId &&
    episode.generation === request.expected_episode_generation! + 1) return;
  if (episode.lifecycle !== "unpublished" || episode.generation !== request.expected_episode_generation ||
    episode.generation === Number.MAX_SAFE_INTEGER) throw new Error("Episode changed before restoration");
  const value = episodeLifecycleSchema.parse({ ...episode, lifecycle: "active", generation: episode.generation + 1,
    last_job_id: execution.jobId });
  await requireShowExecution(env, execution);
  const written = await env.CASTLOOP_BUCKET.put(key, stringifyLifecycleToml(value), { onlyIf: { etagMatches: object.etag } });
  if (!written) throw new Error("Episode changed before its restoration was saved");
}

export async function runLifecycleRestore(env: LifecycleFeedEnv, execution: ShowExecution, effects: RestoreEffects): Promise<void> {
  const existing = await readShowControl(env, execution.showId);
  const receipt = existing?.value.last_finished_operation;
  if (receipt?.job_id === execution.jobId && receipt.generation === execution.generation && receipt.execution_id === execution.executionId) {
    await finishShowOperation(env, execution);
    return;
  }
  const { identity, status, progress: savedProgress } = await readLifecycleJobJournal(env, execution);
  if (identity.action !== "restore") throw new Error("Restore runner requires a restore owner");
  const target: RestoreTarget = { showId: execution.showId, ...(identity.episode_id ? { episodeId: identity.episode_id } : {}) };
  let progress = savedProgress ?? lifecycleProgressSchema.parse({ schema_version: 1, ...identity, phase: "admitted",
    deleted_objects: 0, purge_confirmed: false, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
  if (progress.deleted_objects !== 0 || !["admitted", "validating", "feed", "purge", "visibility", "finished"].includes(progress.phase) ||
    progress.purge_confirmed !== (progress.phase === "visibility" || progress.phase === "finished")) {
    throw new Error("Restore progress does not match its operation");
  }
  if (status?.state === "completed") {
    await finishShowOperation(env, execution);
    return;
  }
  if (status?.state === "abandoned" || status?.state === "published") throw new Error("Restore status is incompatible");
  let failurePhase = progress.phase;
  async function recordProgress(phase: LifecycleProgress["phase"], purged = false): Promise<void> {
    const value = lifecycleProgressSchema.parse({ ...progress, phase, purge_confirmed: purged,
      updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    await writeLifecycleProgress(env, execution, value);
    progress = value;
  }
  async function recordStatus(state: "processing" | "retrying" | "completed"): Promise<void> {
    const value = lifecycleJobStatusSchema.parse({ schema_version: 2, ...identity, state, phase: progress.phase,
      ...(state === "completed" ? { result_lifecycle: "active" } : {}),
      ...(state === "retrying" ? lifecycleFailureForPhase(failurePhase) : {}) });
    await writeLifecycleJobStatus(env, execution, value);
  }
  try {
    if (["admitted", "validating", "feed"].includes(progress.phase)) {
      failurePhase = "validating";
      await recordProgress("validating");
      await recordStatus("processing");
      await effects.checkDeliveryGate(target);
      const snapshot = await readRestoreSnapshot(env, execution);
      failurePhase = "feed";
      await recordProgress("feed");
      await effects.writeFeed(snapshot);
      await advanceLifecycleFeedGeneration(env, execution);
      await recordProgress("purge");
    }
    if (progress.phase === "purge") {
      failurePhase = "purge";
      await recordStatus("processing");
      await effects.checkDeliveryGate(target);
      await requireShowExecution(env, execution);
      await effects.purge(target);
      await recordProgress("visibility", true);
    }
    if (progress.phase === "visibility") {
      failurePhase = "visibility";
      await recordStatus("processing");
      await effects.checkDeliveryGate(target);
      await openRestoredTarget(env, execution);
      await recordProgress("finished", true);
    }
    failurePhase = "finished";
    await recordStatus("completed");
    await finishShowOperation(env, execution);
  } catch (error) {
    const current = await readShowControl(env, execution.showId);
    if (current?.value.last_finished_operation?.job_id === execution.jobId &&
      current.value.last_finished_operation.generation === execution.generation &&
      current.value.last_finished_operation.execution_id === execution.executionId) throw error;
    const saved = await readLifecycleJobJournal(env, execution);
    if (saved.status?.state !== "completed" && saved.progress?.phase !== "finished") {
      progress = saved.progress ?? progress;
      await recordStatus("retrying");
    }
    throw error;
  }
}
