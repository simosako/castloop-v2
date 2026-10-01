import { acquireShowExecution, controlRequestHash, readShowControl } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import { LifecycleExecutionBusy, releaseSettledExecution } from "./lifecycle-consumer";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { InvalidFrozenPublication, parsePublicationCommitKey, readFrozenPublicationCommit } from "./publication-admission";
import { runOwnedShowPublication } from "./publication-show-runner";
import type { ShowPublicationEffects } from "./publication-show-runner";

export type PublicationConsumerResult = { state: "completed" } |
  { state: "ignored"; reason: "unmatched_path" | "unsupported_kind" | "missing_marker" | "stale_operation" } |
  { state: "invalid"; reason: "invalid_frozen_publication" };
export type ShowPublicationEffectFactory = (execution: ShowExecution) => ShowPublicationEffects | Promise<ShowPublicationEffects>;

export async function consumeOwnedPublication(env: LifecycleFeedEnv, key: string,
  source: ShowPublicationEffects | ShowPublicationEffectFactory): Promise<PublicationConsumerResult> {
  const target = parsePublicationCommitKey(key);
  if (!target) return { state: "ignored", reason: "unmatched_path" };
  if (target.kind !== "show") return { state: "ignored", reason: "unsupported_kind" };
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
    const effects = typeof source === "function" ? await source(execution) : source;
    await runOwnedShowPublication(env, execution, effects);
  } catch (error) {
    if (await releaseSettledExecution(env, execution) === "completed") return { state: "completed" };
    throw error;
  }
  return { state: "completed" };
}
