import { describe, expect, test } from "bun:test";
import { migrationCandidateUploadSchema, parseServiceConfig } from "@castloop/shared";
import type { MigrationCandidateUpload } from "@castloop/shared";
import { CloudflareApi } from "./cloudflare-api";
import { buildM6WorkerUploadMetadata } from "./m6-worker-deployment";
import { MigrationAdminClient } from "./migration-client";
import { createMigrationDeploymentJournal, migrationPayloadHash, resumeMigrationCandidateSettlement, runMigrationCandidateDeployment } from "./migration-deployment";
import { createMigrationRestEffects } from "./migration-rest";
import { bootstrapFixture } from "../../../src/test-support/bootstrap";
import { handleMigrationAdmin } from "../../../src/migration-admin";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

type Failure = "put-response" | "preview-response" | "foreign-candidate" | "partial-rollout" | "inspect-cache" |
  "bridge-cache" | "bridge-preview" | "bridge-settings-drift";

async function fixture() {
  const setup = await bootstrapFixture(true, "https://test-worker.account.workers.dev");
  const config = parseServiceConfig(setup.entries.get("system/service.toml")!.data);
  const source = "export default {}; export class CachedPublicAssets {}";
  const initialMetadata = buildM6WorkerUploadMetadata(config, null, "private-key");
  const bridge = { ...initialMetadata, cache_options: { enabled: true, cross_version_cache: true },
    exports: { default: { type: "worker", cache: { enabled: false } } } };
  const requests: Request[] = [];
  let uploaded: MigrationCandidateUpload | undefined;
  let deployed = false;
  let failure: Failure | undefined;
  let bridgeSettingsReads = 0;
  const bridgeDeploymentId = crypto.randomUUID();
  const candidateDeploymentId = setup.settlement.deployment.deployment_id;
  const result = (input: unknown) => Response.json({ success: true, result: input });
  const version = (id: string) => {
    const metadata = id === setup.bridgeVersion ? bridge : uploaded!;
    return { id, resources: { bindings: metadata.bindings.map((binding) => binding.type === "inherit" ?
      bridge.bindings.find((previous) => previous.name === binding.name)! : binding),
      script: { handlers: ["fetch", "queue"], named_handlers: id === setup.bridgeVersion ? [] : [{ name: "CachedPublicAssets", handlers: ["fetch"] }] },
      script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags, exports: metadata.exports } } };
  };
  const transport = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    expect(init?.redirect).toBe("error");
    const request = new Request(input, init);
    requests.push(request.clone());
    const url = new URL(request.url);
    if (url.hostname === "api.cloudflare.com") {
      expect(request.headers.get("Authorization")).toBe("Bearer private-api-token");
      expect(request.headers.get("X-Castloop-Key")).toBeNull();
      expect(url.pathname.startsWith(`/client/v4/accounts/${config.account_id}/workers/`)).toBe(true);
      if (request.method === "GET" && url.pathname.endsWith("/deployments")) return result({ deployments: [{
        id: deployed ? candidateDeploymentId : bridgeDeploymentId, strategy: "percentage", versions: [{ version_id: deployed ? setup.candidateVersion : setup.bridgeVersion,
          percentage: deployed && failure === "partial-rollout" ? 99 : 100 }], author_email: "private@example.com" }] });
      if (request.method === "GET" && url.pathname.endsWith("/settings")) {
        bridgeSettingsReads += 1;
        return result(deployed ? { ...uploaded!,
        ...(failure === "inspect-cache" ? { exports: { ...uploaded!.exports, default: { type: "worker", cache: { enabled: true } } } } : {}),
        bindings: version(setup.candidateVersion).resources.bindings } : { ...bridge,
          ...(failure === "bridge-cache" ? { exports: { default: { type: "worker", cache: { enabled: true } } } } : {}),
          ...(failure === "bridge-settings-drift" && bridgeSettingsReads % 2 === 0 ? { tags: ["changed-settings"] } : {}) });
      }
      if (request.method === "GET" && url.pathname.includes("/versions/")) return result(version(url.pathname.split("/").at(-1)!));
      if (request.method === "GET" && url.pathname.endsWith("/domains")) return result([]);
      if (request.method === "GET" && url.pathname.endsWith("/subdomain")) return result({ enabled: true, previews_enabled: failure === "bridge-preview" });
      if (request.method === "PUT" && url.pathname.endsWith(`/scripts/${config.worker_name}`)) {
        expect(url.searchParams.get("bindings_inherit")).toBe("strict");
        const form = await request.formData();
        const metadata: unknown = JSON.parse(String(form.get("metadata")));
        uploaded = migrationCandidateUploadSchema.parse(metadata);
        expect(uploaded.bindings.find((binding) => binding.name === "CASTLOOP_ADMIN_KEY")).toEqual({ name: "CASTLOOP_ADMIN_KEY", type: "inherit", version_id: setup.bridgeVersion });
        expect(JSON.stringify(uploaded)).not.toContain("private-key");
        const script = form.get("index.js");
        expect(script instanceof Blob).toBe(true);
        if (!(script instanceof Blob)) throw new Error("Missing uploaded module");
        expect(await script.text()).toBe(source);
        deployed = true;
        if (failure === "put-response") throw new Error("Uploaded but response was lost");
        return result({ id: config.worker_name, startup_time_ms: 10 });
      }
      if (request.method === "POST" && url.pathname.endsWith("/subdomain")) {
        expect(await request.json<{ enabled: boolean; previews_enabled: boolean }>()).toEqual({ enabled: true, previews_enabled: false });
        if (failure === "preview-response") throw new Error("Preview request response lost");
        return result({ enabled: true, previews_enabled: false });
      }
      throw new Error("Unexpected Cloudflare request");
    }
    expect(url.origin).toBe(new URL(config.public_base_url).origin);
    expect(request.headers.get("Authorization")).toBeNull();
    expect(request.headers.get("X-Castloop-Key")).toBe("private-key");
    const runtime = deployed ? { ...setup.candidate, ...(failure === "foreign-candidate" ? { workerBootstrapId: crypto.randomUUID() } : {}) } : setup.bridge;
    const response = await handleMigrationAdmin(request, setup.env, runtime);
    if (!response) throw new Error("Unexpected administrator request");
    return response;
  }, { preconnect: () => {} });
  const withTransport = async <T>(run: () => Promise<T>): Promise<T> => {
    const originalFetch = globalThis.fetch;
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_ACCOUNT_ID = config.account_id;
    process.env.CLOUDFLARE_API_TOKEN = "private-api-token";
    globalThis.fetch = transport;
    try { return await run(); }
    finally {
      globalThis.fetch = originalFetch;
      if (account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = account;
      if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = token;
    }
  };
  const root = mkdtempSync("/tmp/opencode/castloop-migration-rest-");
  return { ...setup, config, source, root, requests, withTransport, transport,
    setFailure: (input?: Failure) => { failure = input; }, dispose: () => rmSync(root, { recursive: true }) };
}

async function payload(setup: Awaited<ReturnType<typeof fixture>>) {
  const api = new CloudflareApi(setup.config);
  const metadata = await api.migrationCandidateUploadMetadata(setup.config, setup.bootstrapRequest.bootstrap_id, setup.bridgeVersion);
  const request = { ...setup.bootstrapRequest, worker_source_sha256: migrationPayloadHash(setup.source), worker_metadata_sha256: migrationPayloadHash(metadata) };
  const journal = createMigrationDeploymentJournal(setup.root, request);
  const effects = createMigrationRestEffects(setup.config, request, "private-key", { api,
    client: new MigrationAdminClient(setup.config, "private-key", setup.transport) });
  return { api, metadata, request, journal, effects };
}

describe("migration REST deploy adapter and durable client composition", () => {
  test("consumed start gates one exact PUT, runtime tag discovers version, then previews/GET inspection/settlement", async () => {
    const setup = await fixture();
    try {
      await setup.withTransport(async () => {
        const input = await payload(setup);
        await runMigrationCandidateDeployment(input.journal, input.effects, setup.source, input.metadata);
        const writes = setup.requests.filter((request) => request.method !== "GET");
        expect(writes.map((request) => `${request.method} ${new URL(request.url).pathname.split("/").at(-1)}`))
          .toEqual(["POST prepare-deployment", "POST begin-deployment", `PUT ${setup.config.worker_name}`, "POST subdomain", "POST settle-deployment"]);
        expect(input.journal.load().phase).toBe("settled");
        expect(input.journal.load().worker_version_id).toBe(setup.candidateVersion);
        const status = await new MigrationAdminClient(setup.config, "private-key", setup.transport).status();
        expect(status.worker_bootstrap_id).toBe(input.request.bootstrap_id);
        expect(status.admission?.state).toBe("migrating");
        expect(status.m6_ready).toBe(false);
        const record = readFileSync(join(setup.root, ".castloop", "migrations", `${input.request.bootstrap_id}.json`), "utf8");
        for (const secret of ["private-key", "private-api-token", "private@example.com"]) expect(record).not.toContain(secret);
      });
    } finally { setup.dispose(); }
  });

  test("lost PUT/preview response or wrong version/tag keeps unknown outcome and never retries mutation", async () => {
    for (const failure of ["put-response", "preview-response", "foreign-candidate", "partial-rollout"] as const) {
      const setup = await fixture();
      try {
        await setup.withTransport(async () => {
          const input = await payload(setup);
          setup.setFailure(failure);
          await expect(runMigrationCandidateDeployment(input.journal, input.effects, setup.source, input.metadata)).rejects.toThrow();
          expect(input.journal.load().phase).toBe("uploading");
          const before = setup.requests.length;
          await expect(runMigrationCandidateDeployment(input.journal, input.effects, setup.source, input.metadata)).rejects.toThrow("automatically replay");
          await expect(resumeMigrationCandidateSettlement(input.journal, input.effects)).rejects.toThrow("outcome is unknown");
          expect(setup.requests).toHaveLength(before);
          expect(setup.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
          expect(setup.requests.some((request) => request.url.endsWith("/settle-deployment"))).toBe(false);
        });
      } finally { setup.dispose(); }
    }
  });

  test("failed cache inspection after settled REST resumes only GETs and the same settlement", async () => {
    const setup = await fixture();
    try {
      await setup.withTransport(async () => {
        const input = await payload(setup);
        setup.setFailure("inspect-cache");
        await expect(runMigrationCandidateDeployment(input.journal, input.effects, setup.source, input.metadata)).rejects.toThrow();
        expect(input.journal.load().phase).toBe("rest_settled");
        setup.setFailure();
        await resumeMigrationCandidateSettlement(input.journal, input.effects);
        expect(input.journal.load().phase).toBe("settled");
        expect(setup.requests.filter((request) => request.method === "PUT")).toHaveLength(1);
        expect(setup.requests.filter((request) => request.method === "POST" && request.url.endsWith("/subdomain"))).toHaveLength(1);
      });
    } finally { setup.dispose(); }
  });

  test("adapter cannot upload without server start authorization even when source hashes match", async () => {
    const setup = await fixture();
    try {
      await setup.withTransport(async () => {
        const input = await payload(setup);
        await expect(input.effects.deploy(setup.source, input.metadata)).rejects.toThrow("consumed start authorization");
        expect(setup.requests.some((request) => request.method !== "GET")).toBe(false);
      });
    } finally { setup.dispose(); }
  });

  test("cacheable bridge, old previews and changing settings reject preparation before any mutation", async () => {
    for (const failure of ["bridge-cache", "bridge-preview", "bridge-settings-drift"] as const) {
      const setup = await fixture();
      try {
        await setup.withTransport(async () => {
          const input = await payload(setup);
          setup.setFailure(failure);
          await expect(runMigrationCandidateDeployment(input.journal, input.effects, setup.source, input.metadata)).rejects.toThrow();
          expect(input.journal.load().phase).toBe("prepared");
          expect(setup.requests.some((request) => request.method !== "GET")).toBe(false);
        });
      } finally { setup.dispose(); }
    }
  });

  test("REST profile rejects another account/origin before HTTP rather than deploying to custom domains", async () => {
    const setup = await fixture();
    try {
      await setup.withTransport(async () => {
        const api = new CloudflareApi(setup.config);
        for (const config of [{ ...setup.config, account_id: "b".repeat(32) }, { ...setup.config, public_base_url: "https://podcast.example.com" }]) {
          await expect(api.migrationCandidateUploadMetadata(config, setup.bootstrapRequest.bootstrap_id, setup.bridgeVersion)).rejects.toThrow("workers.dev");
        }
        expect(setup.requests).toEqual([]);
      });
    } finally { setup.dispose(); }
  });
});
