import { lifecycleCommitKey, parseLifecycleCommitKey, validateId } from "../packages/shared/src/index";
import type { LifecycleCommitTarget } from "../packages/shared/src/index";

export type QueueDelivery = { family: "publication" | "lifecycle"; key: string; target: LifecycleCommitTarget };
type DeadLetterEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "put"> };
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function parseQueueDelivery(body: unknown): QueueDelivery | null {
  if (!body || typeof body !== "object" || !("object" in body) || !body.object || typeof body.object !== "object" ||
    !("key" in body.object) || typeof body.object.key !== "string") return null;
  const key = body.object.key;
  if (key.length > 512) return null;
  const lifecycle = parseLifecycleCommitKey(key);
  if (lifecycle) return { family: "lifecycle", key: lifecycleCommitKey(lifecycle), target: lifecycle };
  const parts = key.split("/");
  const show = parts.length === 5 && parts[1] === "shows";
  const episode = parts.length === 6 && parts[1] === "episodes";
  if (parts[0] !== "staging" || parts.at(-1) !== "commit.json" || (!show && !episode)) return null;
  const jobId = parts.at(-2)!;
  if (!JOB_ID.test(jobId)) return null;
  try {
    const target: LifecycleCommitTarget = { kind: show ? "show" : "episode", show_id: validateId(parts[2], "show"), job_id: jobId,
      ...(episode ? { episode_id: validateId(parts[3], "episode") } : {}) };
    return { family: "publication", key, target };
  } catch { return null; }
}

export async function recordDeadLetterDelivery(env: DeadLetterEnv, message: { id: string; body: unknown }): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(message.id)) throw new Error("Invalid dead-letter message identifier");
  const delivery = parseQueueDelivery(message.body);
  if (!delivery) {
    await env.CASTLOOP_BUCKET.put(`system/dlq/unmatched/${message.id}.json`, JSON.stringify({
      schema_version: 1, reason_code: "unmatched_queue_delivery",
    }));
    return;
  }
  const key = `system/jobs/${delivery.target.job_id}/dlq.json`;
  const written = await env.CASTLOOP_BUCKET.put(key, JSON.stringify({ key: delivery.key }), {
    onlyIf: new Headers({ "If-None-Match": "*" }),
  });
  if (written) return;
  const existing = await env.CASTLOOP_BUCKET.get(key);
  if (!existing || existing.size > 16384) throw new Error("Dead-letter marker is missing or oversized");
  const source = await existing.text();
  let marker: unknown;
  try { marker = JSON.parse(source); }
  catch { throw new Error("Dead-letter marker is invalid"); }
  if (!marker || typeof marker !== "object" || Array.isArray(marker) || Object.keys(marker).length !== 1 ||
    !("key" in marker) || marker.key !== delivery.key) throw new Error("Dead-letter marker belongs to a different delivery");
}
