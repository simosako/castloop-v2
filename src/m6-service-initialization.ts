import { m6RuntimeTargetSchema, serviceAdmissionSchema } from "../packages/shared/src/index";
import type { M6RuntimeReadiness, M6RuntimeTarget } from "../packages/shared/src/index";
import { matchesM6RuntimeTarget, readM6RuntimeConfiguration, verifyM6RuntimeReadiness } from "./m6-runtime-readiness";
import type { M6RuntimeChecks, M6RuntimeEnv } from "./m6-runtime-readiness";
import { readServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { m6SetupRecordKey } from "./m6-setup-record";

export type M6InitializationEnv = M6RuntimeEnv & {
  CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "head" | "put" | "list">;
  CASTLOOP_VERSION_METADATA: Pick<WorkerVersionMetadata, "id">;
};
export type M6InitializationChecks = M6RuntimeChecks;
export { matchesM6RuntimeTarget } from "./m6-runtime-readiness";

async function requireEmptyService(env: M6InitializationEnv, target?: M6RuntimeTarget): Promise<void> {
  const page = await env.CASTLOOP_BUCKET.list({ prefix: "", limit: 4 });
  if (page.truncated || page.objects.some((object) => object.key !== "system/service.toml" && object.key !== SERVICE_ADMISSION_KEY &&
    (!target || object.key !== m6SetupRecordKey(target.operation_id)))) {
    throw new Error("Fresh M6 initialization requires an empty service; retained content or operational records must not be converted or deleted");
  }
}

export async function prepareM6ServiceInitialization(env: M6InitializationEnv, input: M6RuntimeTarget): Promise<void> {
  const target = m6RuntimeTargetSchema.parse(input);
  const { config } = await readM6RuntimeConfiguration(env, target.service_config_sha256, target.worker_version_id);
  const existing = await readServiceAdmission(env, config.service_id);
  if (existing) {
    if (matchesM6RuntimeTarget(existing.value.initialization, target) || matchesM6RuntimeTarget(existing.value.runtime_readiness, target)) return;
    throw new Error("This service already has a different permanent initialization or admission");
  }
  await requireEmptyService(env);
  const value = serviceAdmissionSchema.parse({ schema_version: 1, service_id: config.service_id, generation: 0,
    mode: "m6", state: "initializing", invocations: [], initialization: target });
  await env.CASTLOOP_BUCKET.put(SERVICE_ADMISSION_KEY, JSON.stringify(value), { onlyIf: new Headers({ "If-None-Match": "*" }) });
  const current = await readServiceAdmission(env, config.service_id);
  if (!matchesM6RuntimeTarget(current?.value.initialization, target) && !matchesM6RuntimeTarget(current?.value.runtime_readiness, target)) {
    throw new Error("Fresh M6 initialization admission conflicted; preserve the retained owner");
  }
}

export async function completeM6ServiceInitialization(env: M6InitializationEnv, input: M6RuntimeTarget,
  checks: M6InitializationChecks): Promise<M6RuntimeReadiness> {
  const target = m6RuntimeTargetSchema.parse(input);
  const configuration = await readM6RuntimeConfiguration(env, target.service_config_sha256, target.worker_version_id);
  const { config } = configuration;
  const snapshot = await readServiceAdmission(env, config.service_id);
  if (matchesM6RuntimeTarget(snapshot?.value.runtime_readiness, target)) return snapshot!.value.runtime_readiness!;
  if (!snapshot || snapshot.value.state !== "initializing" || !matchesM6RuntimeTarget(snapshot.value.initialization, target)) {
    throw new Error("Only the exact retained fresh M6 initialization can complete");
  }
  await requireEmptyService(env, target);
  const readiness = await verifyM6RuntimeReadiness(env, target, configuration, checks);
  await requireEmptyService(env, target);
  const { initialization: _initialization, ...value } = snapshot.value;
  const next = serviceAdmissionSchema.parse({ ...value, generation: value.generation + 1, state: "paused",
    pause_id: target.operation_id, runtime_readiness: readiness });
  const saved = await env.CASTLOOP_BUCKET.put(SERVICE_ADMISSION_KEY, JSON.stringify(next), { onlyIf: { etagMatches: snapshot.etag } });
  if (!saved) {
    const current = await readServiceAdmission(env, config.service_id);
    if (!matchesM6RuntimeTarget(current?.value.runtime_readiness, target)) throw new Error("Fresh M6 admission changed before completion");
    return current!.value.runtime_readiness!;
  }
  return readiness;
}
