import { episodeCommitSchema, lifecycleProgressSchema, parseControlRequest, parseLifecycleProgress,
  showCommitSchema, stringifyLifecycleProgress } from "../packages/shared/src/index";
import type { LifecycleProgress } from "../packages/shared/src/index";
import { readEpisodeLifecycle, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { lifecycleDeletionScopes, readLifecycleDeletionPage } from "./lifecycle-deletion";
import type { DeletionObject, DeletionTarget } from "./lifecycle-deletion";

export type LifecycleDeleteEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "head" | "put" | "list" | "delete"> };
export type DeletionDeliveryCheck = (target: DeletionTarget) => Promise<void>;
export type DeletionBatchResult = { progress: LifecycleProgress; removedThisStep: number; readyForFinalization: boolean };

async function requireDeletionTarget(env: LifecycleDeleteEnv, execution: ShowExecution): Promise<DeletionTarget> {
  const current = await requireShowExecution(env, execution);
  const owner = current.value.owner!;
  if (owner.action !== "delete") throw new Error("Payload deletion requires a delete owner");
  if (owner.kind === "show") {
    if (current.value.lifecycle !== "deleting") throw new Error("Show delivery is not closed for deletion");
    return { kind: "show", showId: execution.showId };
  }
  if (current.value.lifecycle !== "active" && current.value.lifecycle !== "unpublished" && current.value.lifecycle !== "draft") {
    throw new Error("Parent Show changed during Episode deletion");
  }
  const [episode, frozen] = await Promise.all([
    readEpisodeLifecycle(env, execution.showId, owner.episode_id!),
    env.CASTLOOP_BUCKET.get(`system/jobs/${execution.jobId}/request.toml`),
  ]);
  if (!frozen || frozen.size > 16384) throw new Error("Frozen deletion request is missing or oversized");
  const request = parseControlRequest(await frozen.text());
  if (!episode || episode.lifecycle !== "deleting" || episode.last_job_id !== execution.jobId ||
    episode.generation !== request.expected_episode_generation! + 1) {
    throw new Error("Episode delivery is not closed by this deletion operation");
  }
  return { kind: "episode", showId: execution.showId, episodeId: owner.episode_id! };
}

async function verifyRetainedMarker(env: LifecycleDeleteEnv, marker: DeletionObject): Promise<void> {
  if (marker.size > 16384) throw new Error("Retained publication marker exceeds the size limit");
  const object = await env.CASTLOOP_BUCKET.get(marker.key);
  if (!object || object.etag !== marker.etag || object.size !== marker.size) {
    throw new Error("Retained publication marker changed during deletion");
  }
  const parts = marker.key.split("/");
  let data: unknown;
  try { data = await object.json<unknown>(); }
  catch { throw new Error("Retained publication marker is not valid JSON"); }
  if (parts[1] === "shows") {
    const parsed = showCommitSchema.safeParse(data);
    if (!parsed.success || parsed.data.show_id !== parts[2] || parsed.data.job_id !== parts[3]) {
      throw new Error("Retained Show marker failed strict validation");
    }
  } else {
    const parsed = episodeCommitSchema.safeParse(data);
    if (!parsed.success || parsed.data.show_id !== parts[2] || parsed.data.episode_id !== parts[3] || parsed.data.job_id !== parts[4]) {
      throw new Error("Retained Episode marker failed strict validation");
    }
  }
}

export async function stepLifecyclePayloadDeletion(env: LifecycleDeleteEnv, execution: ShowExecution,
  checkDelivery: DeletionDeliveryCheck, options: { maximumObjects?: number } = {}): Promise<DeletionBatchResult> {
  const maximum = options.maximumObjects ?? 100;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new Error("Invalid deletion batch limit");
  const target = await requireDeletionTarget(env, execution);
  const snapshot = await requireShowExecution(env, execution);
  const owner = snapshot.value.owner!;
  const key = `system/jobs/${execution.jobId}/progress.toml`;
  const object = await env.CASTLOOP_BUCKET.get(key);
  if (!object || object.size > 16384) throw new Error("Durable deletion progress is missing or oversized");
  const progress = parseLifecycleProgress(await object.text());
  const scopes = lifecycleDeletionScopes(target);
  if (progress.job_id !== execution.jobId || progress.show_id !== execution.showId || progress.kind !== owner.kind ||
    progress.episode_id !== owner.episode_id || progress.action !== "delete" ||
    progress.show_generation !== execution.generation || progress.request_sha256 !== owner.request_sha256 ||
    !progress.purge_confirmed || progress.deletion_scope_index === undefined ||
    !["deleting", "verifying", "finalizing"].includes(progress.phase)) {
    throw new Error("Deletion progress does not prove stopped and purged ownership");
  }
  await checkDelivery(target);
  const scopeIndex = progress.deletion_scope_index;
  if (progress.phase === "finalizing") {
    if (scopeIndex !== scopes.length || progress.deletion_cursor !== undefined) throw new Error("Invalid final deletion position");
    return { progress, removedThisStep: 0, readyForFinalization: true };
  }
  if (scopeIndex >= scopes.length) throw new Error("Deletion scope is outside the target");
  if (progress.deleted_objects > Number.MAX_SAFE_INTEGER - maximum) throw new Error("Deletion counter is exhausted");
  const page = await readLifecycleDeletionPage(env, target, {
    scopeIndex, cursor: progress.deletion_cursor, limit: maximum,
  });
  if (page.blockers.length) throw new Error("Unknown payload key blocks deletion; inspect the read-only inventory");
  for (const marker of page.retainedMarkers) await verifyRetainedMarker(env, marker);
  let removedThisStep = 0;
  let next = progress;
  if (page.payload.length && progress.phase === "verifying") {
    const { deletion_cursor: _cursor, ...withoutCursor } = progress;
    next = { ...withoutCursor, phase: "deleting" };
  } else if (page.payload.length) {
    const keys: string[] = [];
    for (const payload of page.payload) {
      const current = await env.CASTLOOP_BUCKET.head(payload.key);
      if (!current) continue;
      if (current.etag !== payload.etag || current.size !== payload.size) throw new Error("Payload changed before deletion");
      keys.push(payload.key);
    }
    await requireDeletionTarget(env, execution);
    await checkDelivery(target);
    await requireDeletionTarget(env, execution);
    if (keys.length) {
      await env.CASTLOOP_BUCKET.delete(keys);
      removedThisStep = keys.length;
    }
    next = { ...progress, deleted_objects: progress.deleted_objects + removedThisStep };
  } else if (page.nextCursor) {
    next = { ...progress, deletion_cursor: page.nextCursor };
  } else {
    const { deletion_cursor: _cursor, ...withoutCursor } = progress;
    const index = scopeIndex + 1;
    next = index < scopes.length ? { ...withoutCursor, deletion_scope_index: index } :
      progress.phase === "deleting" ? { ...withoutCursor, phase: "verifying", deletion_scope_index: 0 } :
        { ...withoutCursor, phase: "finalizing", deletion_scope_index: scopes.length };
  }
  next = lifecycleProgressSchema.parse({ ...next, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
  await requireDeletionTarget(env, execution);
  const written = await env.CASTLOOP_BUCKET.put(key, stringifyLifecycleProgress(next), { onlyIf: { etagMatches: object.etag } });
  if (!written) throw new Error("Deletion progress changed before it was saved");
  return { progress: next, removedThisStep, readyForFinalization: next.phase === "finalizing" };
}
