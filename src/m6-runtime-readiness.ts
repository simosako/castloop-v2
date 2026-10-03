import { m6RuntimeReadinessSchema, m6ServiceConfigHash, m6WorkerDeploymentEvidenceSchema, parseServiceConfig } from "../packages/shared/src/index";
import type { M6RuntimeReadiness, M6RuntimeTarget, ServiceConfig } from "../packages/shared/src/index";
import type { LifecycleControlEnv, LifecycleReadEnv } from "./lifecycle-control";

export type M6RuntimeEnv = LifecycleControlEnv & { CASTLOOP_VERSION_METADATA: Pick<WorkerVersionMetadata, "id"> };
export type M6RuntimeChecks = {
  inspectDeployment: (config: ServiceConfig, workerVersionId: string) => Promise<unknown>;
  verifyRuntime: (config: ServiceConfig, target: M6RuntimeTarget) => Promise<unknown>;
};
export type M6RuntimeConfiguration = { config: ServiceConfig; etag: string };

export function matchesM6RuntimeTarget(value: M6RuntimeTarget | undefined, target: M6RuntimeTarget): boolean {
  return value?.operation_id === target.operation_id && value.deployment_id === target.deployment_id &&
    value.worker_version_id === target.worker_version_id && value.service_config_sha256 === target.service_config_sha256;
}

export async function readM6ServiceConfiguration(env: LifecycleReadEnv): Promise<M6RuntimeConfiguration> {
  const object = await env.CASTLOOP_BUCKET.get("system/service.toml");
  if (!object || object.size < 1 || object.size > 16384) throw new Error("M6 service configuration is missing or oversized");
  const config = parseServiceConfig(await object.text());
  return { config, etag: object.etag };
}

export async function readM6RuntimeConfiguration(env: M6RuntimeEnv, configHash: string, versionId: string): Promise<M6RuntimeConfiguration> {
  if (versionId !== env.CASTLOOP_VERSION_METADATA.id) throw new Error("Runtime verification targets another executing Worker version");
  const { config, etag } = await readM6ServiceConfiguration(env);
  if (await m6ServiceConfigHash(config) !== configHash) throw new Error("M6 service configuration differs from its frozen target");
  return { config, etag };
}

export async function verifyM6RuntimeReadiness(env: M6RuntimeEnv, target: M6RuntimeTarget,
  configuration: M6RuntimeConfiguration, checks: M6RuntimeChecks): Promise<M6RuntimeReadiness> {
  const { config, etag } = configuration;
  const deployment = m6WorkerDeploymentEvidenceSchema.parse(await checks.inspectDeployment(config, target.worker_version_id));
  if (deployment.service_id !== config.service_id || deployment.account_id !== config.account_id || deployment.worker_name !== config.worker_name ||
    deployment.worker_version_id !== target.worker_version_id || deployment.deployment_id !== target.deployment_id) {
    throw new Error("M6 deployment evidence targets another service or deployment");
  }
  const readiness = m6RuntimeReadinessSchema.parse(await checks.verifyRuntime(config, target));
  if (!matchesM6RuntimeTarget(readiness, target)) throw new Error("M6 runtime verification changed its frozen target");
  const current = m6WorkerDeploymentEvidenceSchema.parse(await checks.inspectDeployment(config, target.worker_version_id));
  if (JSON.stringify(current) !== JSON.stringify(deployment)) throw new Error("M6 deployment changed during runtime verification");
  if ((await readM6RuntimeConfiguration(env, target.service_config_sha256, target.worker_version_id)).etag !== etag) {
    throw new Error("M6 configuration changed during verification");
  }
  return readiness;
}
