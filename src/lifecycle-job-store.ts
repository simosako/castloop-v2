import { lifecycleJobStatusSchema, lifecycleProgressSchema, parseJobStatus, parseLifecycleProgress,
  stringifyLifecycleProgress, stringifyToml } from "../packages/shared/src/index";
import type { LifecycleJobStatus, LifecycleProgress } from "../packages/shared/src/index";
import { readEpisodeLifecycle, requireShowExecution } from "./lifecycle-control";
import type { LifecycleControlEnv, ShowExecution } from "./lifecycle-control";

export type LifecycleJobIdentity = Pick<LifecycleJobStatus,
  "job_id" | "show_id" | "kind" | "episode_id" | "action" | "show_generation" | "request_sha256">;
export type LifecycleJobJournal = { identity: LifecycleJobIdentity; status: LifecycleJobStatus | null; progress: LifecycleProgress | null };

export function lifecycleJobMatches(record: LifecycleJobIdentity, identity: LifecycleJobIdentity): boolean {
  return record.job_id === identity.job_id && record.show_id === identity.show_id && record.kind === identity.kind &&
    record.episode_id === identity.episode_id && record.action === identity.action &&
    record.show_generation === identity.show_generation && record.request_sha256 === identity.request_sha256;
}

async function requireIdentity(env: LifecycleControlEnv, execution: ShowExecution): Promise<LifecycleJobIdentity> {
  const current = await requireShowExecution(env, execution);
  const owner = current.value.owner!;
  return { job_id: execution.jobId, show_id: execution.showId, kind: owner.kind, action: owner.action,
    ...(owner.episode_id ? { episode_id: owner.episode_id } : {}), show_generation: execution.generation,
    request_sha256: owner.request_sha256 };
}

async function jobObject(env: LifecycleControlEnv, execution: ShowExecution, name: "status" | "progress"): Promise<R2ObjectBody | null> {
  const object = await env.CASTLOOP_BUCKET.get(`system/jobs/${execution.jobId}/${name}.toml`);
  if (object && object.size > 16384) throw new Error("Lifecycle job record exceeds the size limit");
  return object;
}

function checkedStatus(source: string, identity: LifecycleJobIdentity): LifecycleJobStatus {
  const value = parseJobStatus(source);
  if (value.schema_version !== 2 || !lifecycleJobMatches(value, identity)) throw new Error("Lifecycle status does not match its owner");
  return value;
}

function checkedProgress(source: string, identity: LifecycleJobIdentity): LifecycleProgress {
  const value = parseLifecycleProgress(source);
  if (!lifecycleJobMatches(value, identity)) throw new Error("Lifecycle progress does not match its owner");
  return value;
}

export async function readLifecycleJobJournal(env: LifecycleControlEnv, execution: ShowExecution): Promise<LifecycleJobJournal> {
  const identity = await requireIdentity(env, execution);
  const [status, progress] = await Promise.all([jobObject(env, execution, "status"), jobObject(env, execution, "progress")]);
  const result = { identity, status: status ? checkedStatus(await status.text(), identity) : null,
    progress: progress ? checkedProgress(await progress.text(), identity) : null };
  await requireIdentity(env, execution);
  return result;
}

export async function writeLifecycleProgress(env: LifecycleControlEnv, execution: ShowExecution, input: LifecycleProgress): Promise<void> {
  const identity = await requireIdentity(env, execution);
  const value = lifecycleProgressSchema.parse(input);
  if (!lifecycleJobMatches(value, identity)) throw new Error("Progress write does not match its owner");
  const existing = await jobObject(env, execution, "progress");
  if (existing) {
    const previous = checkedProgress(await existing.text(), identity);
    if (previous.phase === "finished") {
      const { updated_at: _previousTime, ...before } = previous;
      const { updated_at: _nextTime, ...after } = value;
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      throw new Error("Finished lifecycle progress cannot be changed");
    }
  }
  await requireIdentity(env, execution);
  const written = await env.CASTLOOP_BUCKET.put(`system/jobs/${execution.jobId}/progress.toml`, stringifyLifecycleProgress(value), {
    onlyIf: existing ? { etagMatches: existing.etag } : new Headers({ "If-None-Match": "*" }),
  });
  if (!written) throw new Error("Lifecycle progress write conflicted");
}

export async function writeLifecycleJobStatus(env: LifecycleControlEnv, execution: ShowExecution, input: LifecycleJobStatus): Promise<void> {
  const identity = await requireIdentity(env, execution);
  const value = lifecycleJobStatusSchema.parse(input);
  if (!lifecycleJobMatches(value, identity)) throw new Error("Status write does not match its owner");
  const existing = await jobObject(env, execution, "status");
  if (existing) {
    const previous = checkedStatus(await existing.text(), identity);
    if (["published", "completed", "abandoned"].includes(previous.state)) {
      if (JSON.stringify(previous) === JSON.stringify(value)) return;
      throw new Error("Terminal lifecycle status cannot be changed");
    }
  }
  if (value.state === "completed" || value.state === "published") {
    const progress = await jobObject(env, execution, "progress");
    if (!progress) throw new Error("Terminal status requires durable progress");
    const finished = checkedProgress(await progress.text(), identity);
    if (finished.phase !== "finished" || !finished.purge_confirmed) throw new Error("Terminal status requires finished, purged progress");
    const current = await requireShowExecution(env, execution);
    const episode = identity.kind === "episode" ? await readEpisodeLifecycle(env, identity.show_id, identity.episode_id!) : null;
    if ((identity.kind === "show" ? current.value.lifecycle : episode?.lifecycle) !== value.result_lifecycle ||
      (identity.kind === "episode" && episode?.last_job_id !== execution.jobId)) throw new Error("Terminal status does not match its target result");
  }
  await requireIdentity(env, execution);
  const written = await env.CASTLOOP_BUCKET.put(`system/jobs/${execution.jobId}/status.toml`, stringifyToml(value), {
    onlyIf: existing ? { etagMatches: existing.etag } : new Headers({ "If-None-Match": "*" }),
  });
  if (!written) throw new Error("Lifecycle status write conflicted");
}
