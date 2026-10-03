import { m6RuntimeReadinessSchema, m6ServiceConfigHash, parseServiceConfig } from "../../packages/shared/src/index";
import { describeCachedDeliveryRuntime } from "../lifecycle-delivery-gate";
import type { M6InitializationEnv } from "../m6-service-initialization";
import { publicationFixture, PUBLICATION_SERVICE_TEXT } from "./publication";

export async function m6InitializationFixture() {
  const setup = await publicationFixture();
  setup.entries.clear();
  setup.writes.length = 0;
  await setup.bucket.put("system/service.toml", PUBLICATION_SERVICE_TEXT);
  const config = parseServiceConfig(PUBLICATION_SERVICE_TEXT);
  const versionId = crypto.randomUUID();
  const target = { operation_id: crypto.randomUUID(), deployment_id: crypto.randomUUID(), worker_version_id: versionId,
    service_config_sha256: await m6ServiceConfigHash(config) };
  const env: M6InitializationEnv & { CASTLOOP_ADMIN_KEY: string } = { CASTLOOP_BUCKET: setup.bucket as never,
    CASTLOOP_VERSION_METADATA: { id: versionId }, CASTLOOP_ADMIN_KEY: "private-secret" };
  const readiness = m6RuntimeReadinessSchema.parse({ ...target, default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets",
    cutover_verified: true, publication_routes_verified: true });
  const deployment = { schema_version: 1, service_id: config.service_id, account_id: config.account_id, worker_name: config.worker_name,
    deployment_id: target.deployment_id, worker_version_id: versionId, compatibility_date: "2026-10-01", traffic_percentage: 100,
    default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets", cached_entrypoint_enabled: true, cross_version_cache_disabled: true,
    version_metadata_binding_verified: true, service_bindings_verified: true, observability_enabled: true, workers_dev_previews_disabled: true };
  const checks = { inspectDeployment: async () => deployment, verifyRuntime: async () => readiness };
  const bindings = { versionMetadata: { id: versionId }, gatewayProtocol: "m6-uncached-gateway-v1" as const,
    cachedAssets: { describeRuntime: async () => describeCachedDeliveryRuntime({ id: versionId }, { purge: async () => ({ success: true, errors: [] }) }) } };
  return { bucket: setup.bucket, entries: setup.entries, writes: setup.writes, text: setup.text,
    env, config, versionId, target, readiness, deployment, checks, bindings };
}
