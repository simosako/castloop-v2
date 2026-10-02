import { controlRequestSchema, parseControlRequest, parseEpisodeLifecycle, parseJobStatus,
  parseLifecycleProgress, parseShowControl,
  permitsControlAction, stringifyLifecycleToml, validateId } from "../packages/shared/src/index";
import type { ControlRequest, EpisodeLifecycle, ShowControl } from "../packages/shared/src/index";

export type LifecycleControlEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "put" | "head"> };
export type LifecycleReadEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "head"> };
export type ShowControlSnapshot = { value: ShowControl; etag: string };
export type OwnedShowControlSnapshot = { value: ShowControl & { owner: NonNullable<ShowControl["owner"]> }; etag: string };
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
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(request)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  options: { allowNewEpisodeDraft?: boolean } = {}): Promise<ShowControlSnapshot> {
  const request = controlRequestSchema.parse(input);
  const current = await readShowControl(env, request.show_id);
  if (!current) throw new Error("Show lifecycle control is not initialized");
  const hash = await requestHash(request);
  if (current.value.owner) {
    if (!ownsRequest(current.value, request, hash)) throw new Error("Show has an unfinished operation");
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
      state: request.action === "stage" ? "uploading" : "reserved", request_sha256: hash } });
  const written = await env.CASTLOOP_BUCKET.put(showControlKey(request.show_id), JSON.stringify(value), {
    onlyIf: { etagMatches: current.etag },
  });
  if (written) return { value, etag: written.etag };
  const updated = await readShowControl(env, request.show_id);
  if (updated && ownsRequest(updated.value, request, hash)) return updated;
  throw new Error("Show control changed while claiming the operation");
}

async function requireOwnedOperation(env: LifecycleControlEnv, showId: string,
  jobId: string, expectedGeneration: number): Promise<OwnedShowControlSnapshot> {
  const current = await readShowControl(env, showId);
  if (!current || current.value.generation !== expectedGeneration || current.value.owner?.job_id !== jobId) {
    throw new Error("Operation no longer owns the Show");
  }
  const frozen = await env.CASTLOOP_BUCKET.get(`system/jobs/${jobId}/request.toml`);
  if (!frozen) throw new Error("Frozen control request is missing");
  checkRecordSize(frozen);
  const request = parseControlRequest(await frozen.text());
  if (request.show_id !== showId || !ownsRequest(current.value, request, await requestHash(request))) {
    throw new Error("Frozen control request does not match the Show owner");
  }
  return { ...current, value: { ...current.value, owner: current.value.owner } };
}

export async function beginShowOperation(env: LifecycleControlEnv, showId: string,
  jobId: string, expectedGeneration: number): Promise<ShowControlSnapshot> {
  const current = await requireOwnedOperation(env, showId, jobId, expectedGeneration);
  if (current.value.owner.state === "processing") return current;
  if (current.value.owner.state !== "reserved") throw new Error("Only a reserved operation can begin processing");
  const value = parseShowControl({ ...current.value, owner: { ...current.value.owner, state: "processing" } });
  const written = await env.CASTLOOP_BUCKET.put(showControlKey(showId), JSON.stringify(value), {
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
  const written = await env.CASTLOOP_BUCKET.put(showControlKey(showId), JSON.stringify(value), {
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
  const written = await env.CASTLOOP_BUCKET.put(showControlKey(execution.showId), JSON.stringify(value), {
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
  const [statusObject, progressObject] = await Promise.all([
    env.CASTLOOP_BUCKET.get(`system/jobs/${execution.jobId}/status.toml`),
    env.CASTLOOP_BUCKET.get(`system/jobs/${execution.jobId}/progress.toml`),
  ]);
  if (!statusObject || !progressObject) throw new Error("Operation has no durable terminal status and progress");
  checkRecordSize(statusObject);
  checkRecordSize(progressObject);
  const status = parseJobStatus(await statusObject.text());
  const progress = parseLifecycleProgress(await progressObject.text());
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
  const written = await env.CASTLOOP_BUCKET.put(showControlKey(execution.showId), JSON.stringify(value), {
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
  const written = await env.CASTLOOP_BUCKET.put(showControlKey(showId), JSON.stringify(value), {
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
