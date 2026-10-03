import { migrationBootstrapRequestSchema, migrationCandidateUploadSchema, m6WorkerDeploymentEvidenceSchema, serviceConfigSchema, workerDeploymentsSnapshotSchema, workerSettingsSnapshotSchema,
  workerSubdomainSnapshotSchema, workerVersionSnapshotSchema } from "./index";
import type { MigrationCandidateUpload, M6WorkerDeploymentEvidence, ServiceConfig, WorkerSettingsSnapshot } from "./index";
import { z } from "zod";

export const M6_WORKER_COMPATIBILITY_DATE = "2026-10-01";
export const M6_FRESH_WORKER_COMPATIBILITY_DATE = "2026-10-03";
const MANAGED_BINDINGS = new Set(["CASTLOOP_BUCKET", "CASTLOOP_QUEUE", "CASTLOOP_DLQ_NAME", "CASTLOOP_ADMIN_KEY", "CASTLOOP_VERSION_METADATA"]);

export type M6WorkerUploadMetadata = {
  main_module: string; compatibility_date: string; compatibility_flags: string[];
  cache_options: { enabled: boolean; cross_version_cache: boolean };
  exports: { default: { type: string; cache: { enabled: boolean } }; CachedPublicAssets: { type: string; cache: { enabled: boolean } } };
  observability: { enabled: boolean; logs: { enabled: boolean; [key: string]: unknown };
    traces: { enabled: boolean; [key: string]: unknown }; [key: string]: unknown };
  bindings: Array<{ name: string; type: string; bucket_name?: string; queue_name?: string; text?: string; version_id?: string }>;
  tags?: string[]; tail_consumers?: Array<Record<string, unknown>>; placement?: Record<string, unknown>; logpush?: boolean;
};

export function buildM6WorkerUploadMetadata(input: ServiceConfig, previousInput: unknown, adminKey: string,
  compatibilityDate = M6_WORKER_COMPATIBILITY_DATE): M6WorkerUploadMetadata {
  const config = serviceConfigSchema.parse(input);
  const previous = previousInput === null ? null : workerSettingsSnapshotSchema.parse(previousInput);
  if (previous?.compatibility_flags?.includes("disable_ctx_exports")) throw new Error("M6 requires ctx.exports; inspect conflicting compatibility flags before migration");
  const existingAdmin = previous?.bindings.find((binding) => binding.name === "CASTLOOP_ADMIN_KEY");
  if (existingAdmin && existingAdmin.type !== "secret_text") throw new Error("Existing administrator binding is not a Worker secret");
  if (!existingAdmin && !adminKey) throw new Error("M6 Worker requires an administrator secret");
  const observability = previous?.observability;
  return {
    main_module: "index.js", compatibility_date: compatibilityDate,
    compatibility_flags: [...new Set([...(previous?.compatibility_flags ?? []), "enable_ctx_exports"])],
    cache_options: { enabled: true, cross_version_cache: false },
    exports: { default: { type: "worker", cache: { enabled: false } }, CachedPublicAssets: { type: "worker", cache: { enabled: true } } },
    observability: { ...observability, enabled: true, logs: { ...observability?.logs, enabled: true }, traces: { ...observability?.traces, enabled: true } },
    ...(previous?.tags ? { tags: previous.tags } : {}),
    ...(previous?.tail_consumers ? { tail_consumers: previous.tail_consumers } : {}),
    ...(previous?.placement ? { placement: previous.placement } : {}),
    ...(previous?.logpush !== undefined ? { logpush: previous.logpush } : {}),
    bindings: [
      { name: "CASTLOOP_BUCKET", type: "r2_bucket", bucket_name: config.bucket_name },
      { name: "CASTLOOP_QUEUE", type: "queue", queue_name: config.queue_name },
      { name: "CASTLOOP_DLQ_NAME", type: "plain_text", text: config.dlq_name },
      { name: "CASTLOOP_VERSION_METADATA", type: "version_metadata" },
      existingAdmin ? { name: "CASTLOOP_ADMIN_KEY", type: "inherit" } : { name: "CASTLOOP_ADMIN_KEY", type: "secret_text", text: adminKey },
      ...(previous?.bindings.filter((binding) => !MANAGED_BINDINGS.has(binding.name)).map((binding) => ({ name: binding.name, type: "inherit" })) ?? []),
    ],
  };
}

export type M6DeploymentReads = {
  deployments: () => Promise<unknown>;
  settings: () => Promise<unknown>;
  version: (versionId: string) => Promise<unknown>;
  subdomain: () => Promise<unknown>;
};

export const m6DeploymentSnapshotSchema = z.object({
  deployments: z.tuple([workerDeploymentsSnapshotSchema, workerDeploymentsSnapshotSchema]),
  settings: z.tuple([workerSettingsSnapshotSchema, workerSettingsSnapshotSchema]),
  subdomain: z.tuple([workerSubdomainSnapshotSchema, workerSubdomainSnapshotSchema]),
  version: workerVersionSnapshotSchema,
}).strict();
export type M6DeploymentSnapshot = z.infer<typeof m6DeploymentSnapshotSchema>;

export function m6SnapshotReads(input: M6DeploymentSnapshot): M6DeploymentReads {
  const snapshot = m6DeploymentSnapshotSchema.parse(input);
  let deployment = 0;
  let settings = 0;
  let subdomain = 0;
  return { deployments: async () => snapshot.deployments[deployment++], settings: async () => snapshot.settings[settings++],
    subdomain: async () => snapshot.subdomain[subdomain++], version: async () => snapshot.version };
}

export async function collectM6DeploymentSnapshot(config: ServiceConfig, versionId: string, reads: M6DeploymentReads,
  expectedCompatibilityDate: string): Promise<M6DeploymentSnapshot> {
  const deployments: unknown[] = [];
  const settings: WorkerSettingsSnapshot[] = [];
  const subdomain: unknown[] = [];
  let version: unknown;
  await inspectM6WorkerDeployment(config, versionId, {
    deployments: async () => {
      const value = workerDeploymentsSnapshotSchema.parse(await reads.deployments());
      deployments.push({ deployments: [value.deployments[0]!] });
      return value;
    },
    settings: async () => {
      const value = workerSettingsSnapshotSchema.parse(await reads.settings());
      settings.push(value);
      return value;
    },
    subdomain: async () => { const value = workerSubdomainSnapshotSchema.parse(await reads.subdomain()); subdomain.push(value); return value; },
    version: async (id) => { version = workerVersionSnapshotSchema.parse(await reads.version(id)); return version; },
  }, expectedCompatibilityDate);
  const safeBindings = (bindings: WorkerSettingsSnapshot["bindings"]) => bindings.filter((binding) => MANAGED_BINDINGS.has(binding.name))
    .map((binding) => ({ name: binding.name, type: binding.type,
      ...(binding.name === "CASTLOOP_BUCKET" ? { bucket_name: binding.bucket_name } : {}),
      ...(binding.name === "CASTLOOP_QUEUE" ? { queue_name: binding.queue_name } : {}),
      ...(binding.name === "CASTLOOP_DLQ_NAME" ? { text: binding.text } : {}) }));
  const parsedVersion = workerVersionSnapshotSchema.parse(version);
  return m6DeploymentSnapshotSchema.parse({ deployments, subdomain,
    version: { ...parsedVersion, resources: { ...parsedVersion.resources, bindings: safeBindings(parsedVersion.resources.bindings) } },
    settings: settings.map((value) => ({ bindings: safeBindings(value.bindings), cache_options: value.cache_options, exports: value.exports,
      compatibility_date: value.compatibility_date, compatibility_flags: value.compatibility_flags,
      observability: { enabled: value.observability?.enabled, logs: { enabled: value.observability?.logs?.enabled },
        traces: { enabled: value.observability?.traces?.enabled } } })),
  });
}

function latestDeployment(input: unknown, expectedVersionId: string) {
  const deployment = workerDeploymentsSnapshotSchema.parse(input).deployments[0]!;
  if (deployment.versions.length !== 1 || deployment.versions[0]!.version_id !== expectedVersionId || deployment.versions[0]!.percentage !== 100) {
    throw new Error("M6 requires one expected Worker version serving 100% of traffic");
  }
  return deployment;
}

function compatibilityDate(input: string, expected: string): string {
  const date = /^\d{4}-\d{2}-\d{2}(?:T00:00:00Z)?$/.test(input) ? input.slice(0, 10) : "";
  if (date !== expected) throw new Error("M6 Worker compatibility date does not match this runtime build");
  return date;
}

function verifyBindings(bindings: WorkerSettingsSnapshot["bindings"], config: ServiceConfig): void {
  if (new Set(bindings.map((binding) => binding.name)).size !== bindings.length) throw new Error("Worker version has duplicate bindings");
  const expected = [
    { name: "CASTLOOP_BUCKET", type: "r2_bucket", field: "bucket_name", value: config.bucket_name },
    { name: "CASTLOOP_QUEUE", type: "queue", field: "queue_name", value: config.queue_name },
    { name: "CASTLOOP_DLQ_NAME", type: "plain_text", field: "text", value: config.dlq_name },
    { name: "CASTLOOP_ADMIN_KEY", type: "secret_text" },
    { name: "CASTLOOP_VERSION_METADATA", type: "version_metadata" },
  ] as const;
  for (const item of expected) {
    const binding = bindings.find((binding) => binding.name === item.name);
    if (!binding || binding.type !== item.type || "field" in item && binding[item.field] !== item.value) {
      throw new Error("M6 Worker bindings do not match this service");
    }
  }
}

function verifyExports(input: WorkerSettingsSnapshot["exports"]): void {
  if (!input || Object.keys(input).length !== 2 || input.default?.cache.enabled !== false || input.CachedPublicAssets?.cache.enabled !== true) {
    throw new Error("M6 requires an uncached default export and exactly one CachedPublicAssets cache owner");
  }
}

function settingsEvidence(input: unknown, config: ServiceConfig, expectedCompatibilityDate: string): string {
  const settings = workerSettingsSnapshotSchema.parse(input);
  verifyBindings(settings.bindings, config);
  verifyExports(settings.exports);
  if (settings.cache_options?.enabled !== true || settings.cache_options.cross_version_cache !== false) {
    throw new Error("M6 requires version-isolated Workers Caching");
  }
  const date = compatibilityDate(settings.compatibility_date ?? "", expectedCompatibilityDate);
  const flags = settings.compatibility_flags ?? [];
  if (!flags.includes("enable_ctx_exports") || flags.includes("disable_ctx_exports")) throw new Error("M6 loopback compatibility flags do not match this runtime build");
  if (settings.observability?.enabled !== true || settings.observability.logs?.enabled !== true || settings.observability.traces?.enabled !== true) {
    throw new Error("M6 requires Worker logs and traces enabled");
  }
  return JSON.stringify({ date, flags: [...flags].sort(), exports: { default: false, CachedPublicAssets: true },
    cache_options: { enabled: true, cross_version_cache: false },
    bindings: settings.bindings.filter((binding) => MANAGED_BINDINGS.has(binding.name)).map((binding) => ({ name: binding.name,
      type: binding.type, ...(binding.name === "CASTLOOP_BUCKET" ? { bucket_name: binding.bucket_name } : {}),
      ...(binding.name === "CASTLOOP_QUEUE" ? { queue_name: binding.queue_name } : {}),
      ...(binding.name === "CASTLOOP_DLQ_NAME" ? { text: binding.text } : {}) })).sort((left, right) => left.name.localeCompare(right.name)),
    observability: { enabled: true, logs: true, traces: true } });
}

export async function inspectM6WorkerDeployment(input: ServiceConfig, expectedVersionId: string, reads: M6DeploymentReads,
  expectedCompatibilityDate = M6_WORKER_COMPATIBILITY_DATE): Promise<M6WorkerDeploymentEvidence> {
  const config = serviceConfigSchema.parse(input);
  m6WorkerDeploymentEvidenceSchema.shape.worker_version_id.parse(expectedVersionId);
  const first = latestDeployment(await reads.deployments(), expectedVersionId);
  const version = workerVersionSnapshotSchema.parse(await reads.version(expectedVersionId));
  if (version.id !== expectedVersionId) throw new Error("Cloudflare returned a different Worker version");
  verifyBindings(version.resources.bindings, config);
  verifyExports(version.resources.script_runtime.exports);
  const runtime = version.resources.script_runtime;
  const date = compatibilityDate(runtime.compatibility_date, expectedCompatibilityDate);
  if (!runtime.compatibility_flags.includes("enable_ctx_exports") || runtime.compatibility_flags.includes("disable_ctx_exports")) {
    throw new Error("M6 version does not enable the gateway loopback protocol");
  }
  if (!version.resources.script.handlers.includes("fetch") || !version.resources.script.handlers.includes("queue") ||
    version.resources.script.named_handlers.length !== 1 ||
    version.resources.script.named_handlers[0]?.name !== "CachedPublicAssets" || !version.resources.script.named_handlers[0].handlers.includes("fetch")) {
    throw new Error("M6 Worker does not export its gateway, consumer and named cache entrypoint");
  }
  const settings = settingsEvidence(await reads.settings(), config, expectedCompatibilityDate);
  const subdomain = workerSubdomainSnapshotSchema.parse(await reads.subdomain());
  if (!subdomain.enabled || subdomain.previews_enabled) throw new Error("M6 requires workers.dev enabled with old-version previews disabled");
  const currentSettings = settingsEvidence(await reads.settings(), config, expectedCompatibilityDate);
  const currentSubdomain = workerSubdomainSnapshotSchema.parse(await reads.subdomain());
  const current = latestDeployment(await reads.deployments(), expectedVersionId);
  if (current.id !== first.id || JSON.stringify(current) !== JSON.stringify(first) || currentSettings !== settings ||
    JSON.stringify(currentSubdomain) !== JSON.stringify(subdomain)) throw new Error("Worker deployment or runtime settings changed during M6 inspection");
  return m6WorkerDeploymentEvidenceSchema.parse({ schema_version: 1, service_id: config.service_id, account_id: config.account_id,
    worker_name: config.worker_name, deployment_id: first.id, worker_version_id: expectedVersionId, compatibility_date: date,
    traffic_percentage: 100, default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets", cached_entrypoint_enabled: true,
    cross_version_cache_disabled: true, version_metadata_binding_verified: true, service_bindings_verified: true,
    observability_enabled: true, workers_dev_previews_disabled: true });
}

export function requireMigrationBridgeSettings(input: unknown, config: ServiceConfig): WorkerSettingsSnapshot {
  const settings = workerSettingsSnapshotSchema.parse(input);
  verifyBindings(settings.bindings, config);
  if (!settings.exports || Object.keys(settings.exports).length !== 1 || settings.exports.default?.cache.enabled !== false ||
    settings.cache_options?.enabled !== true || settings.cache_options.cross_version_cache === undefined) {
    throw new Error("Migration deploy requires explicit uncached bridge settings, not a legacy or M6 candidate Worker");
  }
  compatibilityDate(settings.compatibility_date ?? "", M6_WORKER_COMPATIBILITY_DATE);
  if (!settings.compatibility_flags?.includes("enable_ctx_exports") || settings.compatibility_flags.includes("disable_ctx_exports") ||
    settings.observability?.enabled !== true || settings.observability.logs?.enabled !== true || settings.observability.traces?.enabled !== true) {
    throw new Error("Migration bridge compatibility/telemetry does not match this build");
  }
  return settings;
}

export function requireMigrationBridgeVersion(input: unknown, config: ServiceConfig, expectedVersionId: string): void {
  const version = workerVersionSnapshotSchema.parse(input);
  verifyBindings(version.resources.bindings, config);
  const runtime = version.resources.script_runtime;
  compatibilityDate(runtime.compatibility_date, M6_WORKER_COMPATIBILITY_DATE);
  if (version.id !== expectedVersionId || Object.keys(runtime.exports).length !== 1 || runtime.exports.default?.cache.enabled !== false ||
    !runtime.compatibility_flags.includes("enable_ctx_exports") || runtime.compatibility_flags.includes("disable_ctx_exports") ||
    !version.resources.script.handlers.includes("fetch") || !version.resources.script.handlers.includes("queue") ||
    version.resources.script.named_handlers.length) throw new Error("Executing bridge version does not match its expected runtime profile");
}

export function buildMigrationCandidateUpload(config: ServiceConfig, previousInput: unknown, bootstrapId: string,
  bridgeVersionId: string): MigrationCandidateUpload {
  migrationBootstrapRequestSchema.shape.bootstrap_id.parse(bootstrapId);
  migrationBootstrapRequestSchema.shape.bridge_worker_version_id.parse(bridgeVersionId);
  const previous = requireMigrationBridgeSettings(previousInput, config);
  const metadata = buildM6WorkerUploadMetadata(config, previous, "");
  return migrationCandidateUploadSchema.parse({ ...metadata, annotations: { "workers/tag": bootstrapId },
    bindings: metadata.bindings.map((binding) => binding.type === "inherit" ? { ...binding, version_id: bridgeVersionId } : binding) });
}
