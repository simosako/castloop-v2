import { migrationBridgeDeploymentRequestSchema, serviceConfigSchema } from "@castloop/shared";
import type { MigrationAdminStatus, MigrationBridgeDeploymentRequest, ServiceConfig } from "@castloop/shared";
import { CloudflareApi } from "./cloudflare-api";
import { MigrationAdminClient } from "./migration-client";
import type { MigrationBridgeEffects } from "./migration-bridge-journal";

export function createMigrationBridgeRestEffects(input: ServiceConfig, inputRequest: MigrationBridgeDeploymentRequest, adminKey: string,
  dependencies: { api?: CloudflareApi; client?: MigrationAdminClient } = {}): MigrationBridgeEffects {
  const config = serviceConfigSchema.parse(input);
  const request = migrationBridgeDeploymentRequestSchema.parse(inputRequest);
  const preparation = request.preparation;
  if (preparation.service_id !== config.service_id || preparation.account_id !== config.account_id || preparation.worker_name !== config.worker_name) {
    throw new Error("Initial bridge effects target another service/account/Worker");
  }
  const api = dependencies.api ?? new CloudflareApi(config);
  const client = dependencies.client ?? new MigrationAdminClient(config, adminKey);
  const requireInitialBridge = (status: MigrationAdminStatus, versionId?: string) => {
    if (status.worker_protocol !== "legacy_fenced" || status.worker_bridge_id !== preparation.bridge_id ||
      status.worker_version_id === preparation.legacy_worker_version_id || versionId && status.worker_version_id !== versionId ||
      status.progress || status.bootstrap || status.admission && (status.admission.mode !== "legacy" || status.admission.state === "migrating" ||
        status.admission.migration || status.admission.readiness)) throw new Error("Initial bridge HTTP status does not match the installed version/tag and unmigrated service");
  };
  return {
    preflight: async (source) => {
      const current = await api.prepareMigrationBridge(config, preparation.legacy_worker_version_id, preparation.bridge_id, source);
      if (JSON.stringify(current.request) !== JSON.stringify(preparation)) throw new Error("Legacy snapshot differs from the frozen initial bridge request");
    },
    deploy: async (source, metadata) => {
      await api.uploadMigrationBridge(config, request, source, metadata);
      const status = await client.status();
      requireInitialBridge(status);
      await api.disableMigrationWorkerPreviews(config, status.worker_version_id);
      const current = await client.status();
      requireInitialBridge(current, status.worker_version_id);
      return status.worker_version_id;
    },
    inspect: async (versionId) => {
      requireInitialBridge(await client.status(), versionId);
      const evidence = await api.inspectMigrationBridge(config, preparation.bridge_id, versionId);
      requireInitialBridge(await client.status(), versionId);
      return evidence;
    },
  };
}
