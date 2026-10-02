import { parseControlRequest, parseJobStatus, stageControlRequest, stageDraftPrefix, stageUploadProgressSchema,
  stageUploadRequestSchema, stagingAdminResponseSchema } from "../packages/shared/src/index";
import type { StageUploadRequest, StagingAdminResponse } from "../packages/shared/src/index";
import { controlRequestHash, readShowControl } from "./lifecycle-control";
import type { LifecycleReadEnv } from "./lifecycle-control";
import { stageManifestHash } from "./staging-upload";

export async function inspectStageUpload(env: LifecycleReadEnv, serviceId: string, input: StageUploadRequest):
  Promise<Extract<StagingAdminResponse, { result: "status" }>> {
  const upload = stageUploadRequestSchema.parse(input);
  const generation = upload.expected_show_generation + 1;
  const manifestHash = await stageManifestHash(upload);
  const requestHash = await controlRequestHash(stageControlRequest(upload));
  const keys = [`system/jobs/${upload.operation_id}/upload.json`, `system/jobs/${upload.operation_id}/request.toml`,
    `system/jobs/${upload.operation_id}/upload-progress.json`, `system/jobs/${upload.operation_id}/status.toml`];
  const markerKey = `${stageDraftPrefix(upload)}/commit.json`;
  const before = await readShowControl(env, upload.show_id);
  if (!before) throw new Error("Staging inspection requires retained Show control");
  const records = await Promise.all(keys.map((key) => env.CASTLOOP_BUCKET.get(key)));
  const marker = await env.CASTLOOP_BUCKET.head(markerKey);
  const [manifestObject, requestObject, progressObject, statusObject] = records;
  if (!manifestObject || records.some((object) => object && (object.size < 1 || object.size > 16384))) {
    throw new Error("Staging inspection record is missing or oversized");
  }
  if (await stageManifestHash(stageUploadRequestSchema.parse(await manifestObject.json<unknown>())) !== manifestHash) {
    throw new Error("Staging inspection manifest differs from its frozen input");
  }
  if (requestObject && await controlRequestHash(parseControlRequest(await requestObject.text())) !== requestHash) {
    throw new Error("Staging inspection control request differs from its manifest");
  }
  const progress = progressObject ? stageUploadProgressSchema.parse(await progressObject.json<unknown>()) : null;
  const status = statusObject ? parseJobStatus(await statusObject.text()) : null;
  if (status && status.schema_version !== 2) throw new Error("Staging inspection cannot adopt a legacy status");
  const after = await readShowControl(env, upload.show_id);
  const current = await Promise.all([...keys, markerKey].map((key) => env.CASTLOOP_BUCKET.head(key)));
  if (!after || before.etag !== after.etag || JSON.stringify(before.value) !== JSON.stringify(after.value) ||
    [...records, marker].some((object, index) => object?.etag !== current[index]?.etag || object?.size !== current[index]?.size)) {
    throw new Error("Staging records changed during their read-only inspection");
  }
  const control = after.value;
  const held = control.generation === generation && control.owner?.job_id === upload.operation_id;
  if (held && (control.owner?.action !== "stage" || control.owner.state !== "uploading" || control.owner.kind !== upload.kind ||
    control.owner.episode_id !== upload.episode_id || control.owner.request_sha256 !== requestHash)) {
    throw new Error("Staging inspection owner differs from its manifest");
  }
  const receipt = control.last_finished_upload;
  const released = receipt?.operation_id === upload.operation_id && receipt.generation === generation;
  if (released && (receipt.request_sha256 !== requestHash || receipt.manifest_sha256 !== manifestHash || receipt.outcome !== progress?.outcome)) {
    throw new Error("Staging completion receipt differs from its retained evidence");
  }
  if (!requestObject && (held || released || progress || status)) throw new Error("Owned staging inspection has no frozen control request");
  const value = stagingAdminResponseSchema.parse({ schema_version: 1, service_id: serviceId, result: "status", upload,
    operation: { show_id: upload.show_id, operation_id: upload.operation_id, show_generation: generation }, manifest_sha256: manifestHash,
    request_sha256: requestHash, progress, status, ownership: held ? "held" : released ? "released" : control.generation < generation ? "unclaimed" : "superseded",
    verification_active: held && !!control.owner?.verification_id, draft_committed: marker !== null,
    authorizes_put: false, authorizes_recovery: false });
  if (value.result !== "status") throw new Error("Invalid staging inspection result");
  return value;
}
