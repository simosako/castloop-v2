import { serviceConfigSchema } from "@castloop/shared";
import { prepareMigrationBridgeDeployment } from "../migration-bridge-deployment";
import type { MigrationBridgeReads } from "../migration-bridge-deployment";

export function bridgeDeploymentFixture() {
  const config = serviceConfigSchema.parse({ schema_version: 1, service_id: "probe", account_id: "a".repeat(32),
    bucket_name: "probe-bucket", worker_name: "probe-worker", queue_name: "probe-queue", dlq_name: "probe-dlq",
    public_base_url: "https://probe-worker.account.workers.dev" });
  const legacyVersionId = crypto.randomUUID();
  const bridgeId = crypto.randomUUID();
  const source = "export default {fetch(){return new Response()}};";
  const settings = { compatibility_date: "2026-09-30T00:00:00Z", compatibility_flags: ["nodejs_compat"],
    cache_options: { enabled: true }, observability: { enabled: true, head_sampling_rate: 0.25, traces: { enabled: true } },
    bindings: [{ name: "CASTLOOP_BUCKET", type: "r2_bucket", bucket_name: config.bucket_name },
      { name: "CASTLOOP_QUEUE", type: "queue", queue_name: config.queue_name },
      { name: "CASTLOOP_DLQ_NAME", type: "plain_text", text: config.dlq_name },
      { name: "CASTLOOP_ADMIN_KEY", type: "secret_text" }, { name: "EXTRA_KV", type: "kv_namespace", namespace_id: "original-kv" }],
    tags: ["existing-tag"], logpush: false, placement: { mode: "smart" }, tail_consumers: [{ service: "tail" }] };
  const version = { id: legacyVersionId, metadata: { author_email: "private@example.com" }, resources: {
    bindings: structuredClone(settings.bindings), script: { handlers: ["fetch", "queue"], named_handlers: [] as Array<{ name: string; handlers: string[] }> },
    script_runtime: { compatibility_date: "2026-09-30", compatibility_flags: [...settings.compatibility_flags],
      exports: { default: { type: "worker", cache: { enabled: true } } } } } };
  const deployments = { deployments: [{ id: crypto.randomUUID(), strategy: "percentage", versions: [{ version_id: legacyVersionId, percentage: 100 }] }] };
  const subdomain = { enabled: true, previews_enabled: true };
  const reads: MigrationBridgeReads = { deployments: async () => structuredClone(deployments), settings: async () => structuredClone(settings),
    version: async () => structuredClone(version), subdomain: async () => structuredClone(subdomain), domains: async () => [] };
  const prepare = (inputReads: MigrationBridgeReads = reads) => prepareMigrationBridgeDeployment(config, legacyVersionId, bridgeId, source, inputReads);
  return { config, legacyVersionId, bridgeId, source, settings, version, deployments, subdomain, reads, prepare };
}
