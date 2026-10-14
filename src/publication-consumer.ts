import { parseJobStatus } from "../packages/shared/src/index";
import { acquireShowExecution, controlRequestHash, createShowExecutionEnv, readShowControl } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { LifecycleExecutionBusy, releaseSettledExecution } from "./lifecycle-consumer";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { InvalidFrozenPublication, parsePublicationCommitKey, publicationCommitKey, readFrozenPublicationCommit, requireOwnedPublication } from "./publication-admission";
import type { PublicationOperation } from "./publication-admission";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { runOwnedShowPublication } from "./publication-show-runner";
import { runOwnedEpisodePublication } from "./publication-episode-runner";
import type { PublicationEffects } from "./publication-inputs";
import { logPublicationExecutionBlocked, measureWorkerPhase } from "./worker-timing";
import { lifecycleJobMatches } from "./lifecycle-job-store";

export type PublicationConsumerResult = { state: "completed" } | { state: "failed"; reason: "validation_failed" } |
  { state: "ignored"; reason: "unmatched_path" | "missing_marker" | "stale_operation" } |
  { state: "invalid"; reason: "invalid_frozen_publication" };
export type PublicationEffectFactory = (execution: ShowExecution, env: LifecycleFeedEnv) => PublicationEffects | Promise<PublicationEffects>;

export async function requeuePublicationOperation(env: LifecycleControlEnv, operation: PublicationOperation,
  send: (key: string) => Promise<void>): Promise<string> {
  const owned = await requireOwnedPublication(env, operation, { allowPublishedResult: true });
  const key = publicationCommitKey(owned.frozen.commit);
  const marker = await readFrozenPublicationCommit(env, key);
  if (!marker || JSON.stringify(marker) !== JSON.stringify(owned.frozen)) throw new InvalidFrozenPublication();
  const statusObject = await env.CASTLOOP_BUCKET.get(`system/jobs/${operation.jobId}/status.toml`);
  if (statusObject) {
    if (statusObject.size < 1 || statusObject.size > 16384) throw new Error("Publication status is oversized or empty");
    const status = parseJobStatus(await statusObject.text());
    const request = owned.frozen.request;
    if (status.schema_version !== 2 || !lifecycleJobMatches(status, { ...request,
      show_generation: operation.generation, request_sha256: owned.control.value.owner.request_sha256 })) {
      throw new Error("Publication retry status differs from its retained owner");
    }
    if (status.state === "failed") throw new Error("Publication validation failed; preserve its frozen request and held owner");
  }
  const latest = await requireOwnedPublication(env, operation, { allowPublishedResult: true });
  if (JSON.stringify(latest.frozen) !== JSON.stringify(marker)) throw new InvalidFrozenPublication();
  if (latest.control.value.owner.execution_id || latest.control.value.owner.verification_id) throw new LifecycleExecutionBusy();
  if (!["reserved", "processing"].includes(latest.control.value.owner.state)) throw new Error("Publication retry requires an unfinished non-upload owner");
  await send(key);
  return key;
}

export async function consumeOwnedPublication(env: LifecycleFeedEnv, key: string,
  source: PublicationEffects | PublicationEffectFactory): Promise<PublicationConsumerResult> {
  const target = parsePublicationCommitKey(key);
  if (!target) return { state: "ignored", reason: "unmatched_path" };
  let frozen;
  try { frozen = await measureWorkerPhase(target.jobId, "publication.frozen_commit", () => readFrozenPublicationCommit(env, key)); }
  catch (error) {
    if (error instanceof InvalidFrozenPublication) return { state: "invalid", reason: "invalid_frozen_publication" };
    throw error;
  }
  if (!frozen) return { state: "ignored", reason: "missing_marker" };
  const request = frozen.request;
  const current = await measureWorkerPhase(request.job_id, "publication.owner_check", () => readShowControl(env, request.show_id));
  const owner = current?.value.owner;
  if (!current || current.value.generation !== request.expected_show_generation + 1 || !owner || owner.job_id !== request.job_id ||
    owner.action !== "publish" || owner.kind !== request.kind || owner.episode_id !== request.episode_id ||
    owner.request_sha256 !== await controlRequestHash(request)) return { state: "ignored", reason: "stale_operation" };
  if (owner.execution_id) {
    logPublicationExecutionBlocked(request.job_id);
    throw new LifecycleExecutionBusy();
  }
  const execution = await measureWorkerPhase(request.job_id, "publication.execution_acquire", () =>
    acquireShowExecution(env, request.show_id, request.job_id, current.value.generation));
  try {
    const executionEnv = request.kind === "episode" ? await measureWorkerPhase(request.job_id, "publication.execution_context", () =>
      createShowExecutionEnv(env, execution)) : env;
    const effects = typeof source === "function" ? await measureWorkerPhase(request.job_id, "publication.effects", () =>
      Promise.resolve(source(execution, executionEnv))) : source;
    const result = await measureWorkerPhase(request.job_id, "publication.runner", () => request.kind === "show" ?
      runOwnedShowPublication(env, execution, effects) : runOwnedEpisodePublication(executionEnv, execution, effects));
    if (result === "failed") {
      await measureWorkerPhase(request.job_id, "publication.execution_cleanup", () => releaseSettledExecution(env, execution));
      return { state: "failed", reason: "validation_failed" };
    }
  } catch (error) {
    if (await measureWorkerPhase(request.job_id, "publication.execution_cleanup", () => releaseSettledExecution(env, execution)) === "completed") {
      return { state: "completed" };
    }
    throw error;
  }
  return { state: "completed" };
}
