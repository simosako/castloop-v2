import { acquireShowExecution, controlRequestHash, createShowExecutionEnv, readShowControl, releaseShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { LifecycleExecutionBusy, releaseSettledExecution } from "./lifecycle-consumer";
import { releaseRetainedConsumerInvocation } from "./service-admission";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { InvalidFrozenPublication, parsePublicationCommitKey, publicationCommitKey, readFrozenPublicationCommit, requireOwnedPublication } from "./publication-admission";
import type { PublicationOperation } from "./publication-admission";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { runOwnedShowPublication } from "./publication-show-runner";
import { runOwnedEpisodePublication } from "./publication-episode-runner";
import type { PublicationEffects } from "./publication-inputs";

export type PublicationConsumerResult = { state: "completed" } |
  { state: "ignored"; reason: "unmatched_path" | "missing_marker" | "stale_operation" } |
  { state: "invalid"; reason: "invalid_frozen_publication" };
export type PublicationEffectFactory = (execution: ShowExecution, env: LifecycleFeedEnv) => PublicationEffects | Promise<PublicationEffects>;

export async function requeuePublicationOperation(env: LifecycleControlEnv, operation: PublicationOperation,
  send: (key: string) => Promise<void>): Promise<string> {
  const owned = await requireOwnedPublication(env, operation, { allowPublishedResult: true });
  const key = publicationCommitKey(owned.frozen.commit);
  const marker = await readFrozenPublicationCommit(env, key);
  if (!marker || JSON.stringify(marker) !== JSON.stringify(owned.frozen)) throw new InvalidFrozenPublication();
  const latest = await requireOwnedPublication(env, operation, { allowPublishedResult: true });
  if (JSON.stringify(latest.frozen) !== JSON.stringify(marker)) throw new InvalidFrozenPublication();
  if (latest.control.value.owner.execution_id || latest.control.value.owner.verification_id) throw new LifecycleExecutionBusy();
  if (!["reserved", "processing"].includes(latest.control.value.owner.state)) throw new Error("Publication retry requires an unfinished non-upload owner");
  await send(key);
  return key;
}

export async function releaseAbandonedPublication(env: LifecycleControlEnv, operation: PublicationOperation,
  input: { serviceId: string; send: (key: string) => Promise<void> }): Promise<{ key: string; invocationReleased: boolean }> {
  const owned = await requireOwnedPublication(env, operation, { allowPublishedResult: true });
  const key = publicationCommitKey(owned.frozen.commit);
  const marker = await readFrozenPublicationCommit(env, key);
  if (!marker || JSON.stringify(marker) !== JSON.stringify(owned.frozen)) throw new InvalidFrozenPublication();
  const latest = await requireOwnedPublication(env, operation, { allowPublishedResult: true });
  if (JSON.stringify(latest.frozen) !== JSON.stringify(marker)) throw new InvalidFrozenPublication();
  if (latest.control.value.owner.verification_id) throw new LifecycleExecutionBusy();
  if (!["reserved", "processing"].includes(latest.control.value.owner.state)) {
    throw new Error("Publication release requires an unfinished non-upload owner");
  }
  const deadLetter = await env.CASTLOOP_BUCKET.get(`system/jobs/${operation.jobId}/dlq.json`);
  if (!deadLetter || deadLetter.size < 1 || deadLetter.size > 16384) {
    throw new Error("Publication release requires its dead-letter evidence that every delivery attempt ended");
  }
  let evidence: unknown;
  try { evidence = JSON.parse(await deadLetter.text()); }
  catch { throw new Error("Publication dead-letter evidence is invalid"); }
  if (JSON.stringify(evidence) !== JSON.stringify({ key })) {
    throw new Error("Publication dead-letter evidence belongs to another delivery");
  }
  const executionId = latest.control.value.owner.execution_id;
  if (!executionId) {
    await input.send(key);
    return { key, invocationReleased: false };
  }
  if (latest.control.value.owner.state !== "processing") {
    throw new Error("Publication release requires a processing owner holding its execution token");
  }
  const invocationReleased = await releaseRetainedConsumerInvocation(env, input.serviceId);
  await releaseShowExecution(env, { showId: operation.showId, jobId: operation.jobId, generation: operation.generation, executionId });
  await input.send(key);
  return { key, invocationReleased };
}

export async function consumeOwnedPublication(env: LifecycleFeedEnv, key: string,
  source: PublicationEffects | PublicationEffectFactory): Promise<PublicationConsumerResult> {
  const target = parsePublicationCommitKey(key);
  if (!target) return { state: "ignored", reason: "unmatched_path" };
  let frozen;
  try { frozen = await readFrozenPublicationCommit(env, key); }
  catch (error) {
    if (error instanceof InvalidFrozenPublication) return { state: "invalid", reason: "invalid_frozen_publication" };
    throw error;
  }
  if (!frozen) return { state: "ignored", reason: "missing_marker" };
  const request = frozen.request;
  const current = await readShowControl(env, request.show_id);
  const owner = current?.value.owner;
  if (!current || current.value.generation !== request.expected_show_generation + 1 || !owner || owner.job_id !== request.job_id ||
    owner.action !== "publish" || owner.kind !== request.kind || owner.episode_id !== request.episode_id ||
    owner.request_sha256 !== await controlRequestHash(request)) return { state: "ignored", reason: "stale_operation" };
  if (owner.execution_id) throw new LifecycleExecutionBusy();
  const execution = await acquireShowExecution(env, request.show_id, request.job_id, current.value.generation);
  try {
    const executionEnv = request.kind === "episode" ? await createShowExecutionEnv(env, execution) : env;
    const effects = typeof source === "function" ? await source(execution, executionEnv) : source;
    if (request.kind === "show") await runOwnedShowPublication(env, execution, effects);
    else await runOwnedEpisodePublication(executionEnv, execution, effects);
  } catch (error) {
    if (await releaseSettledExecution(env, execution) === "completed") return { state: "completed" };
    throw error;
  }
  return { state: "completed" };
}
