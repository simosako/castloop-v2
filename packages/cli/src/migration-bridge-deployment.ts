import { legacyWorkerInspectionSchema, migrationBridgeDeploymentEvidenceSchema, migrationBridgePreparationSchema, migrationBridgeUploadSchema, serviceConfigSchema, workerDeploymentsSnapshotSchema,
  workerSettingsSnapshotSchema, workerSubdomainSnapshotSchema, workerVersionSnapshotSchema } from "@castloop/shared";
import type { LegacyWorkerInspection, MigrationBridgeDeploymentEvidence, MigrationBridgePreparation, MigrationBridgeUpload, ServiceConfig, WorkerSettingsSnapshot } from "@castloop/shared";
import { buildM6WorkerUploadMetadata, requireMigrationBridgeSettings, requireMigrationBridgeVersion } from "./m6-worker-deployment";
import type { M6DeploymentReads } from "./m6-worker-deployment";
import { migrationPayloadHash } from "./migration-deployment";
import { inspectLegacyWorkerScript } from "./legacy-worker-script";

const legacyBindingsSchema = workerSettingsSnapshotSchema.shape.bindings.element.passthrough().array().max(100);
const legacySettingsSchema = workerSettingsSnapshotSchema.safeExtend({ bindings: legacyBindingsSchema });
const legacyVersionSchema = workerVersionSnapshotSchema.extend({ resources:
  workerVersionSnapshotSchema.shape.resources.extend({ bindings: legacyBindingsSchema,
    script: workerVersionSnapshotSchema.shape.resources.shape.script.extend({
      named_handlers: workerVersionSnapshotSchema.shape.resources.shape.script.shape.named_handlers.optional(),
    }),
    script_runtime: workerVersionSnapshotSchema.shape.resources.shape.script_runtime.extend({
      compatibility_flags: workerVersionSnapshotSchema.shape.resources.shape.script_runtime.shape.compatibility_flags.optional(),
      exports: workerVersionSnapshotSchema.shape.resources.shape.script_runtime.shape.exports.optional(),
      cache_options: workerSettingsSnapshotSchema.shape.cache_options,
    }),
  }) });

function legacyDate(input: string): string {
  const date = /^\d{4}-\d{2}-\d{2}(?:T00:00:00Z)?$/.test(input) ? input.slice(0, 10) : "";
  migrationBridgePreparationSchema.shape.legacy_compatibility_date.parse(date);
  if (date > "2026-10-01") throw new Error("Legacy Worker compatibility date is newer than the migration bridge build");
  return date;
}

function settingsSnapshotHash(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Legacy settings snapshot is not an object");
  return migrationPayloadHash(input);
}

function requireLegacyBindings(bindings: WorkerSettingsSnapshot["bindings"], config: ServiceConfig): void {
  if (new Set(bindings.map((binding) => binding.name)).size !== bindings.length ||
    bindings.some((binding) => binding.name === "CASTLOOP_VERSION_METADATA")) {
    throw new Error("Initial bridge preparation cannot replace an M6/migration Worker or duplicate bindings");
  }
  const expected = [
    { name: "CASTLOOP_BUCKET", type: "r2_bucket", field: "bucket_name", value: config.bucket_name },
    { name: "CASTLOOP_QUEUE", type: "queue", field: "queue_name", value: config.queue_name },
    { name: "CASTLOOP_DLQ_NAME", type: "plain_text", field: "text", value: config.dlq_name },
    { name: "CASTLOOP_ADMIN_KEY", type: "secret_text", field: null, value: null },
  ] as const;
  for (const item of expected) {
    const binding = bindings.find((entry) => entry.name === item.name);
    if (!binding || binding.type !== item.type || item.field && binding[item.field] !== item.value) {
      throw new Error("Legacy Worker binding does not match this service's initial bridge target");
    }
  }
}

function checkedLegacySettings(config: ServiceConfig, previousInput: unknown): WorkerSettingsSnapshot {
  const previous = legacySettingsSchema.parse(previousInput);
  requireLegacyBindings(previous.bindings, config);
  legacyDate(previous.compatibility_date ?? "");
  if (previous.exports && (Object.keys(previous.exports).length !== 1 || !previous.exports.default)) {
    throw new Error("Initial bridge preparation requires a legacy default-only Worker");
  }
  if (!previous.cache_options || previous.cache_options.enabled !== true) throw new Error("Legacy cache configuration is not an inspectable supported profile");
  if (previous.compatibility_flags?.includes("disable_ctx_exports")) throw new Error("Legacy compatibility flags prevent migration loopbacks");
  return previous;
}

export function buildMigrationBridgeUpload(input: ServiceConfig, previousInput: unknown, bridgeId: string,
  legacyVersionId: string): MigrationBridgeUpload {
  const config = serviceConfigSchema.parse(input);
  migrationBridgePreparationSchema.shape.bridge_id.parse(bridgeId);
  migrationBridgePreparationSchema.shape.legacy_worker_version_id.parse(legacyVersionId);
  const previous = checkedLegacySettings(config, previousInput);
  const candidate = buildM6WorkerUploadMetadata(config, previous, "");
  return migrationBridgeUploadSchema.parse({ ...candidate, exports: { default: { type: "worker", cache: { enabled: false } } },
    annotations: { "workers/tag": bridgeId }, bindings: candidate.bindings.map((binding) =>
      binding.type === "inherit" ? { ...binding, version_id: legacyVersionId } : binding) });
}

export type MigrationBridgeReads = M6DeploymentReads & { domains: () => Promise<unknown>; script?: () => Promise<Response> };
type LegacyObservation = Omit<MigrationBridgePreparation, "bridge_id" | "worker_source_sha256" | "worker_metadata_sha256">;

async function readLegacyDeployment(input: ServiceConfig, expectedVersionId: string, reads: MigrationBridgeReads):
  Promise<{ observation: LegacyObservation; settings: WorkerSettingsSnapshot }> {
  const config = serviceConfigSchema.parse(input);
  migrationBridgePreparationSchema.shape.legacy_worker_version_id.parse(expectedVersionId);
  const deployment = (input: unknown) => {
    const value = workerDeploymentsSnapshotSchema.parse(input).deployments[0]!;
    if (value.versions.length !== 1 || value.versions[0]!.version_id !== expectedVersionId || value.versions[0]!.percentage !== 100) {
      throw new Error("Initial bridge preparation requires the expected single legacy version serving 100%");
    }
    return value;
  };
  const before = deployment(await reads.deployments());
  const version = legacyVersionSchema.parse(await reads.version(expectedVersionId));
  requireLegacyBindings(version.resources.bindings, config);
  const runtime = version.resources.script_runtime;
  if (version.id !== expectedVersionId || runtime.exports && (Object.keys(runtime.exports).length !== 1 || !runtime.exports.default) ||
    !version.resources.script.handlers.includes("fetch") || !version.resources.script.handlers.includes("queue") ||
    version.resources.script.named_handlers?.length) throw new Error("Legacy version is not the supported default-only fetch/queue runtime");
  const previousInput = await reads.settings();
  const previousHash = settingsSnapshotHash(previousInput);
  const previous = checkedLegacySettings(config, previousInput);
  if (!runtime.compatibility_flags && (!previous.compatibility_flags || previous.compatibility_flags.length)) {
    throw new Error("Omitted legacy version flags require explicitly empty current settings flags");
  }
  if (!runtime.exports && (previous.exports || runtime.cache_options?.enabled !== true ||
    JSON.stringify(runtime.cache_options) !== JSON.stringify(previous.cache_options))) {
    throw new Error("Omitted legacy exports require matching explicit inherited global cache settings");
  }
  const missingRuntimeFields = runtime.exports === undefined || runtime.compatibility_flags === undefined ||
    version.resources.script.named_handlers === undefined;
  let scriptHash: string | undefined;
  if (missingRuntimeFields) {
    if (!reads.script) throw new Error("Omitted legacy runtime fields require a bounded default-only module inspection");
    scriptHash = await inspectLegacyWorkerScript(await reads.script());
  }
  if (legacyDate(runtime.compatibility_date) !== legacyDate(previous.compatibility_date!) ||
    JSON.stringify(runtime.compatibility_flags ?? []) !== JSON.stringify(previous.compatibility_flags ?? []) ||
    JSON.stringify(version.resources.bindings) !== JSON.stringify(previous.bindings) ||
    previous.exports && JSON.stringify(runtime.exports) !== JSON.stringify(previous.exports)) {
    throw new Error("Legacy version and current settings differ; preserve the original Worker");
  }
  const domains = await reads.domains();
  if (!Array.isArray(domains) || domains.length) throw new Error("Initial bridge preparation does not support attached Custom Domains");
  const subdomain = workerSubdomainSnapshotSchema.parse(await reads.subdomain());
  if (!subdomain.enabled) throw new Error("Initial bridge preparation requires the existing workers.dev endpoint enabled");
  const currentSettingsInput = await reads.settings();
  legacySettingsSchema.parse(currentSettingsInput);
  if (scriptHash && scriptHash !== await inspectLegacyWorkerScript(await reads.script!())) {
    throw new Error("Legacy Worker module changed during initial bridge preparation");
  }
  const currentSubdomain = workerSubdomainSnapshotSchema.parse(await reads.subdomain());
  const current = deployment(await reads.deployments());
  if (JSON.stringify(current) !== JSON.stringify(before) || settingsSnapshotHash(currentSettingsInput) !== previousHash ||
    JSON.stringify(currentSubdomain) !== JSON.stringify(subdomain)) throw new Error("Legacy deployment/settings/previews changed during initial bridge preparation");
  const crossVersion = previous.cache_options!.cross_version_cache;
  const observation: LegacyObservation = { schema_version: 1, service_id: config.service_id, account_id: config.account_id,
    worker_name: config.worker_name, legacy_worker_version_id: expectedVersionId, legacy_deployment_id: before.id,
    legacy_compatibility_date: legacyDate(runtime.compatibility_date),
    legacy_default_cache_enabled: runtime.exports?.default!.cache.enabled ?? runtime.cache_options!.enabled,
    legacy_cross_version_cache: crossVersion === undefined ? "unspecified" : crossVersion ? "enabled" : "disabled",
    legacy_previews_enabled: subdomain.previews_enabled, legacy_settings_sha256: previousHash,
    legacy_version_profile_sha256: migrationPayloadHash(scriptHash ? { version, default_only_module_sha256: scriptHash } : version),
  };
  return { observation, settings: previous };
}

export async function inspectLegacyServiceDeployment(config: ServiceConfig, expectedVersionId: string,
  reads: MigrationBridgeReads): Promise<LegacyWorkerInspection> {
  const { observation } = await readLegacyDeployment(config, expectedVersionId, reads);
  const { account_id: _accountId, ...publicObservation } = observation;
  return legacyWorkerInspectionSchema.parse({ ...publicObservation, snapshot_only: true, authorizes_deployment: false,
    authorizes_mutation: false, authorizes_recovery: false, authorizes_migration_completion: false });
}

export async function prepareMigrationBridgeDeployment(input: ServiceConfig, expectedVersionId: string, bridgeId: string,
  source: string, reads: MigrationBridgeReads): Promise<{ request: MigrationBridgePreparation; metadata: MigrationBridgeUpload }> {
  const config = serviceConfigSchema.parse(input);
  migrationBridgePreparationSchema.shape.bridge_id.parse(bridgeId);
  if (!source) throw new Error("Initial bridge source is empty");
  const { observation, settings } = await readLegacyDeployment(config, expectedVersionId, reads);
  const metadata = buildMigrationBridgeUpload(config, settings, bridgeId, expectedVersionId);
  const request = migrationBridgePreparationSchema.parse({ ...observation, bridge_id: bridgeId,
    worker_source_sha256: migrationPayloadHash(source), worker_metadata_sha256: migrationPayloadHash(metadata) });
  return { request, metadata };
}

export async function inspectMigrationBridgeDeployment(input: ServiceConfig, bridgeId: string, expectedVersionId: string,
  reads: MigrationBridgeReads): Promise<MigrationBridgeDeploymentEvidence> {
  const config = serviceConfigSchema.parse(input);
  migrationBridgePreparationSchema.shape.bridge_id.parse(bridgeId);
  migrationBridgePreparationSchema.shape.legacy_worker_version_id.parse(expectedVersionId);
  const deployment = (input: unknown) => {
    const value = workerDeploymentsSnapshotSchema.parse(input).deployments[0]!;
    if (value.versions.length !== 1 || value.versions[0]!.version_id !== expectedVersionId || value.versions[0]!.percentage !== 100) {
      throw new Error("Initial bridge inspection requires the expected single version serving 100%");
    }
    return value;
  };
  const settings = (input: unknown) => {
    const value = requireMigrationBridgeSettings(input, config);
    if (value.cache_options!.cross_version_cache !== false) throw new Error("Initial bridge requires explicit version-isolated caching");
    return settingsSnapshotHash(input);
  };
  const first = deployment(await reads.deployments());
  requireMigrationBridgeVersion(await reads.version(expectedVersionId), config, expectedVersionId);
  const firstSettings = settings(await reads.settings());
  const domains = await reads.domains();
  if (!Array.isArray(domains) || domains.length) throw new Error("Initial bridge inspection does not support attached Custom Domains");
  const subdomain = workerSubdomainSnapshotSchema.parse(await reads.subdomain());
  if (!subdomain.enabled || subdomain.previews_enabled) throw new Error("Initial bridge requires workers.dev enabled and old previews disabled");
  const currentSettings = settings(await reads.settings());
  const currentSubdomain = workerSubdomainSnapshotSchema.parse(await reads.subdomain());
  const current = deployment(await reads.deployments());
  if (JSON.stringify(current) !== JSON.stringify(first) || currentSettings !== firstSettings ||
    JSON.stringify(currentSubdomain) !== JSON.stringify(subdomain)) throw new Error("Initial bridge deployment/settings/previews changed during inspection");
  return migrationBridgeDeploymentEvidenceSchema.parse({ schema_version: 1, service_id: config.service_id, account_id: config.account_id,
    worker_name: config.worker_name, bridge_id: bridgeId, deployment_id: first.id, worker_version_id: expectedVersionId,
    compatibility_date: "2026-10-01", traffic_percentage: 100, default_cache_disabled: true, cross_version_cache_disabled: true,
    version_metadata_binding_verified: true, service_bindings_verified: true, observability_enabled: true, workers_dev_previews_disabled: true });
}
