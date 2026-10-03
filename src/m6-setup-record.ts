import { m6SetupRecordKey, m6SetupRecordSchema, m6SetupRequestSchema } from "../packages/shared/src/index";
import type { M6SetupRecord, M6SetupRequest } from "../packages/shared/src/index";
import type { M6InitializationEnv } from "./m6-service-initialization";
import { matchesM6RuntimeTarget, readM6RuntimeConfiguration } from "./m6-runtime-readiness";
import { readServiceAdmission } from "./service-admission";
import { requireFrozenUpdateRequest } from "./m6-service-update";

export { m6SetupRecordKey } from "../packages/shared/src/index";

export async function readM6SetupRecord(env: M6InitializationEnv, input: M6SetupRequest): Promise<{ value: M6SetupRecord; etag: string } | null> {
  const request = m6SetupRequestSchema.parse(input);
  const object = await env.CASTLOOP_BUCKET.get(m6SetupRecordKey(request.target.operation_id));
  if (!object) return null;
  if (object.size < 1 || object.size > 16384) throw new Error("Runtime probe record is missing or oversized");
  const value = m6SetupRecordSchema.parse(await object.json<unknown>());
  if (JSON.stringify(value.request) !== JSON.stringify(request)) throw new Error("Runtime probe has another permanent request");
  return { value, etag: object.etag };
}

export async function requireM6SetupOwner(env: M6InitializationEnv, input: M6SetupRequest): Promise<string> {
  const request = m6SetupRequestSchema.parse(input);
  const { config } = await readM6RuntimeConfiguration(env, request.target.service_config_sha256, request.target.worker_version_id);
  if (request.update_request) {
    if (request.update_request.service_id !== config.service_id) throw new Error("Runtime verification targets another update service");
    await requireFrozenUpdateRequest(env, request.update_request);
  }
  const admission = await readServiceAdmission(env, config.service_id);
  if (!admission || admission.value.mode !== "m6" || admission.value.invocations.length ||
    !(admission.value.state === "initializing" && !request.update_request && matchesM6RuntimeTarget(admission.value.initialization, request.target) ||
      admission.value.state === "updating" && request.update_request &&
        JSON.stringify(admission.value.update?.request) === JSON.stringify(request.update_request) &&
        matchesM6RuntimeTarget(admission.value.update?.target, request.target) ||
      admission.value.state === "paused" && matchesM6RuntimeTarget(admission.value.runtime_readiness, request.target))) {
    throw new Error("Runtime probe requires its exact initialization/update or completed paused service owner");
  }
  return config.service_id;
}
