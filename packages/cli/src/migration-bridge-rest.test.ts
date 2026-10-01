import { describe, expect, test } from "bun:test";
import { migrationBridgeDeploymentRequestSchema, migrationBridgeUploadSchema, stringifyToml } from "@castloop/shared";
import type { MigrationBridgeUpload } from "@castloop/shared";
import { CloudflareApi } from "./cloudflare-api";
import { createMigrationBridgeJournal, resumeMigrationBridgeInspection, runMigrationBridgeDeployment } from "./migration-bridge-journal";
import { createMigrationBridgeRestEffects } from "./migration-bridge-rest";
import { MigrationAdminClient } from "./migration-client";
import { bridgeDeploymentFixture } from "./test-support/migration-bridge";
import bridgeWorker from "../../../src/migration-bridge-worker";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

type Failure = "put-response" | "preview-response" | "foreign-tag" | "partial-rollout" | "inspect-cache" | "legacy-drift" | "between-preflights";

async function fixture() {
  const setup = bridgeDeploymentFixture();
  const prepared = await setup.prepare();
  const request = migrationBridgeDeploymentRequestSchema.parse({ schema_version: 1, preparation: prepared.request,
    administrator_writes_stopped: true, other_deployers_stopped: true });
  const root = mkdtempSync("/tmp/opencode/castloop-bridge-rest-");
  const journal = createMigrationBridgeJournal(root, request);
  const workerVersionId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();
  const requests: Request[] = [];
  let uploaded: MigrationBridgeUpload | undefined;
  let deployed = false;
  let previewEnabled = true;
  let failure: Failure | undefined;
  let legacySettingsReads = 0;
  const serviceSource = stringifyToml(setup.config);
  const result = (input: unknown) => Response.json({ success: true, result: input });
  const version = () => ({ id: workerVersionId, resources: {
    bindings: uploaded!.bindings.map((binding) => binding.type === "inherit" ? setup.settings.bindings.find((previous) => previous.name === binding.name)! : binding),
    script: { handlers: ["fetch", "queue"], named_handlers: [] }, script_runtime: { compatibility_date: uploaded!.compatibility_date,
      compatibility_flags: uploaded!.compatibility_flags, exports: uploaded!.exports } } });
  const transport = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    expect(init?.redirect).toBe("error");
    const http = new Request(input, init);
    requests.push(http.clone());
    const url = new URL(http.url);
    if (url.hostname === "api.cloudflare.com") {
      expect(http.headers.get("Authorization")).toBe("Bearer private-api-token");
      expect(http.headers.get("X-Castloop-Key")).toBeNull();
      if (http.method === "GET" && url.pathname.endsWith("/deployments")) return result(deployed ? { deployments: [{ id: deploymentId,
        strategy: "percentage", versions: [{ version_id: workerVersionId, percentage: failure === "partial-rollout" ? 99 : 100 }] }] } : setup.deployments);
      if (http.method === "GET" && url.pathname.endsWith("/settings")) {
        if (!deployed) legacySettingsReads += 1;
        return result(deployed ? { ...uploaded!, bindings: version().resources.bindings,
        ...(failure === "inspect-cache" ? { exports: { default: { type: "worker", cache: { enabled: true } } } } : {}) } :
        { ...setup.settings, ...(failure === "legacy-drift" || failure === "between-preflights" && legacySettingsReads > 2 ? { tags: ["new-out-of-band-settings"] } : {}) });
      }
      if (http.method === "GET" && url.pathname.includes("/versions/")) return result(deployed ? version() : setup.version);
      if (http.method === "GET" && url.pathname.endsWith("/domains")) return result([]);
      if (http.method === "GET" && url.pathname.endsWith("/subdomain")) return result({ enabled: true, previews_enabled: previewEnabled });
      if (http.method === "PUT" && url.pathname.endsWith(`/scripts/${setup.config.worker_name}`)) {
        expect(url.searchParams.get("bindings_inherit")).toBe("strict");
        expect(journal.load().phase).toBe("uploading");
        const form = await http.formData();
        uploaded = migrationBridgeUploadSchema.parse(JSON.parse(String(form.get("metadata"))));
        expect(uploaded.annotations["workers/tag"]).toBe(setup.bridgeId);
        expect(uploaded.bindings.find((binding) => binding.name === "CASTLOOP_ADMIN_KEY"))
          .toEqual({ name: "CASTLOOP_ADMIN_KEY", type: "inherit", version_id: setup.legacyVersionId });
        const source = form.get("index.js");
        if (!(source instanceof Blob)) throw new Error("Missing bridge source");
        expect(await source.text()).toBe(setup.source);
        deployed = true;
        if (failure === "put-response") throw new Error("PUT accepted but response lost");
        return result({ id: setup.config.worker_name });
      }
      if (http.method === "POST" && url.pathname.endsWith("/subdomain")) {
        expect(await http.json<{ enabled: boolean; previews_enabled: boolean }>()).toEqual({ enabled: true, previews_enabled: false });
        previewEnabled = false;
        if (failure === "preview-response") throw new Error("Preview response lost");
        return result({ enabled: true, previews_enabled: false });
      }
      throw new Error("Unexpected Cloudflare request");
    }
    expect(url.origin).toBe(new URL(setup.config.public_base_url).origin);
    expect(http.headers.get("Authorization")).toBeNull();
    expect(http.headers.get("X-Castloop-Key")).toBe("private-admin-key");
    if (!deployed) throw new Error("Old Worker has no bridge administrator route");
    const env = { CASTLOOP_ADMIN_KEY: "private-admin-key", CASTLOOP_VERSION_METADATA: { id: workerVersionId,
      tag: failure === "foreign-tag" ? crypto.randomUUID() : setup.bridgeId, timestamp: "2026-10-02T12:00:00Z" },
      CASTLOOP_BUCKET: { get: async (key: string) => key === "system/service.toml" ? {
        size: new TextEncoder().encode(serviceSource).length, text: async () => serviceSource,
      } : null } } as never;
    return bridgeWorker.fetch(http as never, env, {} as never);
  }, { preconnect: () => {} });
  const withTransport = async <T>(callback: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    globalThis.fetch = transport;
    process.env.CLOUDFLARE_ACCOUNT_ID = setup.config.account_id;
    process.env.CLOUDFLARE_API_TOKEN = "private-api-token";
    try { return await callback(); }
    finally {
      globalThis.fetch = original;
      if (account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = account;
      if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = token;
    }
  };
  const effects = () => createMigrationBridgeRestEffects(setup.config, request, "private-admin-key", {
    api: new CloudflareApi(setup.config), client: new MigrationAdminClient(setup.config, "private-admin-key", transport),
  });
  return { ...setup, ...prepared, request, root, journal, workerVersionId, requests, withTransport, effects,
    setFailure: (input?: Failure) => { failure = input; }, dispose: () => rmSync(root, { recursive: true }) };
}

describe("initial bridge REST deployment with the durable one-time driver", () => {
  test("one frozen PUT and awaited preview change precede GET-only verified receipt without initializing R2", async () => {
    const setup = await fixture();
    try {
      await setup.withTransport(async () => {
        await runMigrationBridgeDeployment(setup.journal, setup.effects(), setup.source, setup.metadata);
        expect(setup.journal.load().phase).toBe("verified");
        expect(setup.journal.load().worker_version_id).toBe(setup.workerVersionId);
        expect(setup.requests.filter((request) => request.method !== "GET").map((request) => request.method)).toEqual(["PUT", "POST"]);
        expect(setup.requests.some((request) => new URL(request.url).pathname.includes("/r2/"))).toBe(false);
        const persisted = readFileSync(join(setup.root, ".castloop", "bridge-deployments", "probe.json"), "utf8");
        for (const privateValue of ["private-api-token", "private-admin-key", setup.source, "original-kv", "private@example.com", "old_io_quiesced", "old_cache_purged"]) {
          expect(persisted).not.toContain(privateValue);
        }
      });
    } finally { setup.dispose(); }
  });

  test("lost PUT/preview response, foreign runtime tag or partial rollout never gets an automatic mutation retry", async () => {
    for (const failure of ["put-response", "preview-response", "foreign-tag", "partial-rollout"] as const) {
      const setup = await fixture();
      try {
        await setup.withTransport(async () => {
          setup.setFailure(failure);
          const effects = setup.effects();
          await expect(runMigrationBridgeDeployment(setup.journal, effects, setup.source, setup.metadata)).rejects.toThrow();
          expect(setup.journal.load().phase).toBe("uploading");
          const before = setup.requests.length;
          await expect(runMigrationBridgeDeployment(setup.journal, effects, setup.source, setup.metadata)).rejects.toThrow("replay PUT");
          await expect(resumeMigrationBridgeInspection(setup.journal, effects)).rejects.toThrow("unknown");
          expect(setup.requests).toHaveLength(before);
          expect(setup.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
        });
      } finally { setup.dispose(); }
    }
  });

  test("failed read-only inspection can resume without PUT, preview POST or R2 mutations", async () => {
    const setup = await fixture();
    try {
      await setup.withTransport(async () => {
        setup.setFailure("inspect-cache");
        const effects = setup.effects();
        await expect(runMigrationBridgeDeployment(setup.journal, effects, setup.source, setup.metadata)).rejects.toThrow();
        expect(setup.journal.load().phase).toBe("rest_settled");
        const before = setup.requests.length;
        setup.setFailure();
        await resumeMigrationBridgeInspection(setup.journal, effects);
        expect(setup.journal.load().phase).toBe("verified");
        expect(setup.requests.slice(before).every((request) => request.method === "GET")).toBe(true);
        expect(setup.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
        expect(setup.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      });
    } finally { setup.dispose(); }
  });

  test("a stale legacy preparation is rejected before consuming the local start or making any mutation", async () => {
    const setup = await fixture();
    try {
      await setup.withTransport(async () => {
        setup.setFailure("legacy-drift");
        await expect(runMigrationBridgeDeployment(setup.journal, setup.effects(), setup.source, setup.metadata)).rejects.toThrow("frozen");
        expect(setup.journal.load().phase).toBe("prepared");
        expect(setup.requests.every((request) => request.method === "GET")).toBe(true);
      });
    } finally { setup.dispose(); }
  });

  test("snapshot drift after the local start is consumed remains fail-closed even if no PUT was sent", async () => {
    const setup = await fixture();
    try {
      await setup.withTransport(async () => {
        setup.setFailure("between-preflights");
        const effects = setup.effects();
        await expect(runMigrationBridgeDeployment(setup.journal, effects, setup.source, setup.metadata)).rejects.toThrow("snapshot changed");
        expect(setup.journal.load().phase).toBe("uploading");
        expect(setup.requests.every((request) => request.method === "GET")).toBe(true);
        const before = setup.requests.length;
        await expect(runMigrationBridgeDeployment(setup.journal, effects, setup.source, setup.metadata)).rejects.toThrow("replay PUT");
        expect(setup.requests).toHaveLength(before);
      });
    } finally { setup.dispose(); }
  });
});
