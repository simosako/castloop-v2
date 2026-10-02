import { episodeCommitSchema, parseControlRequest, parseJobStatus, parseLifecycleProgress, publicationAdminResponseSchema,
  publicationCommitKey, publicationManifestHash, publicationRequestSchema, showCommitSchema } from "../packages/shared/src/index";
import type { PublicationAdminResponse, PublicationRequest } from "../packages/shared/src/index";
import { controlRequestHash, readShowControl } from "./lifecycle-control";
import type { LifecycleReadEnv } from "./lifecycle-control";

export async function inspectPublication(env: LifecycleReadEnv, serviceId: string, input: PublicationRequest):
  Promise<Extract<PublicationAdminResponse, { result: "status" }>> {
  const frozen = publicationRequestSchema.parse(input);
  const request = frozen.request;
  const generation = request.expected_show_generation + 1;
  const hash = await publicationManifestHash(frozen);
  const requestHash = await controlRequestHash(request);
  const keys = [`system/jobs/${request.job_id}/publication.json`, `system/jobs/${request.job_id}/request.toml`,
    `system/jobs/${request.job_id}/status.toml`, `system/jobs/${request.job_id}/progress.toml`, publicationCommitKey(frozen.commit)];
  const before = await readShowControl(env, request.show_id);
  if (!before) throw new Error("Publication inspection requires retained Show control");
  const records = await Promise.all(keys.map((key) => env.CASTLOOP_BUCKET.get(key)));
  const [manifestObject, requestObject, statusObject, progressObject, markerObject] = records;
  if (!manifestObject || records.some((object) => object && (object.size < 1 || object.size > 16384))) {
    throw new Error("Publication inspection record is missing or oversized");
  }
  if (await publicationManifestHash(publicationRequestSchema.parse(await manifestObject.json<unknown>())) !== hash ||
    requestObject && await controlRequestHash(parseControlRequest(await requestObject.text())) !== requestHash) {
    throw new Error("Publication inspection manifest/control request differs from its frozen input");
  }
  if (markerObject) {
    const source = await markerObject.json<unknown>();
    const marker = frozen.commit.kind === "show" ? showCommitSchema.parse(source) : episodeCommitSchema.parse(source);
    if (JSON.stringify(marker) !== JSON.stringify(frozen.commit)) throw new Error("Publication inspection marker differs from its frozen commit");
  }
  const status = statusObject ? parseJobStatus(await statusObject.text()) : null;
  if (status && status.schema_version !== 2) throw new Error("Publication inspection cannot adopt a legacy status");
  const progress = progressObject ? parseLifecycleProgress(await progressObject.text()) : null;
  const after = await readShowControl(env, request.show_id);
  const current = await Promise.all(keys.map((key) => env.CASTLOOP_BUCKET.head(key)));
  if (!after || before.etag !== after.etag || JSON.stringify(before.value) !== JSON.stringify(after.value) ||
    records.some((object, index) => object?.etag !== current[index]?.etag || object?.size !== current[index]?.size)) {
    throw new Error("Publication records changed during their read-only inspection");
  }
  const control = after.value;
  const held = control.generation === generation && control.owner?.job_id === request.job_id;
  if (held && (control.owner?.action !== "publish" || !["reserved", "processing"].includes(control.owner.state) ||
    control.owner.kind !== request.kind || control.owner.episode_id !== request.episode_id || control.owner.request_sha256 !== requestHash)) {
    throw new Error("Publication inspection owner differs from its frozen request");
  }
  const receipt = control.last_finished_operation;
  const released = receipt?.job_id === request.job_id && receipt.generation === generation;
  if (released && receipt.request_sha256 !== requestHash) throw new Error("Publication completion receipt differs from its frozen request");
  if (!requestObject && (held || released || status || progress || markerObject)) throw new Error("Owned publication has no frozen control request");
  const value = publicationAdminResponseSchema.parse({ schema_version: 1, service_id: serviceId, result: "status", publication: frozen,
    operation: { show_id: request.show_id, job_id: request.job_id, show_generation: generation }, manifest_sha256: hash, request_sha256: requestHash,
    status, progress, ownership: held ? "held" : released ? "released" : control.generation < generation ? "unclaimed" : "superseded",
    execution_active: held && !!control.owner?.execution_id, marker_present: markerObject !== null, staging_verified: false, authorizes_recovery: false });
  if (value.result !== "status") throw new Error("Invalid publication inspection result");
  return value;
}
