import { m6RuntimeTargetSchema, m6ServiceUpdateRequestSchema, m6SetupRecordKey, serviceAdmissionSchema } from "../packages/shared/src/index";
import type { M6RuntimeReadiness, M6RuntimeTarget, M6ServiceUpdateRequest } from "../packages/shared/src/index";
import { readShowControl } from "./lifecycle-control";
import { matchesM6RuntimeTarget, readM6RuntimeConfiguration, verifyM6RuntimeReadiness } from "./m6-runtime-readiness";
import type { M6RuntimeChecks, M6RuntimeConfiguration, M6RuntimeEnv } from "./m6-runtime-readiness";
import { readServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import type { ServiceAdmissionSnapshot } from "./service-admission";
import { requireShowReservationReady } from "./show-reservation-record";

export type M6UpdateEnv = M6RuntimeEnv & { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "head" | "put" | "list"> };

export async function requireFrozenUpdateRequest(env: M6UpdateEnv, request: M6ServiceUpdateRequest): Promise<void> {
  const object = await env.CASTLOOP_BUCKET.get(`system/service-updates/${request.operation_id}/request.json`);
  if (!object || object.size < 1 || object.size > 16384 ||
    JSON.stringify(m6ServiceUpdateRequestSchema.parse(await object.json<unknown>())) !== JSON.stringify(request)) {
    throw new Error("Compatible update differs from its permanent frozen request");
  }
}

async function requireSettledShowOwners(env: M6UpdateEnv): Promise<void> {
  const prefix = "system/show-publications/";
  const page = await env.CASTLOOP_BUCKET.list({ prefix, limit: 100 });
  if (page.truncated) throw new Error("Compatible update exceeds its bounded Show-control inspection budget");
  for (const object of page.objects) {
    const showId = object.key.slice(prefix.length, -5);
    if (object.key !== `${prefix}${showId}.json`) throw new Error("Unknown Show-control key blocks compatible updates");
    const control = await readShowControl(env, showId);
    if (!control || control.value.owner || control.value.lifecycle === "deleting") throw new Error("Compatible update requires settled Show owners; unknown uploads or publications are not expired");
    await requireShowReservationReady(env, control.value);
  }
}

export async function beginM6ServiceUpdate(env: M6UpdateEnv, input: M6ServiceUpdateRequest): Promise<void> {
  const request = m6ServiceUpdateRequestSchema.parse(input);
  const configuration = await readM6RuntimeConfiguration(env, request.service_config_sha256, request.previous_worker_version_id);
  if (configuration.config.service_id !== request.service_id) throw new Error("Compatible update belongs to another service");
  const snapshot = await readServiceAdmission(env, request.service_id);
  if (snapshot?.value.state === "updating" && JSON.stringify(snapshot.value.update?.request) === JSON.stringify(request)) {
    await requireFrozenUpdateRequest(env, request);
    return;
  }
  if (!snapshot || snapshot.value.mode !== "m6" || snapshot.value.state !== "paused" || snapshot.value.pause_id !== request.pause_id ||
    snapshot.value.invocations.length || snapshot.value.generation !== request.expected_service_generation ||
    (snapshot.value.runtime_readiness ?? snapshot.value.readiness)?.worker_version_id !== request.previous_worker_version_id) {
    throw new Error("Compatible update requires its exact paused M6 service, previous runtime and no live invocations");
  }
  if (await env.CASTLOOP_BUCKET.head(m6SetupRecordKey(request.operation_id))) {
    throw new Error("Compatible update ID already belongs to permanent runtime verification");
  }
  await requireSettledShowOwners(env);
  if ((await readM6RuntimeConfiguration(env, request.service_config_sha256, request.previous_worker_version_id)).etag !== configuration.etag) {
    throw new Error("Service configuration changed before compatible update admission");
  }
  const key = `system/service-updates/${request.operation_id}/request.json`;
  if (!await env.CASTLOOP_BUCKET.put(key, JSON.stringify(request), { onlyIf: new Headers({ "If-None-Match": "*" }) })) {
    const existing = await env.CASTLOOP_BUCKET.get(key);
    if (!existing || existing.size > 16384 || JSON.stringify(m6ServiceUpdateRequestSchema.parse(await existing.json<unknown>())) !== JSON.stringify(request)) {
      throw new Error("Compatible update ID already has another permanent request");
    }
  }
  const next = serviceAdmissionSchema.parse({ ...snapshot.value, generation: snapshot.value.generation + 1,
    state: "updating", update: { request } });
  if (!await env.CASTLOOP_BUCKET.put(SERVICE_ADMISSION_KEY, JSON.stringify(next), { onlyIf: { etagMatches: snapshot.etag } })) {
    throw new Error("Service admission changed before compatible update; do not deploy");
  }
}

export async function prepareM6ServiceUpdate(env: M6UpdateEnv, input: M6ServiceUpdateRequest, targetInput: M6RuntimeTarget):
  Promise<{ configuration: M6RuntimeConfiguration; snapshot: ServiceAdmissionSnapshot; target: M6RuntimeTarget }> {
  const request = m6ServiceUpdateRequestSchema.parse(input);
  const target = m6RuntimeTargetSchema.parse(targetInput);
  if (target.operation_id !== request.operation_id || target.service_config_sha256 !== request.service_config_sha256 ||
    target.worker_version_id === request.previous_worker_version_id) throw new Error("Compatible update requires its exact new runtime target");
  await requireFrozenUpdateRequest(env, request);
  const configuration = await readM6RuntimeConfiguration(env, request.service_config_sha256, target.worker_version_id);
  if (configuration.config.service_id !== request.service_id) throw new Error("Compatible update belongs to another service");
  let snapshot = await readServiceAdmission(env, request.service_id);
  if (matchesM6RuntimeTarget(snapshot?.value.runtime_readiness, target)) return { configuration, snapshot: snapshot!, target };
  if (!snapshot || snapshot.value.state !== "updating" || JSON.stringify(snapshot.value.update?.request) !== JSON.stringify(request)) {
    throw new Error("Only the exact retained compatible update can complete");
  }
  if (!snapshot.value.update!.target) {
    const next = serviceAdmissionSchema.parse({ ...snapshot.value, generation: snapshot.value.generation + 1, update: { request, target } });
    if (!await env.CASTLOOP_BUCKET.put(SERVICE_ADMISSION_KEY, JSON.stringify(next), { onlyIf: { etagMatches: snapshot.etag } })) {
      throw new Error("Compatible update target admission conflicted; preserve the retained owner");
    }
    snapshot = await readServiceAdmission(env, request.service_id);
  }
  if (!snapshot || JSON.stringify(snapshot.value.update?.request) !== JSON.stringify(request) ||
    !matchesM6RuntimeTarget(snapshot.value.update?.target, target)) throw new Error("Compatible update already targets another deployment");
  return { configuration, snapshot, target };
}

export async function completeM6ServiceUpdate(env: M6UpdateEnv, input: M6ServiceUpdateRequest, targetInput: M6RuntimeTarget,
  checks: M6RuntimeChecks): Promise<M6RuntimeReadiness> {
  const { configuration, snapshot, target } = await prepareM6ServiceUpdate(env, input, targetInput);
  if (matchesM6RuntimeTarget(snapshot.value.runtime_readiness, target)) return snapshot.value.runtime_readiness!;
  const readiness = await verifyM6RuntimeReadiness(env, target, configuration, checks);
  const { update: _update, ...value } = snapshot.value;
  const next = serviceAdmissionSchema.parse({ ...value, generation: value.generation + 1, state: "paused", runtime_readiness: readiness });
  if (!await env.CASTLOOP_BUCKET.put(SERVICE_ADMISSION_KEY, JSON.stringify(next), { onlyIf: { etagMatches: snapshot.etag } })) {
    const current = await readServiceAdmission(env, configuration.config.service_id);
    if (!matchesM6RuntimeTarget(current?.value.runtime_readiness, target)) throw new Error("Compatible update admission changed during completion");
    return current!.value.runtime_readiness!;
  }
  return readiness;
}
