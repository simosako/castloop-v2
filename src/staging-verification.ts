import { lifecycleFailureForPhase, lifecycleJobStatusSchema, parseEpisodeDraft, parseEpisodeRevision, parseJobStatus,
  parseShowControl, parseShowMetadata, stageControlRequest, stagePayloadKey, stageUploadProgressSchema, stageUploadRequestSchema,
  stringifyToml } from "../packages/shared/src/index";
import type { LifecycleJobStatus, StagePayload, StageUploadProgress } from "../packages/shared/src/index";
import { controlRequestHash, readEpisodeLifecycle, readShowControl } from "./lifecycle-control";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { readStageUploadProgress, requireStageUpload, stageManifestHash, writeStageUploadProgress } from "./staging-upload";
import type { StageOperation, StageUploadSnapshot } from "./staging-upload";

export type StageVerification = StageOperation & { verificationId: string };

async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function acquireStageVerification(env: LifecycleControlEnv, operation: StageOperation): Promise<StageVerification> {
  const snapshot = await requireStageUpload(env, operation);
  const progress = await readStageUploadProgress(env, operation, snapshot);
  if (!progress?.value.client_settled) throw new Error("Staging PUTs must settle before verification or admission release");
  if (snapshot.control.value.owner.verification_id) throw new Error("Another staging verification is still running");
  const verificationId = crypto.randomUUID();
  const value = parseShowControl({ ...snapshot.control.value, owner: { ...snapshot.control.value.owner, verification_id: verificationId } });
  const written = await env.CASTLOOP_BUCKET.put(`system/show-publications/${operation.showId}.json`, JSON.stringify(value), {
    onlyIf: { etagMatches: snapshot.control.etag },
  });
  if (!written) throw new Error("Staging admission changed before verification started");
  return { ...operation, verificationId };
}

export async function requireStageVerification(env: LifecycleControlEnv, verification: StageVerification): Promise<StageUploadSnapshot> {
  const snapshot = await requireStageUpload(env, verification);
  if (snapshot.control.value.owner.verification_id !== verification.verificationId) throw new Error("Invocation no longer owns its staging verification token");
  const progress = await readStageUploadProgress(env, verification, snapshot);
  if (!progress?.value.client_settled) throw new Error("Staging verification has no durable client settlement");
  return snapshot;
}

export async function releaseStageVerification(env: LifecycleControlEnv, verification: StageVerification): Promise<void> {
  const snapshot = await requireStageUpload(env, verification);
  if (!snapshot.control.value.owner.verification_id) return;
  if (snapshot.control.value.owner.verification_id !== verification.verificationId) throw new Error("Invocation no longer owns its staging verification token");
  const { verification_id: _token, ...owner } = snapshot.control.value.owner;
  const value = parseShowControl({ ...snapshot.control.value, owner });
  const written = await env.CASTLOOP_BUCKET.put(`system/show-publications/${verification.showId}.json`, JSON.stringify(value), {
    onlyIf: { etagMatches: snapshot.control.etag },
  });
  if (!written) throw new Error("Staging admission changed before verification ended");
}

async function verifyPayload(env: LifecycleControlEnv, verification: StageVerification, snapshot: StageUploadSnapshot,
  payload: StagePayload): Promise<StageUploadProgress["verified_assets"][number]> {
  await requireStageVerification(env, verification);
  const key = stagePayloadKey(snapshot.request, payload.asset);
  const head = await env.CASTLOOP_BUCKET.head(key);
  if (!head || head.size !== payload.length_bytes) throw new Error("Uploaded staging size does not match its manifest");
  const progress = (await readStageUploadProgress(env, verification, snapshot))!.value;
  const receipt = progress.readback_receipts?.find((item) => item.asset === payload.asset);
  if (!receipt || receipt.sha256 !== payload.sha256 || receipt.length_bytes !== payload.length_bytes ||
    head.etag !== receipt.etag || head.version !== receipt.version) {
    throw new Error("Uploaded staging object does not match its retained full readback receipt");
  }
  if (payload.asset === "audio") {
    await requireStageVerification(env, verification);
    return receipt;
  }
  const object = await env.CASTLOOP_BUCKET.get(key, { onlyIf: { etagMatches: head.etag } });
  if (!object || !("body" in object) || !object.body || object.etag !== head.etag || object.version !== head.version || object.size !== payload.length_bytes) {
    if (object && "body" in object && object.body) await object.body.cancel();
    throw new Error("Uploaded staging object changed before verification");
  }
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== payload.length_bytes) throw new Error("Uploaded staging contents have a different size");
  const checksum = await hashBytes(bytes);
  if (checksum !== payload.sha256) throw new Error("Uploaded staging checksum does not match its manifest");
  if (payload.asset === "show_metadata") {
    const show = parseShowMetadata(new TextDecoder().decode(bytes));
    if (show.show_id !== snapshot.request.show_id) throw new Error("Staged Show metadata targets another Show");
    const extension = show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
    if (!snapshot.request.payloads.some((item) => item.asset === `cover_${extension}`)) throw new Error("Staged Show metadata and cover extension differ");
    const published = await env.CASTLOOP_BUCKET.get(`system/shows/${snapshot.request.show_id}/show.toml`);
    if (!published && snapshot.control.value.lifecycle === "active") throw new Error("Active Show has no published snapshot");
    if (published) {
      if (published.size > 1_000_000) throw new Error("Published Show metadata is oversized");
      const previous = parseShowMetadata(await published.text());
      if (previous.show_id !== show.show_id || (previous.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg") !== extension) {
        throw new Error("Changing a published Show cover extension is not supported");
      }
    }
  } else if (payload.asset === "episode_metadata") {
    const episode = parseEpisodeDraft(new TextDecoder().decode(bytes));
    if (episode.episode_id !== snapshot.request.episode_id) throw new Error("Staged Episode metadata targets another Episode");
    const published = await env.CASTLOOP_BUCKET.get(`public/episodes/${snapshot.request.show_id}/${snapshot.request.episode_id}/metadata.toml`);
    const lifecycle = await readEpisodeLifecycle(env, snapshot.request.show_id, snapshot.request.episode_id!);
    if (!published && lifecycle?.lifecycle === "active") throw new Error("Active Episode has no published snapshot");
    if (published) {
      if (published.size > 1_000_000) throw new Error("Published Episode metadata is oversized");
      const previous = parseEpisodeRevision(await published.text());
      if (previous.episode_id !== episode.episode_id || previous.guid !== episode.guid || previous.published_at !== episode.published_at) {
        throw new Error("Episode identity and published_at must remain unchanged");
      }
    }
  } else {
    const cover = new Uint8Array(bytes);
    const valid = payload.asset === "cover_jpg" ? cover.length >= 3 && cover[0] === 255 && cover[1] === 216 && cover[2] === 255 :
      cover.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => cover[index] === byte);
    if (!valid) throw new Error("Staged cover contents do not match their image type");
  }
  await requireStageVerification(env, verification);
  return { asset: payload.asset, etag: object.etag, version: object.version, length_bytes: payload.length_bytes, sha256: checksum };
}

function matchesStatus(status: LifecycleJobStatus, verification: StageVerification, snapshot: StageUploadSnapshot): boolean {
  return status.action === "stage" && status.job_id === verification.operationId && status.show_id === verification.showId &&
    status.show_generation === verification.generation && status.kind === snapshot.request.kind && status.episode_id === snapshot.request.episode_id &&
    status.request_sha256 === snapshot.control.value.owner.request_sha256;
}

async function writeStatus(env: LifecycleControlEnv, verification: StageVerification, state: "processing" | "retrying" | "completed"): Promise<void> {
  const snapshot = await requireStageVerification(env, verification);
  const value = lifecycleJobStatusSchema.parse({ schema_version: 2, job_id: verification.operationId, show_id: verification.showId,
    kind: snapshot.request.kind, ...(snapshot.request.episode_id ? { episode_id: snapshot.request.episode_id } : {}), action: "stage",
    show_generation: verification.generation, request_sha256: snapshot.control.value.owner.request_sha256,
    state, phase: state === "completed" ? "finished" : "validating", ...(state === "retrying" ? lifecycleFailureForPhase("validating") : {}) });
  const key = `system/jobs/${verification.operationId}/status.toml`;
  const existing = await env.CASTLOOP_BUCKET.get(key);
  if (existing) {
    if (existing.size > 16384) throw new Error("Staging status is oversized");
    const previous = parseJobStatus(await existing.text());
    if (previous.schema_version !== 2 || !matchesStatus(previous, verification, snapshot)) throw new Error("Staging status does not match its owner");
    if (["completed", "published", "abandoned"].includes(previous.state)) {
      if (JSON.stringify(previous) === JSON.stringify(value)) return;
      throw new Error("Terminal staging status cannot be changed");
    }
  }
  if (state === "completed") {
    const progress = await readStageUploadProgress(env, verification, snapshot);
    if (progress?.value.phase !== "finished") throw new Error("Completed staging requires durable finished progress");
  }
  await requireStageVerification(env, verification);
  const written = await env.CASTLOOP_BUCKET.put(key, stringifyToml(value), {
    onlyIf: existing ? { etagMatches: existing.etag } : new Headers({ "If-None-Match": "*" }),
  });
  if (!written) throw new Error("Staging status write conflicted");
}

async function finishVerification(env: LifecycleControlEnv, verification: StageVerification): Promise<void> {
  const snapshot = await requireStageVerification(env, verification);
  const progress = (await readStageUploadProgress(env, verification, snapshot))?.value;
  const statusObject = await env.CASTLOOP_BUCKET.get(`system/jobs/${verification.operationId}/status.toml`);
  if (!progress || progress.phase !== "finished" || !progress.outcome || !statusObject || statusObject.size > 16384) {
    throw new Error("Staging has no durable completion proof");
  }
  const status = parseJobStatus(await statusObject.text());
  if (status.schema_version !== 2 || status.state !== "completed" || !matchesStatus(status, verification, snapshot)) {
    throw new Error("Completed staging status does not match its owner");
  }
  if (progress.outcome === "staged") {
    if (progress.verified_assets.length !== snapshot.request.payloads.length) throw new Error("Staging payload verification is incomplete");
    for (const payload of snapshot.request.payloads) {
      const verified = progress.verified_assets.find((item) => item.asset === payload.asset);
      const head = await env.CASTLOOP_BUCKET.head(stagePayloadKey(snapshot.request, payload.asset));
      if (!verified || verified.sha256 !== payload.sha256 || verified.length_bytes !== payload.length_bytes ||
        !head || head.size !== payload.length_bytes || head.etag !== verified.etag || !verified.version || head.version !== verified.version) {
        throw new Error("Verified staging payload changed before completion");
      }
    }
  }
  const latest = await requireStageVerification(env, verification);
  const { owner: _owner, ...withoutOwner } = latest.control.value;
  const value = parseShowControl({ ...withoutOwner, last_finished_upload: { operation_id: verification.operationId,
    generation: verification.generation, verification_id: verification.verificationId,
    request_sha256: snapshot.control.value.owner.request_sha256, manifest_sha256: snapshot.manifestHash, outcome: progress.outcome } });
  const written = await env.CASTLOOP_BUCKET.put(`system/show-publications/${verification.showId}.json`, JSON.stringify(value), {
    onlyIf: { etagMatches: latest.control.etag },
  });
  if (!written) throw new Error("Staging admission changed before completion");
}

async function finishedOutcome(env: LifecycleControlEnv, operation: StageOperation): Promise<"staged" | "aborted" | null> {
  const control = await readShowControl(env, operation.showId);
  const receipt = control?.value.last_finished_upload;
  if (!receipt || receipt.operation_id !== operation.operationId || receipt.generation !== operation.generation) return null;
  const object = await env.CASTLOOP_BUCKET.get(`system/jobs/${operation.operationId}/upload.json`);
  if (!object || object.size > 16384) throw new Error("Completed staging manifest is missing or oversized");
  const request = stageUploadRequestSchema.parse(await object.json<unknown>());
  if (request.operation_id !== operation.operationId || request.show_id !== operation.showId ||
    request.expected_show_generation + 1 !== operation.generation || await stageManifestHash(request) !== receipt.manifest_sha256 ||
    await controlRequestHash(stageControlRequest(request)) !== receipt.request_sha256) throw new Error("Completed staging receipt does not match its manifest");
  return receipt.outcome;
}

export async function runStageVerification(env: LifecycleControlEnv, operation: StageOperation, outcome: "staged" | "aborted"): Promise<void> {
  if (outcome !== "staged" && outcome !== "aborted") throw new Error("Invalid staging outcome");
  const finished = await finishedOutcome(env, operation);
  if (finished) {
    if (finished !== outcome) throw new Error("Staging already finished with a different outcome");
    return;
  }
  const verification = await acquireStageVerification(env, operation);
  try {
    const snapshot = await requireStageVerification(env, verification);
    let progress = (await readStageUploadProgress(env, verification, snapshot))!.value;
    if (progress.phase !== "finished") {
      await writeStatus(env, verification, "processing");
      const { reason_code: _reason, ...cleanProgress } = progress;
      progress = cleanProgress;
      if (outcome === "staged" && progress.phase !== "verified") {
        await writeStageUploadProgress(env, verification, { ...progress, phase: "verifying", verified_assets: [] }, verification.verificationId);
        const verified: StageUploadProgress["verified_assets"] = [];
        for (const payload of snapshot.request.payloads) verified.push(await verifyPayload(env, verification, snapshot, payload));
        progress = stageUploadProgressSchema.parse({ ...progress, phase: "verified", verified_assets: verified });
        await writeStageUploadProgress(env, verification, progress, verification.verificationId);
      }
      progress = stageUploadProgressSchema.parse({ ...progress, phase: "finished", outcome, verified_assets: outcome === "aborted" ? [] : progress.verified_assets });
      await writeStageUploadProgress(env, verification, progress, verification.verificationId);
    } else if (progress.outcome !== outcome) throw new Error("Staging already finished with a different outcome");
    await writeStatus(env, verification, "completed");
    await finishVerification(env, verification);
  } catch (error) {
    if (await finishedOutcome(env, operation) === outcome) return;
    const snapshot = await requireStageVerification(env, verification);
    const progress = (await readStageUploadProgress(env, verification, snapshot))!.value;
    if (progress.phase !== "finished") {
      await writeStageUploadProgress(env, verification, { ...progress, phase: "settled", verified_assets: [], reason_code: "validation_failed" }, verification.verificationId);
      await writeStatus(env, verification, "retrying");
    }
    await releaseStageVerification(env, verification);
    throw error;
  }
}
