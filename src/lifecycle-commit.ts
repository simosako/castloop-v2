import { lifecycleCommitKey, lifecycleCommitSchema, parseControlRequest, parseLifecycleCommitKey } from "../packages/shared/src/index";
import type { LifecycleCommit } from "../packages/shared/src/index";
import { controlRequestHash, requireOwnedOperation } from "./lifecycle-control";
import type { LifecycleControlEnv } from "./lifecycle-control";

export class InvalidLifecycleCommit extends Error {
  constructor() { super("Lifecycle commit does not match its frozen request and target"); }
}

export async function readLifecycleCommit(env: LifecycleControlEnv, key: string): Promise<LifecycleCommit | null> {
  const target = parseLifecycleCommitKey(key);
  if (!target) throw new InvalidLifecycleCommit();
  const object = await env.CASTLOOP_BUCKET.get(key);
  if (!object) return null;
  if (object.size > 16384) throw new InvalidLifecycleCommit();
  const source = await object.text();
  let marker: LifecycleCommit;
  try { marker = lifecycleCommitSchema.parse(JSON.parse(source)); }
  catch { throw new InvalidLifecycleCommit(); }
  if (marker.kind !== target.kind || marker.show_id !== target.show_id || marker.episode_id !== target.episode_id ||
    marker.job_id !== target.job_id) throw new InvalidLifecycleCommit();
  const frozen = await env.CASTLOOP_BUCKET.get(`system/jobs/${marker.job_id}/request.toml`);
  if (!frozen || frozen.size > 16384) throw new InvalidLifecycleCommit();
  const frozenSource = await frozen.text();
  let request;
  try { request = parseControlRequest(frozenSource); }
  catch { throw new InvalidLifecycleCommit(); }
  if (request.job_id !== marker.job_id || request.show_id !== marker.show_id || request.kind !== marker.kind ||
    request.episode_id !== marker.episode_id || request.action !== marker.action ||
    request.expected_show_generation + 1 !== marker.show_generation || await controlRequestHash(request) !== marker.request_sha256) {
    throw new InvalidLifecycleCommit();
  }
  return marker;
}

export async function commitOwnedLifecycleOperation(env: LifecycleControlEnv,
  operation: { showId: string; jobId: string; generation: number }): Promise<{ key: string; marker: LifecycleCommit; created: boolean }> {
  const current = await requireOwnedOperation(env, operation.showId, operation.jobId, operation.generation);
  const owner = current.value.owner;
  const marker = lifecycleCommitSchema.parse({ schema_version: 1, job_id: operation.jobId, show_id: operation.showId,
    kind: owner.kind, ...(owner.episode_id ? { episode_id: owner.episode_id } : {}), action: owner.action,
    show_generation: operation.generation, request_sha256: owner.request_sha256 });
  const key = lifecycleCommitKey({ kind: marker.kind, show_id: marker.show_id, job_id: marker.job_id,
    ...(marker.episode_id ? { episode_id: marker.episode_id } : {}) });
  const existing = await readLifecycleCommit(env, key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(marker)) throw new InvalidLifecycleCommit();
    return { key, marker: existing, created: false };
  }
  if (owner.state !== "reserved" || owner.execution_id) throw new Error("Only an unstarted reserved operation can create its lifecycle commit");
  const latest = await requireOwnedOperation(env, operation.showId, operation.jobId, operation.generation);
  if (latest.value.owner.state !== "reserved" || latest.value.owner.execution_id) throw new Error("Lifecycle processing started before its commit");
  const written = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(marker), { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (written) return { key, marker, created: true };
  const raced = await readLifecycleCommit(env, key);
  if (!raced || JSON.stringify(raced) !== JSON.stringify(marker)) throw new InvalidLifecycleCommit();
  return { key, marker: raced, created: false };
}
