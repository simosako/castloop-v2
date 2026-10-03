import { m6RuntimeReadinessSchema, m6RuntimeTargetSchema, m6ServiceConfigHash, m6WorkerDeploymentEvidenceSchema, parseServiceConfig,
  serviceAdmissionSchema } from "../packages/shared/src/index";
import type { M6RuntimeReadiness, M6RuntimeTarget, ServiceConfig } from "../packages/shared/src/index";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { readServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";

export type M6InitializationEnv = LifecycleControlEnv & {
  CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "head" | "put" | "list">;
  CASTLOOP_VERSION_METADATA: Pick<WorkerVersionMetadata, "id">;
};
export type M6InitializationChecks = {
  inspectDeployment: (config: ServiceConfig, workerVersionId: string) => Promise<unknown>;
  verifyRuntime: (config: ServiceConfig, target: M6RuntimeTarget) => Promise<unknown>;
};

export function matchesM6RuntimeTarget(value: M6RuntimeTarget | undefined, target: M6RuntimeTarget): boolean {
  return value?.operation_id === target.operation_id && value.deployment_id === target.deployment_id &&
    value.worker_version_id === target.worker_version_id && value.service_config_sha256 === target.service_config_sha256;
}

async function configuration(env: M6InitializationEnv, target: M6RuntimeTarget): Promise<{ config: ServiceConfig; etag: string }> {
  if (target.worker_version_id !== env.CASTLOOP_VERSION_METADATA.id) throw new Error("Initialization targets another executing Worker version");
  const object = await env.CASTLOOP_BUCKET.get("system/service.toml");
  if (!object || object.size < 1 || object.size > 16384) throw new Error("Fresh M6 service configuration is missing or oversized");
  const config = parseServiceConfig(await object.text());
  if (await m6ServiceConfigHash(config) !== target.service_config_sha256) throw new Error("Fresh M6 service configuration differs from its frozen target");
  return { config, etag: object.etag };
}

async function requireEmptyService(env: M6InitializationEnv): Promise<void> {
  const page = await env.CASTLOOP_BUCKET.list({ prefix: "", limit: 3 });
  if (page.truncated || page.objects.some((object) => object.key !== "system/service.toml" && object.key !== SERVICE_ADMISSION_KEY)) {
    throw new Error("Fresh M6 initialization requires an empty service; retained content or operational records must not be converted or deleted");
  }
}

export async function prepareM6ServiceInitialization(env: M6InitializationEnv, input: M6RuntimeTarget): Promise<void> {
  const target = m6RuntimeTargetSchema.parse(input);
  const { config } = await configuration(env, target);
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
  const { config, etag } = await configuration(env, target);
  const snapshot = await readServiceAdmission(env, config.service_id);
  if (matchesM6RuntimeTarget(snapshot?.value.runtime_readiness, target)) return snapshot!.value.runtime_readiness!;
  if (!snapshot || snapshot.value.state !== "initializing" || !matchesM6RuntimeTarget(snapshot.value.initialization, target)) {
    throw new Error("Only the exact retained fresh M6 initialization can complete");
  }
  await requireEmptyService(env);
  const deployment = m6WorkerDeploymentEvidenceSchema.parse(await checks.inspectDeployment(config, target.worker_version_id));
  if (deployment.service_id !== config.service_id || deployment.account_id !== config.account_id || deployment.worker_name !== config.worker_name ||
    deployment.worker_version_id !== target.worker_version_id || deployment.deployment_id !== target.deployment_id) {
    throw new Error("Fresh M6 deployment evidence targets another service or deployment");
  }
  const readiness = m6RuntimeReadinessSchema.parse(await checks.verifyRuntime(config, target));
  if (!matchesM6RuntimeTarget(readiness, target)) throw new Error("Fresh M6 runtime verification changed its frozen target");
  const currentDeployment = m6WorkerDeploymentEvidenceSchema.parse(await checks.inspectDeployment(config, target.worker_version_id));
  if (JSON.stringify(currentDeployment) !== JSON.stringify(deployment)) throw new Error("Fresh M6 deployment changed during runtime verification");
  if ((await configuration(env, target)).etag !== etag) throw new Error("Fresh M6 configuration changed during verification");
  await requireEmptyService(env);
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
