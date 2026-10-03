import { m6RuntimeReadinessSchema, m6ServiceUpdateRequestSchema } from "../../packages/shared/src/index";
import { completeM6ServiceInitialization, prepareM6ServiceInitialization } from "../m6-service-initialization";
import { readServiceAdmission } from "../service-admission";
import { m6InitializationFixture } from "./m6-initialization";

export async function m6UpdateFixture() {
  const setup = await m6InitializationFixture();
  await prepareM6ServiceInitialization(setup.env, setup.target);
  await completeM6ServiceInitialization(setup.env, setup.target, setup.checks);
  const request = m6ServiceUpdateRequestSchema.parse({ operation_id: crypto.randomUUID(), service_id: setup.config.service_id,
    expected_service_generation: (await readServiceAdmission(setup.env, setup.config.service_id))!.value.generation,
    pause_id: setup.target.operation_id, previous_worker_version_id: setup.versionId,
    service_config_sha256: setup.target.service_config_sha256, worker_source_sha256: "a".repeat(64), worker_metadata_sha256: "b".repeat(64) });
  const target = { ...setup.target, operation_id: request.operation_id, deployment_id: crypto.randomUUID(), worker_version_id: crypto.randomUUID() };
  const newEnv = { ...setup.env, CASTLOOP_VERSION_METADATA: { id: target.worker_version_id } };
  const readiness = m6RuntimeReadinessSchema.parse({ ...setup.readiness, ...target });
  const checks = { inspectDeployment: async () => ({ ...setup.deployment, deployment_id: target.deployment_id, worker_version_id: target.worker_version_id }),
    verifyRuntime: async () => readiness };
  return { ...setup, request, newTarget: target, newEnv, newReadiness: readiness, updateChecks: checks };
}
