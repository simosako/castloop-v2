import { lifecycleAdminResponseSchema, lifecycleCommitKey, parseControlRequest, parseJobStatus, parseLifecycleProgress } from "../packages/shared/src/index";
import type { LifecycleAdminResponse, LifecycleCommit } from "../packages/shared/src/index";
import { readLifecycleCommit } from "./lifecycle-commit";
import { controlRequestHash, readShowControl } from "./lifecycle-control";
import type { LifecycleReadEnv } from "./lifecycle-control";
import { lifecycleJobMatches } from "./lifecycle-job-store";

export type LifecycleJobInspection = Extract<LifecycleAdminResponse, { result: "status" }>;

export async function inspectLifecycleJob(env: LifecycleReadEnv, serviceId: string, operation: LifecycleCommit): Promise<LifecycleJobInspection> {
  const requestKey = `system/jobs/${operation.job_id}/request.toml`;
  const statusKey = `system/jobs/${operation.job_id}/status.toml`;
  const progressKey = `system/jobs/${operation.job_id}/progress.toml`;
  const key = lifecycleCommitKey({ kind: operation.kind, show_id: operation.show_id, job_id: operation.job_id,
    ...(operation.episode_id ? { episode_id: operation.episode_id } : {}) });
  const before = await readShowControl(env, operation.show_id);
  if (!before) throw new Error("Lifecycle inspection has no retained Show control");
  const records = await Promise.all([env.CASTLOOP_BUCKET.get(requestKey), env.CASTLOOP_BUCKET.get(statusKey), env.CASTLOOP_BUCKET.get(progressKey)]);
  const [requestObject, statusObject, progressObject] = records;
  if (!requestObject || records.some((object) => object && (object.size < 1 || object.size > 16384))) {
    throw new Error("Lifecycle inspection record is missing or oversized");
  }
  const request = parseControlRequest(await requestObject.text());
  if (!lifecycleJobMatches({ ...request, show_generation: request.expected_show_generation + 1, request_sha256: await controlRequestHash(request) }, operation)) {
    throw new Error("Lifecycle inspection request does not match its frozen target");
  }
  const marker = await readLifecycleCommit(env, key);
  if (marker && JSON.stringify(marker) !== JSON.stringify(operation)) throw new Error("Lifecycle inspection marker differs from its request");
  const status = statusObject ? parseJobStatus(await statusObject.text()) : null;
  if (status && status.schema_version !== 2) throw new Error("Lifecycle inspection cannot adopt a legacy job status");
  const progress = progressObject ? parseLifecycleProgress(await progressObject.text()) : null;
  const after = await readShowControl(env, operation.show_id);
  const currentObjects = await Promise.all([requestKey, statusKey, progressKey].map((name) => env.CASTLOOP_BUCKET.head(name)));
  if (before?.etag !== after?.etag || JSON.stringify(before?.value) !== JSON.stringify(after?.value) ||
    records.some((object, index) => object?.etag !== currentObjects[index]?.etag || object?.size !== currentObjects[index]?.size)) {
    throw new Error("Lifecycle job changed during its read-only inspection");
  }
  const control = after?.value;
  const held = control?.generation === operation.show_generation && control.owner?.job_id === operation.job_id;
  if (held && (!control?.owner || control.owner.request_sha256 !== operation.request_sha256 || control.owner.kind !== operation.kind ||
    control.owner.action !== operation.action || control.owner.episode_id !== operation.episode_id)) {
    throw new Error("Lifecycle inspection owner differs from its retained request");
  }
  const released = control?.last_finished_operation?.job_id === operation.job_id && control.last_finished_operation.generation === operation.show_generation;
  if (released && control?.last_finished_operation?.request_sha256 !== operation.request_sha256) {
    throw new Error("Lifecycle completion receipt differs from its retained request");
  }
  const result = lifecycleAdminResponseSchema.parse({ schema_version: 1, service_id: serviceId, result: "status", operation, status, progress,
    ownership: held ? "held" : released ? "released" : control && control.generation < operation.show_generation ? "unclaimed" : "superseded",
    execution_active: held && !!control?.owner?.execution_id,
    marker_present: marker !== null, authorizes_retry: false });
  if (result.result !== "status") throw new Error("Invalid lifecycle inspection response");
  return result;
}
