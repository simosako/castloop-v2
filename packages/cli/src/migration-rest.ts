import { migrationBootstrapRequestSchema, serviceConfigSchema } from "@castloop/shared";
import type { MigrationAdminStatus, MigrationBootstrapRequest, ServiceConfig } from "@castloop/shared";
import { CloudflareApi } from "./cloudflare-api";
import { MigrationAdminClient } from "./migration-client";
import { migrationPayloadHash } from "./migration-deployment";
import type { MigrationDeploymentEffects } from "./migration-deployment";

function requireOwnedMigration(status: MigrationAdminStatus, request: MigrationBootstrapRequest): void {
  if (status.admission?.service_id !== request.service_id || status.admission.state !== "migrating" ||
    status.admission.mode !== "legacy" || status.admission.invocations.length || status.admission.migration?.execution_id ||
    status.admission.migration?.migration_id !== request.migration_id || status.admission.migration.request_sha256 !== request.request_sha256 ||
    status.progress?.plan_sha256 !== request.plan_sha256 || status.progress.phase !== "runtime") {
    throw new Error("Migration REST deploy requires its idle initialized legacy migration owner");
  }
}

export function createMigrationRestEffects(input: ServiceConfig, inputRequest: MigrationBootstrapRequest, adminKey: string,
  dependencies: { api?: CloudflareApi; client?: MigrationAdminClient } = {}): MigrationDeploymentEffects {
  const config = serviceConfigSchema.parse(input);
  const request = migrationBootstrapRequestSchema.parse(inputRequest);
  if (request.service_id !== config.service_id) throw new Error("Migration REST effects target another service");
  const api = dependencies.api ?? new CloudflareApi(config);
  const client = dependencies.client ?? new MigrationAdminClient(config, adminKey);
  const requireRequest = (input: MigrationBootstrapRequest) => {
    if (JSON.stringify(migrationBootstrapRequestSchema.parse(input)) !== JSON.stringify(request)) throw new Error("Migration effect received a different frozen request");
  };
  return {
    prepare: async (input) => {
      requireRequest(input);
      const status = await client.status();
      requireOwnedMigration(status, request);
      if (status.worker_protocol !== "legacy_fenced" || status.worker_version_id !== request.bridge_worker_version_id) {
        throw new Error("HTTP migration bridge does not match the expected deployed version");
      }
      const metadata = await api.migrationCandidateUploadMetadata(config, request.bootstrap_id, request.bridge_worker_version_id);
      if (migrationPayloadHash(metadata) !== request.worker_metadata_sha256) throw new Error("REST bridge metadata differs from this frozen deployment request");
      await client.prepareDeployment(request);
    },
    begin: async (input) => { requireRequest(input); return client.beginDeployment(request); },
    deploy: async (source, metadata) => {
      const bridge = await client.status();
      requireOwnedMigration(bridge, request);
      if (bridge.worker_protocol !== "legacy_fenced" || bridge.worker_version_id !== request.bridge_worker_version_id ||
        bridge.bootstrap?.phase !== "deploying" || JSON.stringify(bridge.bootstrap.request) !== JSON.stringify(request)) {
        throw new Error("Server has no matching consumed start authorization for this candidate upload");
      }
      await api.uploadMigrationCandidate(config, request, source, metadata);
      const candidate = await client.status();
      requireOwnedMigration(candidate, request);
      if (candidate.worker_protocol !== "m6_candidate" || candidate.worker_bootstrap_id !== request.bootstrap_id ||
        candidate.worker_version_id === request.bridge_worker_version_id || candidate.bootstrap?.phase !== "deploying" ||
        JSON.stringify(candidate.bootstrap.request) !== JSON.stringify(request)) {
        throw new Error("Candidate status does not identify the newly uploaded bootstrap; preserve the unknown deploy outcome");
      }
      await api.disableMigrationWorkerPreviews(config, candidate.worker_version_id);
      return candidate.worker_version_id;
    },
    inspect: (versionId) => api.inspectM6WorkerDeployment(config, versionId),
    settle: async (input, evidence) => { requireRequest(input); await client.settleDeployment(request, evidence); },
  };
}
