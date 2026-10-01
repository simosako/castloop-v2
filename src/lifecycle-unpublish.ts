import { lifecycleJobStatusSchema, lifecycleProgressSchema, parseControlRequest, parseEpisodeLifecycle,
  parseJobStatus, parseLifecycleProgress, parseShowControl, stringifyLifecycleProgress,
  stringifyLifecycleToml, stringifyToml } from "../packages/shared/src/index";
import type { EpisodeRevision, LifecycleJobStatus, LifecycleProgress } from "../packages/shared/src/index";
import { finishShowOperation, readShowControl, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { readLifecycleFeedInputs } from "./lifecycle-feed";
import type { LifecycleFeedEnv } from "./lifecycle-feed";

export type UnpublishEffects = {
  writeFeed: (episodes: EpisodeRevision[]) => Promise<void>;
  purge: (target: { showId: string; episodeId?: string }) => Promise<void>;
};

async function stopTarget(env: LifecycleFeedEnv, execution: ShowExecution): Promise<void> {
  const current = await requireShowExecution(env, execution);
  const owner = current.value.owner!;
  if (owner.kind === "show") {
    if (current.value.lifecycle === "unpublished") return;
    if (current.value.lifecycle !== "active") throw new Error("Show is not eligible for unpublishing");
    const value = parseShowControl({ ...current.value, lifecycle: "unpublished" });
    const written = await env.CASTLOOP_BUCKET.put(`system/show-publications/${execution.showId}.json`, JSON.stringify(value), {
      onlyIf: { etagMatches: current.etag },
    });
    if (!written) throw new Error("Show control changed before unpublishing");
    return;
  }
  const frozen = await env.CASTLOOP_BUCKET.get(`system/jobs/${execution.jobId}/request.toml`);
  if (!frozen || frozen.size > 16384) throw new Error("Frozen unpublish request is missing or oversized");
  const request = parseControlRequest(await frozen.text());
  const key = `system/episode-lifecycle/${execution.showId}/${owner.episode_id}.toml`;
  const object = await env.CASTLOOP_BUCKET.get(key);
  if (!object || object.size > 16384) throw new Error("Episode lifecycle is missing or oversized");
  const episode = parseEpisodeLifecycle(await object.text());
  if (episode.show_id !== execution.showId || episode.episode_id !== owner.episode_id) {
    throw new Error("Episode lifecycle does not match the unpublish target");
  }
  if (episode.lifecycle === "unpublished" && episode.last_job_id === execution.jobId &&
    episode.generation === request.expected_episode_generation! + 1) return;
  if (episode.lifecycle !== "active" || episode.generation !== request.expected_episode_generation ||
    episode.generation === Number.MAX_SAFE_INTEGER) throw new Error("Episode changed before unpublishing");
  const value = { ...episode, lifecycle: "unpublished" as const, generation: episode.generation + 1,
    last_job_id: execution.jobId };
  const written = await env.CASTLOOP_BUCKET.put(key, stringifyLifecycleToml(value), { onlyIf: { etagMatches: object.etag } });
  if (!written) throw new Error("Episode lifecycle changed before unpublishing");
}

async function advanceFeedGeneration(env: LifecycleFeedEnv, execution: ShowExecution): Promise<void> {
  const current = await requireShowExecution(env, execution);
  if (current.value.last_feed_job_id === execution.jobId) return;
  if (current.value.feed_generation === Number.MAX_SAFE_INTEGER) throw new Error("Feed generation is exhausted");
  const value = parseShowControl({ ...current.value, feed_generation: current.value.feed_generation + 1,
    last_feed_job_id: execution.jobId });
  const written = await env.CASTLOOP_BUCKET.put(`system/show-publications/${execution.showId}.json`, JSON.stringify(value), {
    onlyIf: { etagMatches: current.etag },
  });
  if (!written) throw new Error("Show control changed before feed generation advanced");
}

export async function runLifecycleUnpublish(env: LifecycleFeedEnv, execution: ShowExecution,
  effects: UnpublishEffects): Promise<void> {
  const existing = await readShowControl(env, execution.showId);
  const receipt = existing?.value.last_finished_operation;
  if (receipt?.job_id === execution.jobId && receipt.generation === execution.generation &&
    receipt.execution_id === execution.executionId) {
    await finishShowOperation(env, execution);
    return;
  }
  const current = await requireShowExecution(env, execution);
  const owner = current.value.owner!;
  if (owner.action !== "unpublish") throw new Error("Unpublish runner requires an unpublish owner");
  const identity = { job_id: execution.jobId, show_id: execution.showId, kind: owner.kind,
    ...(owner.episode_id ? { episode_id: owner.episode_id } : {}), action: owner.action,
    show_generation: execution.generation, request_sha256: owner.request_sha256 };
  function matches(record: LifecycleJobStatus | LifecycleProgress): boolean {
    return record.job_id === identity.job_id && record.show_id === identity.show_id && record.kind === identity.kind &&
      record.episode_id === identity.episode_id && record.action === identity.action &&
      record.show_generation === identity.show_generation && record.request_sha256 === identity.request_sha256;
  }
  const prefix = `system/jobs/${execution.jobId}`;
  const [statusObject, progressObject] = await Promise.all([
    env.CASTLOOP_BUCKET.get(`${prefix}/status.toml`), env.CASTLOOP_BUCKET.get(`${prefix}/progress.toml`),
  ]);
  if (statusObject && statusObject.size > 16384 || progressObject && progressObject.size > 16384) {
    throw new Error("Unpublish job records exceed the size limit");
  }
  const status = statusObject ? parseJobStatus(await statusObject.text()) : null;
  if (status && (status.schema_version !== 2 || !matches(status))) throw new Error("Unpublish status does not match its owner");
  let progress = progressObject ? parseLifecycleProgress(await progressObject.text()) : lifecycleProgressSchema.parse({
    schema_version: 1, ...identity, phase: "admitted", deleted_objects: 0, purge_confirmed: false,
    updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  if (!matches(progress) || progress.deleted_objects !== 0 ||
    (progress.purge_confirmed && progress.phase !== "finished") ||
    (progress.phase === "finished" && !progress.purge_confirmed) ||
    (["deleting", "verifying", "finalizing"] as string[]).includes(progress.phase)) {
    throw new Error("Unpublish progress does not match its operation");
  }
  if (status?.state === "completed") {
    await finishShowOperation(env, execution);
    return;
  }
  if (status?.state === "abandoned" || status?.state === "published") throw new Error("Unpublish status is incompatible");
  async function recordStatus(state: "processing" | "retrying" | "completed", reason?: string): Promise<void> {
    await requireShowExecution(env, execution);
    const value = lifecycleJobStatusSchema.parse({ schema_version: 2, ...identity, state, phase: progress.phase,
      ...(state === "completed" ? { result_lifecycle: "unpublished" } : {}),
      ...(reason ? { reason: reason.slice(0, 4096) } : {}) });
    await env.CASTLOOP_BUCKET.put(`${prefix}/status.toml`, stringifyToml(value));
  }
  async function recordProgress(phase: LifecycleProgress["phase"], purged = false): Promise<void> {
    await requireShowExecution(env, execution);
    const value = lifecycleProgressSchema.parse({ ...progress, phase, purge_confirmed: purged,
      updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    await env.CASTLOOP_BUCKET.put(`${prefix}/progress.toml`, stringifyLifecycleProgress(value));
    progress = value;
  }
  if (progress.phase !== "finished") {
    try {
      if (progress.phase !== "purge") {
        await recordProgress("visibility");
        await recordStatus("processing");
        await stopTarget(env, execution);
        await recordProgress("feed");
        const feed = await readLifecycleFeedInputs(env, execution);
        if (feed.writeFeed) {
          await effects.writeFeed(feed.episodes);
          await advanceFeedGeneration(env, execution);
        }
        await recordProgress("purge");
      } else {
        await stopTarget(env, execution);
      }
      await recordStatus("processing");
      await requireShowExecution(env, execution);
      await effects.purge({ showId: execution.showId, ...(owner.episode_id ? { episodeId: owner.episode_id } : {}) });
      await recordProgress("finished", true);
    } catch (error) {
      await recordStatus("retrying", error instanceof Error ? error.message : "Unpublish processing failed");
      throw error;
    }
  }
  await recordStatus("completed");
  await finishShowOperation(env, execution);
}
