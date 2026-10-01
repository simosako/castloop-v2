import { lifecycleFailureForPhase, lifecycleJobStatusSchema, lifecycleProgressSchema } from "../packages/shared/src/index";
import type { EpisodeRevision, LifecycleProgress } from "../packages/shared/src/index";
import { finishShowOperation, readShowControl, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { stepLifecyclePayloadDeletion } from "./lifecycle-delete-batch";
import type { DeletionDeliveryCheck, LifecycleDeleteEnv } from "./lifecycle-delete-batch";
import { finalizeOwnedDeletionTarget, stepShowDeletionTombstones } from "./lifecycle-delete-finalize";
import type { DeletionTarget } from "./lifecycle-deletion";
import { lifecycleDeletionScopes } from "./lifecycle-deletion";
import { readLifecycleFeedInputs } from "./lifecycle-feed";
import { readLifecycleJobJournal, writeLifecycleJobStatus, writeLifecycleProgress } from "./lifecycle-job-store";
import { advanceLifecycleFeedGeneration, closeOwnedLifecycleTarget } from "./lifecycle-mutations";

export type DeleteEffects = {
  writeFeed: (episodes: EpisodeRevision[]) => Promise<void>;
  purge: (target: DeletionTarget) => Promise<void>;
  checkDelivery: DeletionDeliveryCheck;
};
export type DeleteStepResult = { state: "pending" | "completed"; phase: LifecycleProgress["phase"] };

export async function stepLifecycleDelete(env: LifecycleDeleteEnv, execution: ShowExecution,
  effects: DeleteEffects, options: { maximumObjects?: number } = {}): Promise<DeleteStepResult> {
  const maximum = options.maximumObjects ?? 20;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new Error("Invalid deletion step limit");
  const existing = await readShowControl(env, execution.showId);
  const receipt = existing?.value.last_finished_operation;
  if (receipt?.job_id === execution.jobId && receipt.generation === execution.generation && receipt.execution_id === execution.executionId) {
    await finishShowOperation(env, execution);
    return { state: "completed", phase: "finished" };
  }
  const journal = await readLifecycleJobJournal(env, execution);
  const identity = journal.identity;
  if (identity.action !== "delete") throw new Error("Deletion runner requires a delete owner");
  const target: DeletionTarget = identity.kind === "show" ? { kind: "show", showId: identity.show_id } :
    { kind: "episode", showId: identity.show_id, episodeId: identity.episode_id! };
  let progress = journal.progress ?? lifecycleProgressSchema.parse({ schema_version: 1, ...identity, phase: "admitted",
    deleted_objects: 0, purge_confirmed: false, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
  if (journal.status?.state === "completed") {
    await finishShowOperation(env, execution);
    return { state: "completed", phase: "finished" };
  }
  if (journal.status?.state === "abandoned" || journal.status?.state === "published") throw new Error("Deletion status is incompatible");
  const preparing = ["admitted", "validating", "visibility", "feed", "purge"].includes(progress.phase);
  if (preparing && (progress.deleted_objects !== 0 || progress.purge_confirmed || progress.deletion_scope_index !== undefined ||
    progress.deletion_cursor !== undefined || progress.final_purge_confirmed !== undefined || progress.tombstones_complete !== undefined)) {
    throw new Error("Deletion preparation contains premature completion evidence");
  }
  if (["deleting", "verifying", "finalizing"].includes(progress.phase) &&
    (!progress.purge_confirmed || progress.deletion_scope_index === undefined)) throw new Error("Deletion has no stopped/purged progress");
  let failurePhase = progress.phase;
  async function recordProgress(changes: Partial<LifecycleProgress>): Promise<void> {
    const value = lifecycleProgressSchema.parse({ ...progress, ...changes, updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    await writeLifecycleProgress(env, execution, value);
    progress = value;
  }
  async function recordStatus(state: "processing" | "retrying" | "completed"): Promise<void> {
    const value = lifecycleJobStatusSchema.parse({ schema_version: 2, ...identity, state, phase: progress.phase,
      ...(state === "completed" ? { result_lifecycle: "deleted" } : {}),
      ...(state === "retrying" ? lifecycleFailureForPhase(failurePhase) : {}) });
    await writeLifecycleJobStatus(env, execution, value);
  }
  try {
    if (preparing) {
      if (progress.phase !== "purge") {
        failurePhase = "visibility";
        await recordProgress({ phase: "visibility" });
        await recordStatus("processing");
        await closeOwnedLifecycleTarget(env, execution);
        await effects.checkDelivery(target);
        failurePhase = "feed";
        await recordProgress({ phase: "feed" });
        const feed = await readLifecycleFeedInputs(env, execution);
        if (feed.writeFeed) {
          await effects.writeFeed(feed.episodes);
          await advanceLifecycleFeedGeneration(env, execution);
        }
        await recordProgress({ phase: "purge" });
      } else {
        await closeOwnedLifecycleTarget(env, execution);
      }
      failurePhase = "purge";
      await recordStatus("processing");
      await effects.checkDelivery(target);
      await requireShowExecution(env, execution);
      await effects.purge(target);
      await recordProgress({ phase: "deleting", purge_confirmed: true, deletion_scope_index: 0 });
      await recordStatus("processing");
      return { state: "pending", phase: "deleting" };
    }
    if (progress.phase === "deleting" || progress.phase === "verifying") {
      failurePhase = progress.phase;
      const result = await stepLifecyclePayloadDeletion(env, execution, effects.checkDelivery, { maximumObjects: maximum });
      progress = result.progress;
      await recordStatus("processing");
      return { state: "pending", phase: progress.phase };
    }
    if (progress.phase === "finalizing") {
      if (progress.deletion_scope_index !== lifecycleDeletionScopes(target).length || progress.deletion_cursor !== undefined) {
        throw new Error("Deletion payload verification is incomplete");
      }
      await recordStatus("processing");
      if (!progress.final_purge_confirmed) {
        failurePhase = "purge";
        await effects.checkDelivery(target);
        await requireShowExecution(env, execution);
        await effects.purge(target);
        await recordProgress({ final_purge_confirmed: true });
      }
      failurePhase = "finalizing";
      if (target.kind === "show" && !progress.tombstones_complete) {
        progress = await stepShowDeletionTombstones(env, execution, effects.checkDelivery, maximum);
        await recordStatus("processing");
        return { state: "pending", phase: "finalizing" };
      }
      await finalizeOwnedDeletionTarget(env, execution, effects.checkDelivery);
      await recordProgress({ phase: "finished" });
    }
    if (progress.phase !== "finished") throw new Error("Deletion cannot finish from its current phase");
    failurePhase = "finished";
    await recordStatus("completed");
    await finishShowOperation(env, execution);
    return { state: "completed", phase: "finished" };
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
