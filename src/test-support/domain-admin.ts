import { domainOperationRequestSchema, m6ServiceConfigHash, serviceManagementBaseUrl, stringifyToml } from "../../packages/shared/src/index";
import { pauseServiceAdmission, readServiceAdmission } from "../service-admission";
import { lifecycleAdminFixture } from "./lifecycle-admin";

export async function domainAdminFixture() {
  const setup = await lifecycleAdminFixture();
  const env = setup.candidateEnv;
  const management = serviceManagementBaseUrl(setup.config);
  const config = { ...setup.config, public_base_url: management };
  await setup.bucket.put("system/service.toml", stringifyToml(config));
  const pauseId = crypto.randomUUID();
  await pauseServiceAdmission(env, "service", pauseId, setup.versionId);
  const admission = (await readServiceAdmission(env, "service"))!.value;
  const request = domainOperationRequestSchema.parse({ operation_id: crypto.randomUUID(), service_id: "service", pause_id: pauseId,
    expected_service_generation: admission.generation, worker_version_id: setup.versionId,
    service_config_sha256: await m6ServiceConfigHash(config), workers_dev_base_url: management,
    public_base_url: "https://podcasts.example.com", domain_change: { action: "add", hostname: "podcasts.example.com" },
    target_service_config_sha256: await m6ServiceConfigHash({ ...config, public_base_url: "https://podcasts.example.com", workers_dev_base_url: management }) });
  return { ...setup, config, env, request, pauseId, management };
}
