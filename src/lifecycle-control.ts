import { controlRequestSchema, parseControlRequest, parseEpisodeLifecycle, parseJobStatus,
  parseLifecycleProgress, parseShowControl,
  permitsControlAction, sha256Hex, stringifyLifecycleToml, validateId } from "../packages/shared/src/index";
import type { ControlRequest, EpisodeLifecycle, ShowControl } from "../packages/shared/src/index";
import { putPublicDeliveryRecord } from "./public-delivery-records";
import { requireShowReservationReady } from "./show-reservation-record";

const VERIFIED_OPERATION = Symbol("verifiedShowOperation");
const VERIFIED_CONTROL_REQUEST = Symbol("verifiedControlRequest");
const VERIFIED_COMMIT_CONTROL = Symbol("verifiedCommitControl");
type VerifiedControlRequest = Readonly<{ bucket: LifecycleControlEnv["CASTLOOP_BUCKET"]; request: Readonly<ControlRequest>;
  hash: string; reservationId: string | undefined }>;
type VerifiedOperation = Readonly<{ bucket: LifecycleControlEnv["CASTLOOP_BUCKET"]; request: Readonly<ControlRequest>;
  hash: string; reservationId: string | undefined; executionId?: string; verificationId?: string }>;
export type LifecycleControlEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "put" | "head">;
  [VERIFIED_OPERATION]?: VerifiedOperation;
  [VERIFIED_COMMIT_CONTROL]?: VerifiedControlRequest & { isActive: () => boolean } };
export type LifecycleReadEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "head"> };
export type ShowControlSnapshot = { value: ShowControl; etag: string };
export type OwnedShowControlSnapshot = { value: ShowControl & { owner: NonNullable<ShowControl["owner"]> }; etag: string;
  [VERIFIED_CONTROL_REQUEST]?: VerifiedControlRequest };
export type ShowExecution = { showId: string; jobId: string; generation: number; executionId: string };
export type PublicVisibility = "public" | "not_found" | "gone";
export type PublicVisibilitySnapshot = { visibility: "not_found" | "gone" } | {
  visibility: "public";
  showId: string;
  episodeId?: string;
  showGeneration: number;
  feedGeneration: number;
  episodeGeneration?: number;
};

const MAX_CONTROL_BYTES = 16384;

function showControlKey(showId: string): string {
  return `system/show-publications/${validateId(showId, "show")}.json`;
}

function episodeLifecycleKey(showId: string, episodeId: string): string {
  return `system/episode-lifecycle/${validateId(showId, "show")}/${validateId(episodeId, "episode")}.toml`;
}

function checkRecordSize(object: R2Object): void {
  if (object.size > MAX_CONTROL_BYTES) throw new Error("Lifecycle control record exceeds the size limit");
}

export async function readShowControl(env: LifecycleReadEnv, showId: string): Promise<ShowControlSnapshot | null> {
  const object = await env.CASTLOOP_BUCKET.get(showControlKey(showId));
  if (!object) return null;
  checkRecordSize(object);
  const value = parseShowControl(await object.json<unknown>());
  if (value.show_id !== showId) throw new Error("Show control record does not match its key");
  return { value, etag: object.etag };
}

export async function readEpisodeLifecycle(env: LifecycleReadEnv, showId: string,
  episodeId: string): Promise<EpisodeLifecycle | null> {
  const object = await env.CASTLOOP_BUCKET.get(episodeLifecycleKey(showId, episodeId));
  if (!object) return null;
  checkRecordSize(object);
  const value = parseEpisodeLifecycle(await object.text());
  if (value.show_id !== showId || value.episode_id !== episodeId) {
    throw new Error("Episode lifecycle record does not match its key");
  }
  return value;
}

async function requestHash(request: ControlRequest): Promise<string> {
  return sha256Hex(JSON.stringify(request));
}

export { requestHash as controlRequestHash, requireOwnedOperation, requireEligibleTarget };

async function freezeRequest(env: LifecycleControlEnv, request: ControlRequest, hash: string): Promise<void> {
  const key = `system/jobs/${request.job_id}/request.toml`;
  const written = await env.CASTLOOP_BUCKET.put(key, stringifyLifecycleToml(request), {
    onlyIf: new Headers({ "If-None-Match": "*" }),
  });
  if (written) return;
  const existing = await env.CASTLOOP_BUCKET.get(key);
  if (!existing) throw new Error("Frozen control request disappeared");
  checkRecordSize(existing);
  if (await requestHash(parseControlRequest(await existing.text())) !== hash) {
    throw new Error("Job ID already has a different control request");
  }
}

async function requireEligibleTarget(env: LifecycleControlEnv, control: ShowControl,
  request: ControlRequest, options: { allowNewEpisodeDraft?: boolean } = {}): Promise<void> {
  await requireShowReservationReady(env, control);
  if (control.generation !== request.expected_show_generation) {
    throw new Error("Show generation changed; inspect the current state before retrying");
  }
  if (control.generation === Number.MAX_SAFE_INTEGER) throw new Error("Show generation is exhausted");
  if (control.feed_generation === Number.MAX_SAFE_INTEGER) throw new Error("Feed generation is exhausted");
  if (request.kind === "show") {
    if (!permitsControlAction(control.lifecycle, request.action)) {
      throw new Error(`Show state ${control.lifecycle} does not permit ${request.action}`);
    }
    return;
  }
  if (control.lifecycle !== "active" &&
    !(control.lifecycle === "unpublished" && (request.action === "unpublish" || request.action === "delete")) &&
    !(control.lifecycle === "draft" && request.action === "delete")) {
    throw new Error(`Show state ${control.lifecycle} does not permit this Episode operation`);
  }
  const episode = await readEpisodeLifecycle(env, request.show_id, request.episode_id!);
  if (!episode) {
    if (options.allowNewEpisodeDraft && request.action === "stage" && request.expected_episode_generation === 0) return;
    throw new Error("Episode lifecycle record is missing");
  }
  if (episode.generation !== request.expected_episode_generation) {
    throw new Error("Episode generation changed; inspect the current state before retrying");
  }
  if (episode.generation === Number.MAX_SAFE_INTEGER) throw new Error("Episode generation is exhausted");
  if (!permitsControlAction(episode.lifecycle, request.action)) {
    throw new Error(`Episode state ${episode.lifecycle} does not permit ${request.action}`);
  }
}

function ownsRequest(control: ShowControl, request: ControlRequest, hash: string): boolean {
  return control.generation === request.expected_show_generation + 1 &&
    control.owner?.job_id === request.job_id && control.owner.request_sha256 === hash &&
    control.owner.action === request.action && control.owner.kind === request.kind &&
    control.owner.episode_id === request.episode_id;
}

export async function claimShowOperation(env: LifecycleControlEnv, input: unknown,
  options: { allowNewEpisodeDraft?: boolean; commandExecutionId?: string; publicationExecutionId?: string } = {}): Promise<ShowControlSnapshot> {
  const request = controlRequestSchema.parse(input);
  if (options.commandExecutionId && request.action !== "stage" || options.publicationExecutionId && request.action !== "publish") {
    throw new Error("Command execution kind differs from its control action");
  }
  const current = await readShowControl(env, request.show_id);
  if (!current) throw new Error("Show lifecycle control is not initialized");
  await requireShowReservationReady(env, current.value);
  const hash = await requestHash(request);
  if (current.value.owner) {
    if (!ownsRequest(current.value, request, hash)) throw new Error("Show has an unfinished operation");
    if (current.value.owner.command_execution_id !== options.commandExecutionId ||
      options.publicationExecutionId && current.value.owner.execution_id && current.value.owner.execution_id !== options.publicationExecutionId) {
      throw new Error("Another management command is still executing this operation");
    }
    await freezeRequest(env, request, hash);
    return current;
  }
  await requireEligibleTarget(env, current.value, request, options);
  if (await env.CASTLOOP_BUCKET.head(`system/jobs/${request.job_id}/status.toml`)) {
    throw new Error("Job ID has already been used");
  }
  await freezeRequest(env, request, hash);
  const value = parseShowControl({ ...current.value, generation: current.value.generation + 1,
    owner: { job_id: request.job_id, kind: request.kind, action: request.action,
      ...(request.episode_id ? { episode_id: request.episode_id } : {}),
      state: request.action === "stage" ? "uploading" : options.publicationExecutionId ? "processing" : "reserved", request_sha256: hash,
      ...(options.commandExecutionId ? { command_execution_id: options.commandExecutionId } : {}),
      ...(options.publicationExecutionId ? { execution_id: options.publicationExecutionId } : {}) } });
  const written = await putPublicDeliveryRecord(env, showControlKey(request.show_id), JSON.stringify(value), {
    onlyIf: { etagMatches: current.etag },
  });
  if (written) return { value, etag: written.etag };
  const updated = await readShowControl(env, request.show_id);
  if (updated && ownsRequest(updated.value, request, hash) && updated.value.owner?.command_execution_id === options.commandExecutionId &&
    (!options.publicationExecutionId || updated.value.owner?.execution_id === options.publicationExecutionId)) return updated;
  throw new Error("Show control changed while claiming the operation");
}

async function requireOwnedOperation(env: LifecycleControlEnv, showId: string,
  jobId: string, expectedGeneration: number): Promise<OwnedShowControlSnapshot> {
  const current = await readShowControl(env, showId);
  if (!current || current.value.generation !== expectedGeneration || current.value.owner?.job_id !== jobId) {
    throw new Error("Operation no longer owns the Show");
  }
  const commit = env[VERIFIED_COMMIT_CONTROL];
  if (commit) {
    if (!commit.isActive() || commit.bucket !== env.CASTLOOP_BUCKET || commit.request.show_id !== showId ||
      commit.request.job_id !== jobId || commit.request.expected_show_generation + 1 !== expectedGeneration ||
      current.value.reservation_id !== commit.reservationId || current.value.owner.state !== "reserved" ||
      current.value.owner.execution_id !== undefined || !ownsRequest(current.value, commit.request, commit.hash)) {
      throw new Error("Verified commit no longer matches its reserved Show owner");
    }
    return { ...current, value: { ...current.value, owner: current.value.owner } };
  }
  const verified = env[VERIFIED_OPERATION];
  if (verified) {
    if (verified.bucket !== env.CASTLOOP_BUCKET || verified.request.show_id !== showId || verified.request.job_id !== jobId ||
      verified.request.expected_show_generation + 1 !== expectedGeneration || current.value.reservation_id !== verified.reservationId ||
      (verified.executionId !== undefined ? current.value.owner.execution_id !== verified.executionId :
        current.value.owner.state !== "uploading" || current.value.owner.verification_id !== verified.verificationId) ||
      !ownsRequest(current.value, verified.request, verified.hash)) {
      throw new Error("Verified request no longer matches its current Show execution");
    }
    return { ...current, value: { ...current.value, owner: current.value.owner } };
  }
  await requireShowReservationReady(env, current.value);
  const frozen = await env.CASTLOOP_BUCKET.get(`system/jobs/${jobId}/request.toml`);
  if (!frozen) throw new Error("Frozen control request is missing");
  checkRecordSize(frozen);
  const request = parseControlRequest(await frozen.text());
  const hash = await requestHash(request);
  if (request.show_id !== showId || !ownsRequest(current.value, request, hash)) {
    throw new Error("Frozen control request does not match the Show owner");
  }
  return { ...current, value: { ...current.value, owner: current.value.owner },
    [VERIFIED_CONTROL_REQUEST]: Object.freeze({ bucket: env.CASTLOOP_BUCKET, request: Object.freeze(request), hash,
      reservationId: current.value.reservation_id }) };
}

export async function withReservedPublicationControlEnv<T extends LifecycleControlEnv, Result>(env: T,
  snapshot: OwnedShowControlSnapshot,
  callback: (scoped: T, request: Readonly<ControlRequest>) => Promise<Result>): Promise<Result> {
  const verified = snapshot[VERIFIED_CONTROL_REQUEST];
  if (env[VERIFIED_OPERATION] || env[VERIFIED_COMMIT_CONTROL] || !verified || verified.bucket !== env.CASTLOOP_BUCKET ||
    verified.request.action !== "publish" || snapshot.value.owner.state !== "reserved" ||
    snapshot.value.owner.execution_id !== undefined || snapshot.value.reservation_id !== verified.reservationId ||
    !ownsRequest(snapshot.value, verified.request, verified.hash)) {
    throw new Error("Commit scope requires its validated reserved publication owner");
  }
  let active = true;
  const scoped = { ...env, [VERIFIED_COMMIT_CONTROL]: Object.freeze({ ...verified, isActive: () => active }) };
  try { return await callback(scoped, verified.request); }
  finally { active = false; }
}

export async function createShowExecutionEnv<T extends LifecycleControlEnv>(env: T, execution: ShowExecution): Promise<T> {
  if (env[VERIFIED_OPERATION]) throw new Error("A verified execution environment cannot be reused for another invocation");
  const current = await requireShowExecution(env, execution);
  return verifiedOperationEnv(env, current, { executionId: execution.executionId });
}

export async function createStageVerificationControlEnv<T extends LifecycleControlEnv>(env: T,
  verification: { showId: string; operationId: string; generation: number; verificationId: string }): Promise<T> {
  if (!verification.verificationId) throw new Error("Staging verification requires an acquired token");
  if (env[VERIFIED_OPERATION]) throw new Error("A verified environment cannot be reused for another invocation");
  const current = await requireOwnedOperation(env, verification.showId, verification.operationId, verification.generation);
  if (current.value.owner.action !== "stage" || current.value.owner.state !== "uploading" ||
    current.value.owner.verification_id !== verification.verificationId) throw new Error("Staging verification token does not match its owner");
  return verifiedOperationEnv(env, current, { verificationId: verification.verificationId });
}

async function verifiedOperationEnv<T extends LifecycleControlEnv>(env: T, current: ShowControlSnapshot,
  token: { executionId: string } | { verificationId: string }): Promise<T> {
  const frozen = await env.CASTLOOP_BUCKET.get(`system/jobs/${current.value.owner!.job_id}/request.toml`);
  if (!frozen) throw new Error("Frozen control request is missing");
  checkRecordSize(frozen);
  const request = parseControlRequest(await frozen.text());
  const hash = await requestHash(request);
  if (request.show_id !== current.value.show_id || !ownsRequest(current.value, request, hash)) {
    throw new Error("Frozen control request changed during execution verification");
  }
  return { ...env, [VERIFIED_OPERATION]: Object.freeze({ bucket: env.CASTLOOP_BUCKET, request: Object.freeze(request), hash,
    reservationId: current.value.reservation_id, ...token }) };
}

export async function beginShowOperation(env: LifecycleControlEnv, showId: string,
  jobId: string, expectedGeneration: number): Promise<ShowControlSnapshot> {
  const current = await requireOwnedOperation(env, showId, jobId, expectedGeneration);
  if (current.value.owner.state === "processing") return current;
  if (current.value.owner.state !== "reserved") throw new Error("Only a reserved operation can begin processing");
  const value = parseShowControl({ ...current.value, owner: { ...current.value.owner, state: "processing" } });
  const written = await putPublicDeliveryRecord(env, showControlKey(showId), JSON.stringify(value), {
    onlyIf: { etagMatches: current.etag },
  });
  if (!written) throw new Error("Show control changed before processing began");
  return { value, etag: written.etag };
}

export async function acquireShowExecution(env: LifecycleControlEnv, showId: string,
  jobId: string, expectedGeneration: number): Promise<ShowExecution> {
  const current = await requireOwnedOperation(env, showId, jobId, expectedGeneration);
  if (current.value.owner.state === "uploading") throw new Error("A staging operation cannot acquire consumer execution");
  if (current.value.owner.execution_id) throw new Error("Another invocation is still executing this operation");
  const executionId = crypto.randomUUID();
  const value = parseShowControl({ ...current.value,
    owner: { ...current.value.owner, state: "processing", execution_id: executionId } });
  const written = await putPublicDeliveryRecord(env, showControlKey(showId), JSON.stringify(value), {
    onlyIf: { etagMatches: current.etag },
  });
  if (!written) throw new Error("Show control changed before execution was acquired");
  return { showId, jobId, generation: expectedGeneration, executionId };
}

export async function requireShowExecution(env: LifecycleControlEnv,
  execution: ShowExecution): Promise<ShowControlSnapshot> {
  const current = await requireOwnedOperation(env, execution.showId, execution.jobId, execution.generation);
  if (current.value.owner.state !== "processing" || current.value.owner.execution_id !== execution.executionId) {
    throw new Error("Invocation no longer owns the execution token");
  }
  return current;
}

export async function releaseShowExecution(env: LifecycleControlEnv,
  execution: ShowExecution): Promise<ShowControlSnapshot> {
  const current = await requireOwnedOperation(env, execution.showId, execution.jobId, execution.generation);
  if (current.value.owner.state !== "processing") throw new Error("Only processing execution can be released");
  if (!current.value.owner.execution_id) return current;
  if (current.value.owner.execution_id !== execution.executionId) {
    throw new Error("Invocation no longer owns the execution token");
  }
  const { execution_id: _executionId, ...owner } = current.value.owner;
  const value = parseShowControl({ ...current.value, owner });
  const written = await putPublicDeliveryRecord(env, showControlKey(execution.showId), JSON.stringify(value), {
    onlyIf: { etagMatches: current.etag },
  });
  if (!written) throw new Error("Show control changed before execution was released");
  return { value, etag: written.etag };
}

export async function finishShowOperation(env: LifecycleControlEnv,
  execution: ShowExecution): Promise<ShowControlSnapshot> {
  const snapshot = await readShowControl(env, execution.showId);
  const receipt = snapshot?.value.last_finished_operation;
  if (receipt?.job_id === execution.jobId && receipt.generation === execution.generation &&
    receipt.execution_id === execution.executionId) return snapshot!;
  const current = await requireShowExecution(env, execution);
  const owner = current.value.owner!;
  const records = await Promise.allSettled((["status", "progress"] as const).map(async (name) => {
    const object = await env.CASTLOOP_BUCKET.get(`system/jobs/${execution.jobId}/${name}.toml`);
    if (!object) return null;
    if (object.size > MAX_CONTROL_BYTES) {
      await object.body?.cancel();
      throw new Error("Lifecycle control record exceeds the size limit");
    }
    return await object.text();
  }));
  const [statusRecord, progressRecord] = records;
  if (statusRecord.status === "rejected") throw statusRecord.reason;
  if (progressRecord.status === "rejected") throw progressRecord.reason;
  if (statusRecord.value === null || progressRecord.value === null) throw new Error("Operation has no durable terminal status and progress");
  const status = parseJobStatus(statusRecord.value);
  const progress = parseLifecycleProgress(progressRecord.value);
  for (const record of [status, progress]) {
    if (!("request_sha256" in record) || record.job_id !== execution.jobId ||
      record.show_id !== execution.showId || record.show_generation !== execution.generation ||
      record.request_sha256 !== owner.request_sha256 || record.action !== owner.action ||
      record.kind !== owner.kind || record.episode_id !== owner.episode_id) {
      throw new Error("Terminal records do not match the Show owner");
    }
  }
  if (status.schema_version !== 2 || (status.state !== "completed" && status.state !== "published") ||
    progress.phase !== "finished" || !progress.purge_confirmed) {
    throw new Error("Operation is not complete with confirmed cache purging");
  }
  const episode = owner.kind === "episode" ? await readEpisodeLifecycle(env, execution.showId, owner.episode_id!) : null;
  if (owner.kind === "episode" && episode?.last_job_id !== execution.jobId) {
    throw new Error("Episode result was not written by this operation");
  }
  const lifecycle = owner.kind === "show" ? current.value.lifecycle : episode?.lifecycle;
  if (lifecycle !== status.result_lifecycle) throw new Error("Target lifecycle does not match the completed result");
  const { owner: _owner, ...withoutOwner } = current.value;
  const value = parseShowControl({ ...withoutOwner, last_finished_operation: {
    job_id: execution.jobId, generation: execution.generation, execution_id: execution.executionId,
    request_sha256: owner.request_sha256,
  } });
  const written = await putPublicDeliveryRecord(env, showControlKey(execution.showId), JSON.stringify(value), {
    onlyIf: { etagMatches: current.etag },
  });
  if (!written) throw new Error("Show control changed before the operation finished");
  return { value, etag: written.etag };
}

export async function abandonReservedShowOperation(env: LifecycleControlEnv, showId: string,
  jobId: string, expectedGeneration: number): Promise<ShowControlSnapshot> {
  const current = await readShowControl(env, showId);
  if (!current) throw new Error("Show lifecycle control is not initialized");
  const frozen = await env.CASTLOOP_BUCKET.get(`system/jobs/${jobId}/request.toml`);
  if (!frozen) throw new Error("Frozen control request is missing");
  checkRecordSize(frozen);
  const request = parseControlRequest(await frozen.text());
  const hash = await requestHash(request);
  if (request.show_id !== showId || request.job_id !== jobId ||
    request.expected_show_generation + 1 !== expectedGeneration) {
    throw new Error("Frozen control request does not match the abandoned operation");
  }
  const abandoned = current.value.last_abandoned_operation;
  if (abandoned?.job_id === jobId && abandoned.generation === expectedGeneration && abandoned.request_sha256 === hash) {
    return current;
  }
  if (current.value.generation !== expectedGeneration || !ownsRequest(current.value, request, hash)) {
    throw new Error("Operation no longer owns the Show");
  }
  if (current.value.owner?.state !== "reserved") {
    throw new Error("Only an unstarted reserved operation can be abandoned");
  }
  if (current.value.generation === Number.MAX_SAFE_INTEGER) throw new Error("Show generation is exhausted");
  const { owner: _owner, ...withoutOwner } = current.value;
  const value = parseShowControl({ ...withoutOwner, generation: current.value.generation + 1,
    last_abandoned_operation: { job_id: jobId, generation: expectedGeneration, request_sha256: hash } });
  const written = await putPublicDeliveryRecord(env, showControlKey(showId), JSON.stringify(value), {
    onlyIf: { etagMatches: current.etag },
  });
  if (written) return { value, etag: written.etag };
  const updated = await readShowControl(env, showId);
  if (updated?.value.last_abandoned_operation?.job_id === jobId &&
    updated.value.last_abandoned_operation.generation === expectedGeneration &&
    updated.value.last_abandoned_operation.request_sha256 === hash) return updated;
  throw new Error("Show control changed before the reserved operation was abandoned");
}

export async function readPublicVisibilitySnapshot(env: LifecycleReadEnv, showId: string,
  episodeId?: string): Promise<PublicVisibilitySnapshot> {
  if (episodeId !== undefined) validateId(episodeId, "episode");
  const control = await readShowControl(env, showId);
  if (!control) {
    if (await env.CASTLOOP_BUCKET.head(`system/show-reservations/${validateId(showId, "show")}.json`)) {
      throw new Error("Reserved Show has no lifecycle control record");
    }
    return { visibility: "not_found" };
  }
  if (control.value.lifecycle === "deleting" || control.value.lifecycle === "deleted") return { visibility: "gone" };
  if (control.value.lifecycle !== "active") return { visibility: "not_found" };
  const snapshot = { visibility: "public" as const, showId,
    showGeneration: control.value.generation, feedGeneration: control.value.feed_generation };
  if (episodeId === undefined) return snapshot;
  const episode = await readEpisodeLifecycle(env, showId, episodeId);
  if (!episode) {
    if (await env.CASTLOOP_BUCKET.head(
      `public/episodes/${validateId(showId, "show")}/${validateId(episodeId, "episode")}/metadata.toml`)) {
      throw new Error("Published Episode has no lifecycle control record");
    }
    return { visibility: "not_found" };
  }
  if (episode.lifecycle === "deleting" || episode.lifecycle === "deleted") return { visibility: "gone" };
  return episode.lifecycle === "active" ? { ...snapshot, episodeId, episodeGeneration: episode.generation }
    : { visibility: "not_found" };
}

export async function readPublicVisibility(env: LifecycleReadEnv, showId: string,
  episodeId?: string): Promise<PublicVisibility> {
  return (await readPublicVisibilitySnapshot(env, showId, episodeId)).visibility;
}
