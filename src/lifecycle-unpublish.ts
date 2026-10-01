import { lifecycleFailureForPhase, lifecycleJobStatusSchema, lifecycleProgressSchema } from "../packages/shared/src/index";
import type { EpisodeRevision, LifecycleProgress } from "../packages/shared/src/index";
import { finishShowOperation, readShowControl, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { readLifecycleFeedInputs } from "./lifecycle-feed";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { advanceLifecycleFeedGeneration, closeOwnedLifecycleTarget } from "./lifecycle-mutations";
import { readLifecycleJobJournal, writeLifecycleJobStatus, writeLifecycleProgress } from "./lifecycle-job-store";

export type UnpublishEffects = {
  writeFeed: (episodes: EpisodeRevision[]) => Promise<void>;
  purge: (target: { showId: string; episodeId?: string }) => Promise<void>;
};

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
  const { identity, status, progress: savedProgress } = await readLifecycleJobJournal(env, execution);
  let progress = savedProgress ?? lifecycleProgressSchema.parse({
    schema_version: 1, ...identity, phase: "admitted", deleted_objects: 0, purge_confirmed: false,
    updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  if (progress.deleted_objects !== 0 ||
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
  async function recordStatus(state: "processing" | "retrying" | "completed"): Promise<void> {
    await requireShowExecution(env, execution);
    const value = lifecycleJobStatusSchema.parse({ schema_version: 2, ...identity, state, phase: progress.phase,
      ...(state === "completed" ? { result_lifecycle: "unpublished" } : {}),
      ...(state === "retrying" ? lifecycleFailureForPhase(progress.phase) : {}) });
    await writeLifecycleJobStatus(env, execution, value);
  }
  async function recordProgress(phase: LifecycleProgress["phase"], purged = false): Promise<void> {
    await requireShowExecution(env, execution);
    const value = lifecycleProgressSchema.parse({ ...progress, phase, purge_confirmed: purged,
      updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    await writeLifecycleProgress(env, execution, value);
    progress = value;
  }
  if (progress.phase !== "finished") {
    try {
      if (progress.phase !== "purge") {
        await recordProgress("visibility");
        await recordStatus("processing");
        await closeOwnedLifecycleTarget(env, execution);
        await recordProgress("feed");
        const feed = await readLifecycleFeedInputs(env, execution);
        if (feed.writeFeed) {
          await effects.writeFeed(feed.episodes);
          await advanceLifecycleFeedGeneration(env, execution);
        }
        await recordProgress("purge");
      } else {
        await closeOwnedLifecycleTarget(env, execution);
      }
      await recordStatus("processing");
      await requireShowExecution(env, execution);
      await effects.purge({ showId: execution.showId, ...(owner.episode_id ? { episodeId: owner.episode_id } : {}) });
      await recordProgress("finished", true);
    } catch (error) {
      await recordStatus("retrying");
      throw error;
    }
  }
  await recordStatus("completed");
  await finishShowOperation(env, execution);
}
