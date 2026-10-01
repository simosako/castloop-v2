import { lifecycleCommitKey, parseLifecycleCommitKey } from "../packages/shared/src/index";
import type { LifecycleCommit, LifecycleCommitTarget } from "../packages/shared/src/index";
import { InvalidLifecycleCommit, readLifecycleCommit } from "./lifecycle-commit";
import { acquireShowExecution, readShowControl, releaseShowExecution, requireOwnedOperation } from "./lifecycle-control";
import type { LifecycleControlEnv, ShowExecution } from "./lifecycle-control";
import { stepLifecycleDelete } from "./lifecycle-delete";
import type { DeleteEffects } from "./lifecycle-delete";
import type { LifecycleDeleteEnv } from "./lifecycle-delete-batch";
import { runLifecycleRestore } from "./lifecycle-restore";
import type { RestoreEffects } from "./lifecycle-restore";
import { runLifecycleUnpublish } from "./lifecycle-unpublish";
import type { UnpublishEffects } from "./lifecycle-unpublish";

export type LifecycleConsumerEffects = {
  unpublish: UnpublishEffects;
  restore: RestoreEffects;
  delete: DeleteEffects;
  sendContinuation: (key: string) => Promise<void>;
};
export type LifecycleConsumerEffectFactory = (execution: ShowExecution) => LifecycleConsumerEffects | Promise<LifecycleConsumerEffects>;
export type LifecycleConsumerResult = { state: "completed" | "continued" } |
  { state: "ignored"; reason: "unmatched_path" | "missing_marker" | "stale_operation" } |
  { state: "invalid"; reason: "invalid_lifecycle_commit" };

export class LifecycleExecutionBusy extends Error {
  constructor() { super("Another invocation still owns this lifecycle execution"); }
}

function matchesOwner(marker: LifecycleCommit, owner: {
  job_id: string; kind: string; episode_id?: string; action: string; request_sha256: string;
}): boolean {
  return marker.job_id === owner.job_id && marker.kind === owner.kind && marker.episode_id === owner.episode_id &&
    marker.action === owner.action && marker.request_sha256 === owner.request_sha256;
}

export async function releaseSettledExecution(env: LifecycleControlEnv, execution: ShowExecution): Promise<"released" | "completed"> {
  const current = await readShowControl(env, execution.showId);
  const receipt = current?.value.last_finished_operation;
  if (receipt?.job_id === execution.jobId && receipt.generation === execution.generation && receipt.execution_id === execution.executionId) {
    return "completed";
  }
  if (!current || current.value.generation !== execution.generation || current.value.owner?.job_id !== execution.jobId) {
    throw new Error("Settled invocation no longer matches its lifecycle owner");
  }
  if (!current.value.owner.execution_id || current.value.owner.execution_id !== execution.executionId) return "released";
  try {
    await releaseShowExecution(env, execution);
  } catch (error) {
    const updated = await readShowControl(env, execution.showId);
    if (updated?.value.generation === execution.generation && updated.value.owner?.job_id === execution.jobId &&
      updated.value.owner.state === "processing" && updated.value.owner.execution_id !== execution.executionId) return "released";
    const finished = updated?.value.last_finished_operation;
    if (finished?.job_id === execution.jobId && finished.generation === execution.generation && finished.execution_id === execution.executionId) {
      return "completed";
    }
    throw error;
  }
  return "released";
}

export async function consumeLifecycleCommit(env: LifecycleDeleteEnv, key: string, source: LifecycleConsumerEffects | LifecycleConsumerEffectFactory,
  options: { maximumObjects?: number } = {}): Promise<LifecycleConsumerResult> {
  if (!parseLifecycleCommitKey(key)) return { state: "ignored", reason: "unmatched_path" };
  let marker: LifecycleCommit | null;
  try { marker = await readLifecycleCommit(env, key); }
  catch (error) {
    if (error instanceof InvalidLifecycleCommit) return { state: "invalid", reason: "invalid_lifecycle_commit" };
    throw error;
  }
  if (!marker) return { state: "ignored", reason: "missing_marker" };
  const current = await readShowControl(env, marker.show_id);
  if (!current || current.value.generation !== marker.show_generation || !current.value.owner ||
    !matchesOwner(marker, current.value.owner)) return { state: "ignored", reason: "stale_operation" };
  if (current.value.owner.execution_id) throw new LifecycleExecutionBusy();
  const execution = await acquireShowExecution(env, marker.show_id, marker.job_id, marker.show_generation);
  let pending = false;
  let effects: LifecycleConsumerEffects;
  try {
    effects = typeof source === "function" ? await source(execution) : source;
    if (marker.action === "unpublish") await runLifecycleUnpublish(env, execution, effects.unpublish);
    else if (marker.action === "restore") await runLifecycleRestore(env, execution, effects.restore);
    else pending = (await stepLifecycleDelete(env, execution, effects.delete, options)).state === "pending";
  } catch (error) {
    if (await releaseSettledExecution(env, execution) === "completed") return { state: "completed" };
    throw error;
  }
  if (!pending) return { state: "completed" };
  if (await releaseSettledExecution(env, execution) === "completed") return { state: "completed" };
  await effects.sendContinuation(key);
  return { state: "continued" };
}

export async function requeueLifecycleOperation(env: LifecycleControlEnv, target: LifecycleCommitTarget,
  send: (key: string) => Promise<void>): Promise<void> {
  const key = lifecycleCommitKey({ kind: target.kind, show_id: target.show_id, job_id: target.job_id,
    ...(target.episode_id !== undefined ? { episode_id: target.episode_id } : {}) });
  const marker = await readLifecycleCommit(env, key);
  if (!marker) throw new Error("Lifecycle retry requires its retained commit marker");
  const current = await requireOwnedOperation(env, marker.show_id, marker.job_id, marker.show_generation);
  if (!matchesOwner(marker, current.value.owner)) throw new InvalidLifecycleCommit();
  if (current.value.owner.execution_id) throw new LifecycleExecutionBusy();
  if (current.value.owner.state !== "reserved" && current.value.owner.state !== "processing") {
    throw new Error("Lifecycle retry requires an unfinished non-upload owner");
  }
  await send(key);
}
