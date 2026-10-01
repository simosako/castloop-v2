import { stageControlRequest, stageDraftPrefix, stagePayloadKey, stageUploadProgressSchema, stageUploadRequestSchema } from "../packages/shared/src/index";
import type { StageUploadProgress, StageUploadRequest } from "../packages/shared/src/index";
import { claimShowOperation, controlRequestHash, readEpisodeLifecycle, requireOwnedOperation } from "./lifecycle-control";
import type { LifecycleControlEnv, OwnedShowControlSnapshot } from "./lifecycle-control";

export type StageOperation = { showId: string; operationId: string; generation: number };
export type StageUploadSnapshot = { request: StageUploadRequest; manifestHash: string; control: OwnedShowControlSnapshot };

export async function stageManifestHash(input: StageUploadRequest): Promise<string> {
  const value = stageUploadRequestSchema.parse(input);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readManifest(env: LifecycleControlEnv, operationId: string): Promise<StageUploadRequest> {
  const object = await env.CASTLOOP_BUCKET.get(`system/jobs/${operationId}/upload.json`);
  if (!object || object.size > 16384) throw new Error("Staging manifest is missing or oversized");
  return stageUploadRequestSchema.parse(await object.json<unknown>());
}

export async function requireStageUpload(env: LifecycleControlEnv, operation: StageOperation): Promise<StageUploadSnapshot> {
  const control = await requireOwnedOperation(env, operation.showId, operation.operationId, operation.generation);
  if (control.value.owner.action !== "stage" || control.value.owner.state !== "uploading") throw new Error("Operation does not own staging admission");
  const request = await readManifest(env, operation.operationId);
  if (request.operation_id !== operation.operationId || request.show_id !== operation.showId ||
    request.expected_show_generation + 1 !== operation.generation || await controlRequestHash(stageControlRequest(request)) !== control.value.owner.request_sha256) {
    throw new Error("Staging manifest does not match its admission owner");
  }
  if (request.kind === "show" ? !["draft", "active"].includes(control.value.lifecycle) : control.value.lifecycle !== "active") {
    throw new Error("Show lifecycle no longer permits staging");
  }
  if (request.kind === "episode") {
    const episode = await readEpisodeLifecycle(env, request.show_id, request.episode_id!);
    if (!episode || !["draft", "active"].includes(episode.lifecycle) || episode.generation !== request.expected_episode_generation) {
      throw new Error("Episode lifecycle no longer matches the staging request");
    }
  }
  if (await env.CASTLOOP_BUCKET.head(`${stageDraftPrefix(request)}/commit.json`)) throw new Error("Committed drafts cannot be uploaded again");
  return { request, manifestHash: await stageManifestHash(request), control };
}

export async function readStageUploadProgress(env: LifecycleControlEnv, operation: StageOperation,
  snapshot: StageUploadSnapshot): Promise<{ value: StageUploadProgress; etag: string } | null> {
  const object = await env.CASTLOOP_BUCKET.get(`system/jobs/${operation.operationId}/upload-progress.json`);
  if (!object) return null;
  if (object.size > 16384) throw new Error("Staging progress is oversized");
  const value = stageUploadProgressSchema.parse(await object.json<unknown>());
  if (value.operation_id !== operation.operationId || value.show_id !== operation.showId || value.show_generation !== operation.generation ||
    value.manifest_sha256 !== snapshot.manifestHash) throw new Error("Staging progress does not match its owner and manifest");
  return { value, etag: object.etag };
}

export async function writeStageUploadProgress(env: LifecycleControlEnv, operation: StageOperation, input: StageUploadProgress,
  verificationId?: string): Promise<void> {
  const snapshot = await requireStageUpload(env, operation);
  if (snapshot.control.value.owner.verification_id !== verificationId) throw new Error("Staging progress requires its current verification token");
  const value = stageUploadProgressSchema.parse(input);
  if (["verifying", "verified", "finished"].includes(value.phase) && !verificationId) throw new Error("Verification progress requires an active staging verification token");
  if (value.operation_id !== operation.operationId || value.show_id !== operation.showId || value.show_generation !== operation.generation ||
    value.manifest_sha256 !== snapshot.manifestHash) throw new Error("Staging progress write does not match its owner");
  const existing = await readStageUploadProgress(env, operation, snapshot);
  if (existing?.value.phase === "finished") {
    if (JSON.stringify(existing.value) === JSON.stringify(value)) return;
    throw new Error("Finished staging progress cannot be changed");
  }
  if (!existing && value.phase !== "ready") throw new Error("Staging progress must start ready");
  if (existing) {
    const transitions: Record<StageUploadProgress["phase"], StageUploadProgress["phase"][]> = {
      ready: ["ready", "uploading", "settled"], uploading: ["uploading", "settled"],
      settled: ["settled", "verifying", "finished"], verifying: ["verifying", "settled", "verified", "finished"],
      verified: ["verified", "settled", "finished"], finished: ["finished"],
    };
    if (!transitions[existing.value.phase].includes(value.phase) || existing.value.client_settled && !value.client_settled) {
      throw new Error("Staging progress cannot reopen PUT permission");
    }
  }
  const latest = await requireStageUpload(env, operation);
  if (latest.control.value.owner.verification_id !== verificationId) throw new Error("Staging verification token changed before progress was written");
  const written = await env.CASTLOOP_BUCKET.put(`system/jobs/${operation.operationId}/upload-progress.json`, JSON.stringify(value), {
    onlyIf: existing ? { etagMatches: existing.etag } : new Headers({ "If-None-Match": "*" }),
  });
  if (!written) throw new Error("Staging progress write conflicted");
}

export async function claimStageUpload(env: LifecycleControlEnv, input: unknown): Promise<StageOperation> {
  const request = stageUploadRequestSchema.parse(input);
  if (await env.CASTLOOP_BUCKET.head(`${stageDraftPrefix(request)}/commit.json`)) throw new Error("Committed drafts cannot be staged");
  const hash = await stageManifestHash(request);
  const written = await env.CASTLOOP_BUCKET.put(`system/jobs/${request.operation_id}/upload.json`, JSON.stringify(request), {
    onlyIf: new Headers({ "If-None-Match": "*" }),
  });
  if (!written && await stageManifestHash(await readManifest(env, request.operation_id)) !== hash) {
    throw new Error("Upload operation ID already has a different staging manifest");
  }
  await claimShowOperation(env, stageControlRequest(request));
  const operation = { showId: request.show_id, operationId: request.operation_id, generation: request.expected_show_generation + 1 };
  const snapshot = await requireStageUpload(env, operation);
  const existing = await readStageUploadProgress(env, operation, snapshot);
  if (!existing) await writeStageUploadProgress(env, operation, { schema_version: 1, operation_id: operation.operationId,
    show_id: operation.showId, show_generation: operation.generation, manifest_sha256: hash, phase: "ready", client_settled: false, verified_assets: [] });
  return operation;
}

export async function beginStageUpload(env: LifecycleControlEnv, operation: StageOperation): Promise<Array<{ key: string; length: number; sha256: string }>> {
  const snapshot = await requireStageUpload(env, operation);
  const progress = await readStageUploadProgress(env, operation, snapshot);
  if (!progress || progress.value.phase !== "ready") throw new Error("Staging PUTs were already started; confirm they ended before recovery");
  await requireStageUpload(env, operation);
  const next = stageUploadProgressSchema.parse({ ...progress.value, phase: "uploading" });
  const written = await env.CASTLOOP_BUCKET.put(`system/jobs/${operation.operationId}/upload-progress.json`, JSON.stringify(next), {
    onlyIf: { etagMatches: progress.etag },
  });
  if (!written) throw new Error("Another caller already started this staging upload");
  return snapshot.request.payloads.map((payload) => ({ key: stagePayloadKey(snapshot.request, payload.asset),
    length: payload.length_bytes, sha256: payload.sha256 }));
}

export async function settleStageUpload(env: LifecycleControlEnv, operation: StageOperation,
  evidence: { put_requests_settled: true; no_more_puts: true }): Promise<void> {
  if (evidence.put_requests_settled !== true || evidence.no_more_puts !== true) throw new Error("Staging PUT completion and no further writes must be explicitly confirmed");
  const snapshot = await requireStageUpload(env, operation);
  const progress = await readStageUploadProgress(env, operation, snapshot);
  if (!progress) throw new Error("Staging upload has no durable progress");
  if (progress.value.client_settled) return;
  if (progress.value.phase !== "ready" && progress.value.phase !== "uploading") throw new Error("Staging upload cannot be settled from this phase");
  await writeStageUploadProgress(env, operation, { ...progress.value, phase: "settled", client_settled: true });
}
