import { episodeLifecycleSchema, parseControlRequest, parseEpisodeLifecycle, parseShowControl,
  stringifyLifecycleToml, validateId } from "../packages/shared/src/index";
import type { EpisodeLifecycle, LifecycleProgress } from "../packages/shared/src/index";
import { requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import type { DeletionDeliveryCheck, LifecycleDeleteEnv } from "./lifecycle-delete-batch";
import { lifecycleDeletionScopes } from "./lifecycle-deletion";
import type { DeletionTarget } from "./lifecycle-deletion";
import { readLifecycleJobJournal, writeLifecycleProgress } from "./lifecycle-job-store";

async function finalizationProof(env: LifecycleDeleteEnv, execution: ShowExecution): Promise<{
  target: DeletionTarget; progress: LifecycleProgress;
}> {
  const journal = await readLifecycleJobJournal(env, execution);
  const target: DeletionTarget = journal.identity.kind === "show" ? { kind: "show", showId: execution.showId } :
    { kind: "episode", showId: execution.showId, episodeId: journal.identity.episode_id! };
  const progress = journal.progress;
  if (journal.identity.action !== "delete" || !progress || progress.phase !== "finalizing" ||
    !progress.purge_confirmed || !progress.final_purge_confirmed || progress.deletion_cursor !== undefined ||
    progress.deletion_scope_index !== lifecycleDeletionScopes(target).length) {
    throw new Error("Deletion finalization requires verified payload absence and final purging");
  }
  return { target, progress };
}

export async function stepShowDeletionTombstones(env: LifecycleDeleteEnv, execution: ShowExecution,
  checkDelivery: DeletionDeliveryCheck, maximumObjects = 20): Promise<LifecycleProgress> {
  if (!Number.isSafeInteger(maximumObjects) || maximumObjects < 1 || maximumObjects > 100) throw new Error("Invalid tombstone batch limit");
  const { target, progress } = await finalizationProof(env, execution);
  if (target.kind !== "show") throw new Error("Child tombstones require a Show deletion");
  const current = await requireShowExecution(env, execution);
  if (current.value.lifecycle !== "deleting") throw new Error("Show must remain deleting while child tombstones are written");
  await checkDelivery(target);
  if (progress.tombstones_complete) return progress;
  const prefix = `system/episode-lifecycle/${target.showId}/`;
  const page = await env.CASTLOOP_BUCKET.list({ prefix, cursor: progress.tombstone_cursor, limit: maximumObjects });
  if (page.objects.length > maximumObjects) throw new Error("Tombstone inventory exceeds its page limit");
  if (page.truncated && (!page.cursor || page.cursor === progress.tombstone_cursor)) throw new Error("Tombstone cursor did not advance");
  const seen = new Set<string>();
  const entries: Array<{ key: string; etag: string; value: EpisodeLifecycle }> = [];
  for (const listed of page.objects) {
    const name = listed.key.slice(prefix.length);
    if (!listed.key.startsWith(prefix) || !name.endsWith(".toml") || name.includes("/") || seen.has(listed.key)) {
      throw new Error("Invalid Show tombstone inventory key");
    }
    seen.add(listed.key);
    const episodeId = validateId(name.slice(0, -5), "episode");
    const object = await env.CASTLOOP_BUCKET.get(listed.key);
    if (!object || object.size > 16384 || object.etag !== listed.etag || object.size !== listed.size) {
      throw new Error("Episode lifecycle changed during Show finalization");
    }
    const value = parseEpisodeLifecycle(await object.text());
    if (value.show_id !== target.showId || value.episode_id !== episodeId) throw new Error("Child lifecycle does not match its key");
    entries.push({ key: listed.key, etag: object.etag, value });
  }
  let changed = 0;
  if ((progress.tombstoned_episodes ?? 0) > Number.MAX_SAFE_INTEGER - entries.length) throw new Error("Tombstone counter is exhausted");
  for (const entry of entries) {
    if (entry.value.lifecycle === "deleted") continue;
    await requireShowExecution(env, execution);
    const value = episodeLifecycleSchema.parse({ ...entry.value, lifecycle: "deleted", last_job_id: execution.jobId });
    const written = await env.CASTLOOP_BUCKET.put(entry.key, stringifyLifecycleToml(value), { onlyIf: { etagMatches: entry.etag } });
    if (!written) throw new Error("Child tombstone write conflicted");
    changed += 1;
  }
  const { tombstone_cursor: _cursor, ...withoutCursor } = progress;
  const next: LifecycleProgress = { ...withoutCursor, tombstoned_episodes: (progress.tombstoned_episodes ?? 0) + changed,
    ...(page.truncated ? { tombstone_cursor: page.cursor, tombstones_complete: false } : { tombstones_complete: true }),
    updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
  await writeLifecycleProgress(env, execution, next);
  return next;
}

export async function finalizeOwnedDeletionTarget(env: LifecycleDeleteEnv, execution: ShowExecution,
  checkDelivery: DeletionDeliveryCheck): Promise<void> {
  const { target, progress } = await finalizationProof(env, execution);
  const current = await requireShowExecution(env, execution);
  await checkDelivery(target);
  if (target.kind === "show") {
    if (!progress.tombstones_complete || progress.tombstone_cursor !== undefined) throw new Error("Show child tombstones are incomplete");
    if (current.value.lifecycle === "deleted") return;
    if (current.value.lifecycle !== "deleting") throw new Error("Show cannot complete deletion from its current state");
    const value = parseShowControl({ ...current.value, lifecycle: "deleted" });
    const written = await env.CASTLOOP_BUCKET.put(`system/show-publications/${target.showId}.json`, JSON.stringify(value), {
      onlyIf: { etagMatches: current.etag },
    });
    if (!written) throw new Error("Show changed before its deletion tombstone was completed");
    return;
  }
  if (!["active", "unpublished", "draft"].includes(current.value.lifecycle)) throw new Error("Parent Show changed before Episode finalization");
  const key = `system/episode-lifecycle/${target.showId}/${target.episodeId}.toml`;
  const [object, frozen] = await Promise.all([env.CASTLOOP_BUCKET.get(key),
    env.CASTLOOP_BUCKET.get(`system/jobs/${execution.jobId}/request.toml`)]);
  if (!object || !frozen || object.size > 16384 || frozen.size > 16384) throw new Error("Episode finalization records are missing or oversized");
  const episode = parseEpisodeLifecycle(await object.text());
  const request = parseControlRequest(await frozen.text());
  if (episode.show_id !== target.showId || episode.episode_id !== target.episodeId || episode.last_job_id !== execution.jobId ||
    episode.generation !== request.expected_episode_generation! + 1) throw new Error("Episode finalization does not match the deletion job");
  if (episode.lifecycle === "deleted") return;
  if (episode.lifecycle !== "deleting") throw new Error("Episode must remain deleting until finalization");
  await requireShowExecution(env, execution);
  const value = episodeLifecycleSchema.parse({ ...episode, lifecycle: "deleted" });
  const written = await env.CASTLOOP_BUCKET.put(key, stringifyLifecycleToml(value), { onlyIf: { etagMatches: object.etag } });
  if (!written) throw new Error("Episode changed before its deletion tombstone was completed");
}
