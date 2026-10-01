import { describe, expect, test } from "bun:test";
import { migrationBridgePreparationSchema, migrationBridgeUploadSchema, serviceConfigSchema } from "@castloop/shared";
import { CloudflareApi } from "./cloudflare-api";
import { buildMigrationBridgeUpload, prepareMigrationBridgeDeployment } from "./migration-bridge-deployment";
import type { MigrationBridgeReads } from "./migration-bridge-deployment";
import { migrationPayloadHash } from "./migration-deployment";

function fixture() {
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

describe("read-only initial migration bridge preparation", () => {
  test("freezes legacy IDs/cache uncertainty and bridge bytes, without recording private API metadata", async () => {
    const setup = fixture();
    const result = await setup.prepare();
    expect(migrationBridgePreparationSchema.parse(result.request)).toEqual(result.request);
    expect(migrationBridgeUploadSchema.parse(result.metadata)).toEqual(result.metadata);
    expect(result.request.legacy_cross_version_cache).toBe("unspecified");
    expect(result.request.legacy_previews_enabled).toBe(true);
    expect(result.request.legacy_default_cache_enabled).toBe(true);
    expect(result.request.legacy_settings_sha256).toBe(migrationPayloadHash(setup.settings));
    expect(result.request.worker_source_sha256).toBe(migrationPayloadHash(setup.source));
    expect(result.request.worker_metadata_sha256).toBe(migrationPayloadHash(result.metadata));
    expect(result.metadata.exports).toEqual({ default: { type: "worker", cache: { enabled: false } } });
    expect(result.metadata.cache_options).toEqual({ enabled: true, cross_version_cache: false });
    expect(result.metadata.annotations).toEqual({ "workers/tag": setup.bridgeId });
    expect(result.metadata.bindings.find((binding) => binding.name === "CASTLOOP_ADMIN_KEY"))
      .toEqual({ name: "CASTLOOP_ADMIN_KEY", type: "inherit", version_id: setup.legacyVersionId });
    expect(result.metadata.bindings.find((binding) => binding.name === "EXTRA_KV"))
      .toEqual({ name: "EXTRA_KV", type: "inherit", version_id: setup.legacyVersionId });
    expect(result.metadata.observability.head_sampling_rate).toBe(0.25);
    expect(result.metadata.observability.logs?.enabled).toBe(true);
    expect(result.metadata.tags).toEqual(setup.settings.tags);
    expect(result.metadata.logpush).toBe(false);
    for (const privateField of ["private@example.com", "namespace_id", "old_io_quiesced", "old_cache_purged", "cutover_verified"]) {
      expect(JSON.stringify(result.request)).not.toContain(privateField);
    }
  });

  test("observed cross-version flags remain explicit and are never inferred from omission", async () => {
    for (const enabled of [true, false]) {
      const setup = fixture();
      const result = await setup.prepare({ ...setup.reads, settings: async () => ({ ...setup.settings,
        cache_options: { enabled: true, cross_version_cache: enabled } }) });
      expect(result.request.legacy_cross_version_cache).toBe(enabled ? "enabled" : "disabled");
      expect(result.metadata.cache_options.cross_version_cache).toBe(false);
    }
  });

  test("another version/partial rollout/custom domain/disabled workers.dev cannot be a preparation target", async () => {
    const setup = fixture();
    for (const reads of [
      { ...setup.reads, deployments: async () => ({ deployments: [{ ...setup.deployments.deployments[0]!, versions: [{ version_id: crypto.randomUUID(), percentage: 100 }] }] }) },
      { ...setup.reads, deployments: async () => ({ deployments: [{ ...setup.deployments.deployments[0]!, versions: [{ version_id: setup.legacyVersionId, percentage: 99 }] }] }) },
      { ...setup.reads, domains: async () => [{ hostname: "podcast.example.com" }] },
      { ...setup.reads, subdomain: async () => ({ enabled: false, previews_enabled: false }) },
    ]) await expect(setup.prepare(reads)).rejects.toThrow();
  });

  test("unknown/mismatched runtime, wrong bindings and migration versions fail closed", async () => {
    const setup = fixture();
    const wrongVersion = { ...setup.version, id: crypto.randomUUID() };
    const wrongHandlers = structuredClone(setup.version);
    wrongHandlers.resources.script.handlers = ["fetch"];
    const wrongDate = structuredClone(setup.version);
    wrongDate.resources.script_runtime.compatibility_date = "2026-10-02";
    const named = structuredClone(setup.version);
    named.resources.script.named_handlers.push({ name: "CachedPublicAssets", handlers: ["fetch"] });
    const changedExtraBinding = structuredClone(setup.version);
    changedExtraBinding.resources.bindings.find((binding) => binding.name === "EXTRA_KV")!.namespace_id = "foreign-kv";
    for (const version of [wrongVersion, wrongHandlers, wrongDate, named, changedExtraBinding]) {
      await expect(setup.prepare({ ...setup.reads, version: async () => version })).rejects.toThrow();
    }
    for (const settings of [
      { ...setup.settings, bindings: [...setup.settings.bindings, { name: "CASTLOOP_VERSION_METADATA", type: "version_metadata" }] },
      { ...setup.settings, bindings: setup.settings.bindings.filter((binding) => binding.name !== "CASTLOOP_ADMIN_KEY") },
      { ...setup.settings, bindings: setup.settings.bindings.map((binding) => binding.name === "CASTLOOP_BUCKET" ? { ...binding, bucket_name: "foreign" } : binding) },
      { ...setup.settings, compatibility_flags: ["disable_ctx_exports"] },
      { ...setup.settings, compatibility_date: "" }, { ...setup.settings, cache_options: { enabled: false } },
    ]) expect(() => buildMigrationBridgeUpload(setup.config, settings, setup.bridgeId, setup.legacyVersionId)).toThrow();
  });

  test("bridge upload schema retains all common gates but never allows a candidate cache export", async () => {
    const { metadata } = await fixture().prepare();
    for (const input of [
      { ...metadata, exports: { ...metadata.exports, CachedPublicAssets: { type: "worker", cache: { enabled: true } } } },
      { ...metadata, exports: { default: { type: "worker", cache: { enabled: true } } } },
      { ...metadata, compatibility_flags: [] }, { ...metadata, annotations: { "workers/tag": "invalid" } },
      { ...metadata, bindings: [...metadata.bindings, metadata.bindings[0]!] },
      { ...metadata, observability: { enabled: true, traces: { enabled: true } } },
      { ...metadata, secret: "private" },
    ]) expect(migrationBridgeUploadSchema.safeParse(input).success).toBe(false);
  });

  test("re-reads catch legacy deployment/settings/previews changes including unknown binding payload fields", async () => {
    for (const change of ["deployment", "settings", "previews"] as const) {
      const setup = fixture();
      let deployments = 0;
      let settings = 0;
      let previews = 0;
      const reads: MigrationBridgeReads = { ...setup.reads,
        deployments: async () => ({ deployments: [{ ...setup.deployments.deployments[0]!,
          ...(change === "deployment" && ++deployments === 2 ? { id: crypto.randomUUID() } : {}) }] }),
        settings: async () => {
          settings += 1;
          return { ...setup.settings, bindings: setup.settings.bindings.map((binding) =>
            change === "settings" && settings === 2 && binding.name === "EXTRA_KV" ? { ...binding, namespace_id: "changed-kv" } : binding) };
        },
        subdomain: async () => ({ enabled: true, previews_enabled: !(change === "previews" && ++previews === 2) }),
      };
      await expect(setup.prepare(reads)).rejects.toThrow("changed");
    }
  });

  test("real API adapter prepares through GET only, keeps authentication fixed and rejects foreign origins before HTTP", async () => {
    const setup = fixture();
    const originalFetch = globalThis.fetch;
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const requests: Request[] = [];
    process.env.CLOUDFLARE_ACCOUNT_ID = setup.config.account_id;
    process.env.CLOUDFLARE_API_TOKEN = "private-api-token";
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      expect(init?.redirect).toBe("error");
      expect(request.method).toBe("GET");
      expect(request.headers.get("Authorization")).toBe("Bearer private-api-token");
      requests.push(request);
      const url = new URL(request.url);
      expect(url.origin).toBe("https://api.cloudflare.com");
      const value = url.pathname.endsWith("/deployments") ? setup.deployments : url.pathname.endsWith("/settings") ? setup.settings :
        url.pathname.includes("/versions/") ? setup.version : url.pathname.endsWith("/domains") ? [] : setup.subdomain;
      return Response.json({ success: true, result: value });
    }, { preconnect: () => {} });
    try {
      const api = new CloudflareApi(setup.config);
      const result = await api.prepareMigrationBridge(setup.config, setup.legacyVersionId, setup.bridgeId, setup.source);
      expect(result.request.bridge_id).toBe(setup.bridgeId);
      expect(requests).toHaveLength(8);
      await expect(api.prepareMigrationBridge({ ...setup.config, public_base_url: "https://podcast.example.com" },
        setup.legacyVersionId, setup.bridgeId, setup.source)).rejects.toThrow("workers.dev");
      expect(requests).toHaveLength(8);
    } finally {
      globalThis.fetch = originalFetch;
      if (account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = account;
      if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = token;
    }
  });
});
