import { describe, expect, test } from "bun:test";
import { legacyWorkerInspectionSchema, migrationBridgePreparationSchema, migrationBridgeUploadSchema } from "@castloop/shared";
import { CloudflareApi } from "./cloudflare-api";
import { buildMigrationBridgeUpload, inspectLegacyServiceDeployment } from "./migration-bridge-deployment";
import type { MigrationBridgeReads } from "./migration-bridge-deployment";
import { migrationPayloadHash } from "./migration-deployment";

import { bridgeDeploymentFixture as fixture } from "./test-support/migration-bridge";

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

  test("read-only inspection shares preparation checks without generating IDs, freezing upload bytes or authorizing mutations", async () => {
    const setup = fixture();
    const report = await inspectLegacyServiceDeployment(setup.config, setup.legacyVersionId, setup.reads);
    expect(legacyWorkerInspectionSchema.parse(report)).toEqual(report);
    const prepared = await setup.prepare();
    expect(report.legacy_version_profile_sha256).toBe(prepared.request.legacy_version_profile_sha256);
    expect(report.legacy_settings_sha256).toBe(prepared.request.legacy_settings_sha256);
    expect(report.legacy_deployment_id).toBe(prepared.request.legacy_deployment_id);
    expect(report).toMatchObject({ snapshot_only: true, authorizes_deployment: false,
      authorizes_mutation: false, authorizes_recovery: false, authorizes_migration_completion: false });
    for (const value of [setup.config.account_id, setup.bridgeId, setup.source, "private@example.com", "original-kv"] ) {
      expect(JSON.stringify(report)).not.toContain(value);
    }
    for (const key of ["authorizes_deployment", "authorizes_mutation", "authorizes_recovery", "authorizes_migration_completion"]) {
      expect(legacyWorkerInspectionSchema.safeParse({ ...report, [key]: true }).success).toBe(false);
    }
    expect(legacyWorkerInspectionSchema.safeParse({ ...report, arbitrary: "private" }).success).toBe(false);
    await expect(inspectLegacyServiceDeployment(setup.config, crypto.randomUUID(), setup.reads)).rejects.toThrow("single legacy version");
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

  test("observed legacy omissions require a closed downloaded module and matching explicit cache and empty flags", async () => {
    const setup = fixture();
    const version = { id: setup.legacyVersionId, resources: { bindings: setup.version.resources.bindings,
      script: { handlers: ["fetch", "queue"] }, script_runtime: { compatibility_date: "2026-09-30",
        cache_options: { enabled: true, cross_version_cache: false } } } };
    const settings = { ...setup.settings, compatibility_flags: [], cache_options: { enabled: true, cross_version_cache: false } };
    let downloads = 0;
    const module = 'export default {fetch(){return new Response("private source")},queue(){}};';
    const reads: MigrationBridgeReads = { ...setup.reads, version: async () => version, settings: async () => settings,
      script: async () => {
        downloads += 1;
        const form = new FormData();
        form.append("index.js", new Blob([module], { type: "application/javascript+module" }), "index.js");
        return new Response(form);
      } };
    const first = await setup.prepare(reads);
    const second = await setup.prepare(reads);
    expect(downloads).toBe(4);
    expect(first).toEqual(second);
    expect(first.request.legacy_default_cache_enabled).toBe(true);
    expect(first.request.legacy_cross_version_cache).toBe("disabled");
    expect(first.request.legacy_previews_enabled).toBe(true);
    expect(first.metadata.compatibility_flags).toEqual(["enable_ctx_exports"]);
    expect(JSON.stringify(first.request)).not.toContain("private source");
    await expect(setup.prepare({ ...reads, script: undefined })).rejects.toThrow("module inspection");
    await expect(setup.prepare({ ...reads, settings: async () => setup.settings })).rejects.toThrow("explicitly empty");
    await expect(setup.prepare({ ...reads, settings: async () => ({ ...settings, compatibility_flags: undefined }) })).rejects.toThrow("explicitly empty");
    await expect(setup.prepare({ ...reads, settings: async () => ({ ...settings, exports: setup.version.resources.script_runtime.exports }) })).rejects.toThrow("inherited global cache");
    await expect(setup.prepare({ ...reads, settings: async () => ({ ...settings, cache_options: { enabled: true } }) })).rejects.toThrow("inherited global cache");
    await expect(setup.prepare({ ...reads, version: async () => ({ ...version, resources: { ...version.resources,
      script_runtime: { ...version.resources.script_runtime, cache_options: undefined } } }) })).rejects.toThrow("inherited global cache");
    await expect(setup.prepare({ ...reads, script: async () => new Response("export default {}; export class Hidden {}",
      { headers: { "Content-Type": "application/javascript" } }) })).rejects.toThrow("no deployment is authorized");
  });

  test("source changes and normal metadata changes remain fail-closed on legacy fallback", async () => {
    const setup = fixture();
    const version = { id: setup.legacyVersionId, resources: { bindings: setup.version.resources.bindings,
      script: { handlers: ["fetch", "queue"] }, script_runtime: { compatibility_date: "2026-09-30", cache_options: { enabled: true } } } };
    const settings = { ...setup.settings, compatibility_flags: [] };
    const reads: MigrationBridgeReads = { ...setup.reads, version: async () => version, settings: async () => settings,
      script: async () => new Response("export default {};", { headers: { "Content-Type": "application/javascript" } }) };
    let downloaded = 0;
    await expect(setup.prepare({ ...reads, script: async () => new Response(`export default {value:${++downloaded}};`,
      { headers: { "Content-Type": "application/javascript" } }) })).rejects.toThrow("module changed");
    let observed = 0;
    await expect(setup.prepare({ ...reads, settings: async () => ({ ...settings,
      tags: ++observed === 1 ? ["before"] : ["after"] }) })).rejects.toThrow("changed");
    const original = await setup.prepare(reads);
    const changed = await setup.prepare({ ...reads, script: async () => new Response("export default {value:1};",
      { headers: { "Content-Type": "application/javascript" } }) });
    expect(changed.request.legacy_version_profile_sha256).not.toBe(original.request.legacy_version_profile_sha256);
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
