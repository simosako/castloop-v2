import { migrationApplyProgressSchema, serviceAdmissionSchema, serviceInvocationKindSchema, serviceMigrationRequestSchema } from "../packages/shared/src/index";
import type { M6ServiceReadiness, ServiceAdmission, ServiceInvocationKind, ServiceMigrationRequest } from "../packages/shared/src/index";
import type { LifecycleControlEnv, LifecycleReadEnv } from "./lifecycle-control";

export const SERVICE_ADMISSION_KEY = "system/lifecycle-service.json";
const MAX_RECORD_BYTES = 16384;
const CONFLICT_ATTEMPTS = 64;
export type ServiceAdmissionSnapshot = { value: ServiceAdmission; etag: string };
export type ServiceInvocation = { serviceId: string; token: string; kind: ServiceInvocationKind };
export type ServiceMigrationExecution = { serviceId: string; migrationId: string; executionId: string };

export class ServiceAdmissionBlocked extends Error {
  constructor() { super("Service is not admitting this kind of mutation"); }
}

export async function readServiceAdmission(env: LifecycleReadEnv, serviceId: string): Promise<ServiceAdmissionSnapshot | null> {
  serviceAdmissionSchema.shape.service_id.parse(serviceId);
  const object = await env.CASTLOOP_BUCKET.get(SERVICE_ADMISSION_KEY);
  if (!object) return null;
  if (object.size < 1 || object.size > MAX_RECORD_BYTES) throw new Error("Service admission is oversized or empty");
  const value = serviceAdmissionSchema.parse(await object.json<unknown>());
  if (value.service_id !== serviceId) throw new Error("Service admission belongs to another service");
  return { value, etag: object.etag };
}

async function requireService(env: LifecycleControlEnv, serviceId: string): Promise<ServiceAdmissionSnapshot> {
  const snapshot = await readServiceAdmission(env, serviceId);
  if (!snapshot) throw new Error("Service admission is not initialized");
  return snapshot;
}

function verifiedM6Snapshot(snapshot: ServiceAdmissionSnapshot | null, workerVersionId: string | undefined):
  ServiceAdmissionSnapshot & { readiness: M6ServiceReadiness } {
  const readiness = snapshot?.value.runtime_readiness ?? snapshot?.value.readiness;
  if (!snapshot || snapshot.value.mode !== "m6" || !["open", "paused"].includes(snapshot.value.state) || !readiness) {
    throw new Error("M6 requires completed service migration readiness or verified runtime readiness");
  }
  if (readiness.worker_version_id !== workerVersionId) throw new Error("Executing Worker version does not match verified M6 cutover");
  return { ...snapshot, readiness };
}

export async function requireM6ServiceRuntime(env: LifecycleReadEnv, serviceId: string, workerVersionId: string | undefined):
  Promise<ServiceAdmissionSnapshot & { readiness: M6ServiceReadiness }> {
  return verifiedM6Snapshot(await readServiceAdmission(env, serviceId), workerVersionId);
}

async function write(env: LifecycleControlEnv, snapshot: ServiceAdmissionSnapshot, input: ServiceAdmission): Promise<boolean> {
  if (snapshot.value.generation === Number.MAX_SAFE_INTEGER) throw new Error("Service admission generation is exhausted");
  const value = serviceAdmissionSchema.parse({ ...input, generation: snapshot.value.generation + 1 });
  const source = JSON.stringify(value);
  if (new TextEncoder().encode(source).length > MAX_RECORD_BYTES) throw new Error("Service admission exceeds its record budget");
  return Boolean(await env.CASTLOOP_BUCKET.put(SERVICE_ADMISSION_KEY, source, { onlyIf: { etagMatches: snapshot.etag } }));
}

export async function initializeServiceAdmission(env: LifecycleControlEnv, serviceId: string): Promise<void> {
  const existing = await readServiceAdmission(env, serviceId);
  if (existing) return;
  const value = serviceAdmissionSchema.parse({ schema_version: 1, service_id: serviceId, generation: 0,
    mode: "legacy", state: "open", invocations: [] });
  await env.CASTLOOP_BUCKET.put(SERVICE_ADMISSION_KEY, JSON.stringify(value), { onlyIf: new Headers({ "If-None-Match": "*" }) });
  await requireService(env, serviceId);
}

export async function acquireServiceInvocation(env: LifecycleControlEnv, serviceId: string,
  input: ServiceInvocationKind): Promise<ServiceInvocation> {
  const kind = serviceInvocationKindSchema.parse(input);
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
    const snapshot = await requireService(env, serviceId);
    const mode = kind.startsWith("legacy_") ? "legacy" : "m6";
    if (snapshot.value.mode !== mode || ["migrating", "initializing", "updating"].includes(snapshot.value.state) ||
      snapshot.value.state === "paused" && kind.endsWith("_admin")) throw new ServiceAdmissionBlocked();
    if (snapshot.value.invocations.length === 32) throw new Error("Service mutation registry is full; do not expire active invocations");
    if (await write(env, snapshot, { ...snapshot.value, invocations: [...snapshot.value.invocations, { token, kind }] })) {
      return { serviceId, token, kind };
    }
  }
  throw new Error("Service mutation admission conflicted; retry explicitly");
}

export async function requireServiceInvocation(env: LifecycleControlEnv, invocation: ServiceInvocation): Promise<void> {
  const snapshot = await requireService(env, invocation.serviceId);
  if (!snapshot.value.invocations.some((item) => item.token === invocation.token && item.kind === invocation.kind)) {
    throw new Error("Invocation no longer owns its service mutation token");
  }
}

export async function releaseServiceInvocation(env: LifecycleControlEnv, invocation: ServiceInvocation): Promise<void> {
  for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
    const snapshot = await requireService(env, invocation.serviceId);
    const item = snapshot.value.invocations.find((item) => item.token === invocation.token);
    if (!item) return;
    if (item.kind !== invocation.kind) throw new Error("Service mutation token belongs to another invocation kind");
    if (await write(env, snapshot, { ...snapshot.value, invocations: snapshot.value.invocations.filter((item) => item.token !== invocation.token) })) return;
  }
  throw new Error("Service mutation token return conflicted; admission remains held");
}

export async function withServiceInvocation<T>(env: LifecycleControlEnv, serviceId: string,
  kind: ServiceInvocationKind, callback: (invocation: ServiceInvocation) => Promise<T>): Promise<T> {
  const invocation = await acquireServiceInvocation(env, serviceId, kind);
  try { return await callback(invocation); }
  finally { await releaseServiceInvocation(env, invocation); }
}

export async function pauseServiceAdmission(env: LifecycleControlEnv, serviceId: string, pauseId: string, workerVersionId?: string): Promise<void> {
  serviceAdmissionSchema.shape.pause_id.unwrap().parse(pauseId);
  for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
    const snapshot = await requireService(env, serviceId);
    if (workerVersionId !== undefined) verifiedM6Snapshot(snapshot, workerVersionId);
    if (snapshot.value.state !== "open") {
      if (snapshot.value.pause_id === pauseId) return;
      throw new Error("Service admission is paused by another operation");
    }
    if (snapshot.value.last_resumed_pause_id === pauseId) throw new Error("Completed pause IDs cannot be reused");
    if (await write(env, snapshot, { ...snapshot.value, state: "paused", pause_id: pauseId })) return;
  }
  throw new Error("Service pause conflicted; retry the same pause ID");
}

export async function resumeServiceAdmission(env: LifecycleControlEnv, serviceId: string, pauseId: string, workerVersionId?: string): Promise<void> {
  serviceAdmissionSchema.shape.pause_id.unwrap().parse(pauseId);
  for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
    const snapshot = await requireService(env, serviceId);
    if (workerVersionId !== undefined) verifiedM6Snapshot(snapshot, workerVersionId);
    if (snapshot.value.state === "open" && snapshot.value.last_resumed_pause_id === pauseId) return;
    if (snapshot.value.state !== "paused" || snapshot.value.pause_id !== pauseId) throw new Error("Only the current pause owner can resume admission");
    if (workerVersionId !== undefined && snapshot.value.invocations.length) throw new Error("Do not resume while M6 service invocations remain");
    const { pause_id: _pause, ...withoutPause } = snapshot.value;
    if (await write(env, snapshot, { ...withoutPause, state: "open", last_resumed_pause_id: pauseId })) return;
  }
  throw new Error("Service resume conflicted; retry the same pause ID");
}

async function migrationRequestHash(request: ServiceMigrationRequest): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(request)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function claimServiceMigration(env: LifecycleControlEnv, input: unknown): Promise<void> {
  const request = serviceMigrationRequestSchema.parse(input);
  const hash = await migrationRequestHash(request);
  const key = `system/lifecycle-migrations/${request.migration_id}/request.json`;
  const frozen = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(request), { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (!frozen) {
    const object = await env.CASTLOOP_BUCKET.get(key);
    if (!object || object.size > MAX_RECORD_BYTES || await migrationRequestHash(serviceMigrationRequestSchema.parse(await object.json<unknown>())) !== hash) {
      throw new Error("Migration ID already has a different frozen request");
    }
  }
  for (let attempt = 0; attempt < CONFLICT_ATTEMPTS; attempt += 1) {
    const snapshot = await requireService(env, request.service_id);
    if (snapshot.value.state === "migrating" && snapshot.value.migration?.migration_id === request.migration_id &&
      snapshot.value.migration.request_sha256 === hash && snapshot.value.pause_id === request.pause_id) return;
    if (snapshot.value.state !== "paused" || snapshot.value.pause_id !== request.pause_id || snapshot.value.invocations.length) {
      throw new Error("Migration requires its paused service and no live mutating invocations");
    }
    if (snapshot.value.mode !== "legacy") throw new Error("This migration only initializes legacy services");
    if (snapshot.value.generation !== request.expected_service_generation) throw new Error("Service admission changed before this migration request");
    if (await write(env, snapshot, { ...snapshot.value, state: "migrating", migration: { migration_id: request.migration_id, request_sha256: hash } })) return;
  }
  throw new Error("Migration admission conflicted; retry the same migration ID");
}

export async function requireServiceMigration(env: LifecycleControlEnv, execution: ServiceMigrationExecution): Promise<ServiceAdmissionSnapshot> {
  const snapshot = await requireService(env, execution.serviceId);
  const owner = snapshot.value.migration;
  if (snapshot.value.state !== "migrating" || owner?.migration_id !== execution.migrationId || owner.execution_id !== execution.executionId) {
    throw new Error("Invocation no longer owns its service migration token");
  }
  const object = await env.CASTLOOP_BUCKET.get(`system/lifecycle-migrations/${execution.migrationId}/request.json`);
  if (!object || object.size > MAX_RECORD_BYTES) throw new Error("Frozen service migration request is missing or oversized");
  const request = serviceMigrationRequestSchema.parse(await object.json<unknown>());
  if (request.service_id !== execution.serviceId || request.migration_id !== execution.migrationId || request.pause_id !== snapshot.value.pause_id ||
    await migrationRequestHash(request) !== owner.request_sha256) throw new Error("Frozen migration request does not match its service owner");
  return snapshot;
}

export async function acquireServiceMigrationExecution(env: LifecycleControlEnv, serviceId: string, migrationId: string): Promise<ServiceMigrationExecution> {
  const snapshot = await requireService(env, serviceId);
  const owner = snapshot.value.migration;
  if (snapshot.value.state !== "migrating" || owner?.migration_id !== migrationId) throw new Error("Migration no longer owns this service");
  if (owner.execution_id) throw new Error("Another migration invocation is still running");
  const executionId = crypto.randomUUID();
  if (!await write(env, snapshot, { ...snapshot.value, migration: { ...owner, execution_id: executionId } })) {
    throw new Error("Service migration changed before execution started");
  }
  const execution = { serviceId, migrationId, executionId };
  await requireServiceMigration(env, execution);
  return execution;
}

export async function releaseServiceMigrationExecution(env: LifecycleControlEnv, execution: ServiceMigrationExecution): Promise<void> {
  const snapshot = await requireServiceMigration(env, execution);
  const { execution_id: _token, ...owner } = snapshot.value.migration!;
  if (!await write(env, snapshot, { ...snapshot.value, migration: owner })) throw new Error("Service migration changed before its token was returned");
}

export async function abortUnstartedServiceMigration(env: LifecycleControlEnv, serviceId: string, migrationId: string): Promise<void> {
  const snapshot = await requireService(env, serviceId);
  const owner = snapshot.value.migration;
  if (snapshot.value.state !== "migrating" || owner?.migration_id !== migrationId || owner.execution_id) {
    throw new Error("Only an idle unstarted migration can be aborted");
  }
  const prefix = `system/lifecycle-migrations/${migrationId}`;
  if (owner.delivery_candidate || await env.CASTLOOP_BUCKET.head(`${prefix}/bootstrap.json`) ||
    await env.CASTLOOP_BUCKET.head(`${prefix}/plan.json`) || await env.CASTLOOP_BUCKET.head(`${prefix}/progress.json`)) {
    throw new Error("A migration with a frozen plan or progress must be resumed, not aborted");
  }
  const { migration: _owner, ...value } = snapshot.value;
  if (!await write(env, snapshot, { ...value, state: "paused" })) throw new Error("Migration changed before it could be aborted");
}

export async function openMigrationDeliveryCandidate(env: LifecycleControlEnv, execution: ServiceMigrationExecution,
  input: NonNullable<NonNullable<ServiceAdmission["migration"]>["delivery_candidate"]>): Promise<void> {
  const snapshot = await requireServiceMigration(env, execution);
  const candidate = serviceAdmissionSchema.shape.migration.unwrap().shape.delivery_candidate.unwrap().parse(input);
  const previous = snapshot.value.migration!.delivery_candidate;
  if (previous) {
    if (JSON.stringify(previous) === JSON.stringify(candidate)) return;
    throw new Error("Migration already has another frozen delivery candidate");
  }
  if (!await write(env, snapshot, { ...snapshot.value, migration: { ...snapshot.value.migration!, delivery_candidate: candidate } })) {
    throw new Error("Migration changed before its delivery candidate opened");
  }
}

export async function completeServiceMigration(env: LifecycleControlEnv, execution: ServiceMigrationExecution,
  input: NonNullable<ServiceAdmission["readiness"]>): Promise<void> {
  const readiness = serviceAdmissionSchema.shape.readiness.unwrap().parse(input);
  if (readiness.migration_id !== execution.migrationId) throw new Error("Migration readiness targets another operation");
  const existing = await requireService(env, execution.serviceId);
  if (existing.value.mode === "m6" && existing.value.readiness?.migration_id === execution.migrationId &&
    JSON.stringify(existing.value.readiness) === JSON.stringify(readiness)) return;
  const snapshot = await requireServiceMigration(env, execution);
  const object = await env.CASTLOOP_BUCKET.get(`system/lifecycle-migrations/${execution.migrationId}/progress.json`);
  if (!object || object.size > MAX_RECORD_BYTES) throw new Error("Migration has no durable finished progress");
  const progress = migrationApplyProgressSchema.parse(await object.json<unknown>());
  if (progress.phase !== "finished" || progress.migration_id !== execution.migrationId || progress.service_id !== execution.serviceId ||
    progress.request_sha256 !== snapshot.value.migration!.request_sha256 || progress.plan_sha256 !== readiness.plan_sha256 ||
    progress.completed_execution_id !== readiness.completed_execution_id || !progress.runtime ||
    JSON.stringify(serviceAdmissionSchema.shape.readiness.unwrap().parse({ migration_id: progress.migration_id,
      plan_sha256: progress.plan_sha256, ...progress.runtime, completed_execution_id: progress.completed_execution_id })) !==
      JSON.stringify(readiness)) throw new Error("Migration readiness does not match its completion evidence");
  const { migration: _owner, ...value } = snapshot.value;
  if (!await write(env, snapshot, { ...value, state: "paused", mode: "m6", readiness })) throw new Error("Migration changed before readiness was saved");
}
