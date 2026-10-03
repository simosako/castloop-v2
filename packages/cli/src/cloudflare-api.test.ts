import { expect, test } from "bun:test";
import { m6ServiceConfigHash, m6ServiceUpdateRequestSchema, serviceAdmissionSchema, serviceConfigSchema, workerSettingsSnapshotSchema } from "@castloop/shared";
import { CloudflareApi, normalizeHostname } from "./cloudflare-api";
import { buildM6WorkerUploadMetadata, M6_FRESH_WORKER_COMPATIBILITY_DATE } from "./m6-worker-deployment";
import { createFreshM6RestEffects } from "./m6-initialization-rest";
import { createM6UpdateRestEffects } from "./m6-update-rest";
import { migrationPayloadHash } from "./migration-deployment";

const accountId = "a".repeat(32);
const worker = "castloop-example";
const config = serviceConfigSchema.parse({ schema_version: 1, service_id: "example", account_id: accountId,
  bucket_name: "example-private", worker_name: worker, queue_name: "example-queue",
  dlq_name: "example-dlq", public_base_url: "https://example.workers.dev" });
const zone = { id: "z".repeat(32), name: "example.com", type: "full", status: "active",
  account: { id: accountId } };
type Domain = { id: string; hostname: string; service: string; zone_id: string; zone_name: string };

async function withCloudflare(handler: (request: Request) => Response | Promise<Response>,
  run: (api: CloudflareApi) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    handler(new Request(input, init)), { preconnect: originalFetch.preconnect });
  try {
    await run(new CloudflareApi(config));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalToken;
  }
}

function reply(result: unknown, totalPages = 1): Response {
  return Response.json({ success: true, result, result_info: { total_pages: totalPages } });
}

test("accepts a single DNS hostname, not a URL or wildcard", () => {
  expect(normalizeHostname("Podcasts.Example.COM")).toBe("podcasts.example.com");
  for (const input of ["https://example.com", "*.example.com", "example.com:443", "example.com/other",
    "one..example.com", "-one.example.com", "localhost", "example.com "]) {
    expect(() => normalizeHostname(input)).toThrow("DNS hostname");
  }
});

test("attaches only after zone and DNS preflight, then reconciles and detaches its own hostname", async () => {
  let existing: Domain | null = null;
  const methods: string[] = [];
  await withCloudflare(async (request) => {
    const url = new URL(request.url);
    methods.push(`${request.method} ${url.pathname}`);
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
    if (url.pathname === "/client/v4/zones") return reply([zone]);
    if (url.pathname.endsWith("/dns_records")) return reply([]);
    if (url.pathname.endsWith("/workers/domains")) {
      if (request.method === "PUT") {
        const input = await request.json() as { hostname: string; service: string; zone_id: string };
        expect(input).toEqual({ hostname: "podcasts.example.com", service: worker, zone_id: zone.id });
        existing = { ...input, id: "domain-id", zone_name: zone.name };
        return reply(existing);
      }
      const match = url.searchParams.has("hostname") ? url.searchParams.get("hostname") === existing?.hostname
        : url.searchParams.get("service") === existing?.service;
      return reply(match && existing ? [existing] : []);
    }
    if (request.method === "DELETE" && url.pathname.endsWith("/workers/domains/domain-id")) {
      existing = null;
      return reply(null);
    }
    throw new Error(`Unexpected request ${request.method} ${url}`);
  }, async (api) => {
    expect((await api.ensureWorkerDomain("Podcasts.Example.COM", worker)).hostname).toBe("podcasts.example.com");
    expect((await api.ensureWorkerDomain("podcasts.example.com", worker)).id).toBe("domain-id");
    await api.removeWorkerDomain("podcasts.example.com", worker);
    await api.removeWorkerDomain("podcasts.example.com", worker);
  });
  expect(methods.filter((method) => method.startsWith("PUT"))).toHaveLength(1);
  expect(methods.filter((method) => method.startsWith("DELETE"))).toHaveLength(1);
});

test("refuses partial zones, occupied DNS names, and a domain owned by another Worker", async () => {
  const domain: Domain = { id: "other", hostname: "podcasts.example.com", service: "other-worker",
    zone_id: zone.id, zone_name: zone.name };
  for (const scenario of ["partial", "dns", "other-worker"]) {
    await withCloudflare((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/workers/domains")) {
        return reply(scenario === "other-worker" && url.searchParams.has("hostname") ? [domain] : []);
      }
      if (url.pathname === "/client/v4/zones") return reply([{ ...zone, type: scenario === "partial" ? "partial" : "full" }]);
      if (url.pathname.endsWith("/dns_records")) return reply([{ name: "podcasts.example.com", type: "CNAME" }]);
      throw new Error(`Unexpected write: ${request.method} ${url}`);
    }, async (api) => {
      await expect(api.ensureWorkerDomain("podcasts.example.com", worker)).rejects.toThrow(
        scenario === "partial" ? "authoritative DNS" : scenario === "dns" ? "DNS records" : "different Custom Domain");
      if (scenario === "other-worker") {
        await expect(api.removeWorkerDomain("podcasts.example.com", worker)).rejects.toThrow("not owned");
      }
    });
  }
});

test("M6 runtime inspection calls only authenticated Cloudflare GETs and returns no sensitive metadata", async () => {
  const metadata = buildM6WorkerUploadMetadata(config, null, "private-admin-key");
  const versionId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();
  const methods: string[] = [];
  await withCloudflare((request) => {
    const url = new URL(request.url);
    methods.push(`${request.method} ${url.pathname}`);
    expect(request.method).toBe("GET");
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
    expect(url.pathname.startsWith(`/client/v4/accounts/${accountId}/workers/scripts/${worker}/`)).toBe(true);
    if (url.pathname.endsWith("/deployments")) return reply({ deployments: [{ id: deploymentId, strategy: "percentage",
      versions: [{ version_id: versionId, percentage: 100 }], author_email: "private@example.com" }] });
    if (url.pathname.endsWith("/settings")) return reply(metadata);
    if (url.pathname.endsWith("/subdomain")) return reply({ enabled: true, previews_enabled: false });
    if (url.pathname.endsWith(`/versions/${versionId}`)) return reply({ id: versionId, resources: { bindings: metadata.bindings,
      script: { handlers: ["fetch", "queue"], named_handlers: [{ name: "CachedPublicAssets", handlers: ["fetch"] }] },
      script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags, exports: metadata.exports } } });
    throw new Error("Unexpected Cloudflare read");
  }, async (api) => {
    const evidence = await api.inspectM6WorkerDeployment(config, versionId);
    expect(evidence.worker_version_id).toBe(versionId);
    expect(evidence.deployment_id).toBe(deploymentId);
    expect(JSON.stringify(evidence)).not.toContain("private");
    expect(JSON.stringify(evidence)).not.toContain("test-token");
  });
  expect(methods).toHaveLength(7);
});

test("M6 inspection rejects cross-account and invalid-version requests before HTTP calls", async () => {
  await withCloudflare(() => { throw new Error("No HTTP request is allowed"); }, async (api) => {
    await expect(api.inspectM6WorkerDeployment({ ...config, account_id: "b".repeat(32) }, crypto.randomUUID())).rejects.toThrow("another Cloudflare account");
    await expect(api.inspectM6WorkerDeployment(config, "not-a-version")).rejects.toThrow();
  });
});

test("M6 inspection does not retry or substitute a successful proof when Cloudflare GET fails", async () => {
  let calls = 0;
  await withCloudflare(() => {
    calls += 1;
    return Response.json({ success: false, result: null, errors: [{ code: 1000, message: "Access denied" }] }, { status: 403 });
  }, async (api) => {
    await expect(api.inspectM6WorkerDeployment(config, crypto.randomUUID())).rejects.toThrow("HTTP 403");
  });
  expect(calls).toBe(1);
});

test("existing legacy deploy keeps its cache/bindings policy and does not silently opt into M6", async () => {
  const methods: string[] = [];
  await withCloudflare(async (request) => {
    const url = new URL(request.url);
    methods.push(request.method);
    if (request.method === "GET" && url.pathname.endsWith("/settings")) return reply({
      cache_options: { enabled: true, cross_version_cache: true },
      bindings: [{ name: "CASTLOOP_ADMIN_KEY", type: "secret_text" }, { name: "EXTRA_SECRET", type: "secret_text" }],
      observability: { enabled: true, traces: { enabled: true } },
    });
    if (request.method === "PUT") {
      const form = await request.formData();
      const metadata = workerSettingsSnapshotSchema.parse(JSON.parse(String(form.get("metadata"))));
      expect(metadata.cache_options).toEqual({ enabled: true, cross_version_cache: true });
      expect(metadata.exports).toBeUndefined();
      expect(metadata.bindings).toContainEqual({ name: "CASTLOOP_ADMIN_KEY", type: "inherit" });
      expect(metadata.bindings).toContainEqual({ name: "EXTRA_SECRET", type: "inherit" });
      expect(metadata.bindings.some((binding) => binding.name === "CASTLOOP_VERSION_METADATA")).toBe(false);
      expect(metadata.compatibility_date).toBe("2026-09-30");
      expect(JSON.stringify(metadata)).not.toContain("replacement-secret");
      expect(url.searchParams.get("bindings_inherit")).toBe("strict");
      return reply({});
    }
    if (request.method === "POST" && url.pathname.endsWith("/subdomain")) {
      expect(await request.json<{ enabled: boolean; previews_enabled: boolean }>()).toEqual({ enabled: true, previews_enabled: false });
      return reply({});
    }
    throw new Error("Unexpected legacy deployment request");
  }, async (api) => {
    await api.deployWorker(config, "export default {};", "replacement-secret", "2026-09-30");
  });
  expect(methods).toEqual(["GET", "PUT", "POST"]);
});

test("legacy deploy refuses M6 cache exports or version metadata before any Worker write", async () => {
  for (const marker of ["export", "binding"]) {
    let calls = 0;
    await withCloudflare((request) => {
      calls += 1;
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname.endsWith("/settings")).toBe(true);
      return reply(marker === "export" ? { bindings: [], exports: { CachedPublicAssets: { type: "worker", cache: { enabled: true } } } } :
        { bindings: [{ name: "CASTLOOP_VERSION_METADATA", type: "version_metadata" }] });
    }, async (api) => {
      await expect(api.deployWorker(config, "export default {};", "private-secret", "2026-09-30")).rejects.toThrow("Legacy deploy cannot replace");
    });
    expect(calls).toBe(1);
  }
});

test("fresh M6 REST provisioning creates isolated resources and verifies its frozen deployment without claiming runtime readiness", async () => {
  const fresh = { ...config, public_base_url: `https://${worker}.example.workers.dev` };
  const metadata = buildM6WorkerUploadMetadata(fresh, null, "private-admin-key", M6_FRESH_WORKER_COMPATIBILITY_DATE);
  const snapshot = structuredClone(metadata);
  const versionId = crypto.randomUUID();
  const deploymentId = crypto.randomUUID();
  const writes: string[] = [];
  let claimed = false;
  await withCloudflare(async (request) => {
    const path = new URL(request.url).pathname;
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
    if (request.method !== "GET") writes.push(`${request.method} ${path}`);
    if (request.method === "GET" && path.endsWith(`/r2/buckets/${fresh.bucket_name}`)) return new Response(null, { status: 404 });
    if (request.method === "GET" && path.endsWith("/settings") && !claimed) return new Response(null, { status: 404 });
    if (request.method === "POST" && path.endsWith("/r2/buckets")) {
      expect(await request.json<unknown>()).toEqual({ name: fresh.bucket_name });
      return reply({});
    }
    if (request.method === "POST" && path.endsWith("/queues")) return reply({});
    if (request.method === "PUT" && path.endsWith("/objects/system/service.toml")) {
      expect(request.headers.get("Content-Type")).toBe("application/toml");
      const text = await request.text();
      expect(text).toContain(`service_id = "${fresh.service_id}"`);
      expect(text).not.toContain("private-admin-key");
      return reply({});
    }
    if (request.method === "POST" && path.endsWith("/workers/workers")) {
      expect(await request.json<unknown>()).toEqual({ name: worker });
      claimed = true;
      metadata.compatibility_date = "2026-09-23";
      return reply({ id: crypto.randomUUID() });
    }
    if (request.method === "PUT" && path.endsWith(`/workers/scripts/${worker}`)) {
      const form = await request.formData();
      expect(JSON.parse(String(form.get("metadata")))).toEqual(snapshot);
      expect(await (form.get("index.js") as Blob).text()).toBe("export default {};");
      return reply({ etag: "fresh-script-content" });
    }
    if (path.endsWith("/deployments")) return reply({ deployments: [{ id: deploymentId, strategy: "percentage", versions: [{ version_id: versionId, percentage: 100 }] }] });
    if (path.endsWith("/settings")) return reply(snapshot);
    if (path.endsWith(`/versions/${versionId}`)) return reply({ id: versionId, resources: { bindings: snapshot.bindings,
      script: { etag: "fresh-script-content", handlers: ["fetch", "queue"], named_handlers: [{ name: "CachedPublicAssets", handlers: ["fetch"] }] },
      script_runtime: { compatibility_date: snapshot.compatibility_date, compatibility_flags: snapshot.compatibility_flags, exports: snapshot.exports } } });
    if (path.endsWith("/subdomain")) return reply({ enabled: true, previews_enabled: false });
    if (path.endsWith("/queues")) return reply([{ queue_id: "main", queue_name: fresh.queue_name }, { queue_id: "dlq", queue_name: fresh.dlq_name }]);
    if (path.endsWith("/consumers")) {
      if (request.method === "GET") return reply([]);
      const body = await request.json<{ settings: object; script_name: string }>();
      expect(body.script_name).toBe(worker);
      expect(body.settings).toMatchObject({ batch_size: 1, max_concurrency: 1 });
      return reply({});
    }
    if (path.includes("/event_notifications/")) return reply({});
    throw new Error(`Unexpected fresh initialization request: ${request.method} ${path}`);
  }, async (api) => {
    const effects = createFreshM6RestEffects(api, "private-admin-key", async () => { throw new Error("Runtime verification is separate"); });
    await effects.createResources(fresh);
    expect(await effects.deploy(fresh, "export default {};", metadata)).toEqual({ deployment_id: deploymentId, worker_version_id: versionId });
  });
  expect(writes.filter((value) => value.includes(`/workers/scripts/${worker}`) && value.startsWith("PUT"))).toHaveLength(1);
  expect(writes.some((value) => value.startsWith("DELETE"))).toBe(false);
});

test("fresh M6 refuses existing or unknown resources and name collisions without adoption or replay", async () => {
  const fresh = { ...config, public_base_url: `https://${worker}.example.workers.dev` };
  for (const scenario of ["bucket", "unknown", "worker", "collision", "metadata"]) {
    const writes: string[] = [];
    await withCloudflare((request) => {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") writes.push(request.method);
      if (path.endsWith(`/r2/buckets/${fresh.bucket_name}`)) return new Response(null, { status: scenario === "bucket" ? 200 : scenario === "unknown" ? 403 : 404 });
      if (path.endsWith("/settings")) return reply({ bindings: [] });
      if (request.method === "POST" && path.endsWith("/workers/workers")) return Response.json({ success: false, result: null }, { status: 409 });
      throw new Error("No further request is allowed");
    }, async (api) => {
      if (["bucket", "unknown", "worker"].includes(scenario)) await expect(api.createFreshM6Resources(fresh)).rejects.toThrow();
      else await expect(api.uploadFreshM6Worker(fresh, "export default {};", "key",
        scenario === "metadata" ? {} : buildM6WorkerUploadMetadata(fresh, null, "key", M6_FRESH_WORKER_COMPATIBILITY_DATE))).rejects.toThrow();
      await expect(api.createFreshM6Resources({ ...fresh, account_id: "b".repeat(32) })).rejects.toThrow("this account");
    });
    expect(writes).toEqual(scenario === "collision" ? ["POST"] : []);
  }
});

test("compatible REST updates preserve secrets/settings, reject unfrozen inputs and only replace the admitted Worker", async () => {
  const service = { ...config, public_base_url: `https://${worker}.example.workers.dev` };
  const previousVersion = crypto.randomUUID();
  const nextVersion = crypto.randomUUID();
  const previousDeployment = crypto.randomUUID();
  const nextDeployment = crypto.randomUUID();
  const oldMetadata = buildM6WorkerUploadMetadata(service, null, "private-key");
  oldMetadata.bindings.push({ name: "EXTRA_SECRET", type: "secret_text" });
  oldMetadata.tags = ["preserved-tag"];
  const writes: string[] = [];
  let uploaded = false;
  let changed = false;
  let nextMetadata: typeof oldMetadata | undefined;
  await withCloudflare(async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET") writes.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith(`/workers/scripts/${worker}`) && request.method === "PUT") {
      const form = await request.formData();
      expect(JSON.parse(String(form.get("metadata")))).toEqual(nextMetadata);
      expect(String(form.get("metadata"))).not.toContain("private-key");
      uploaded = true;
      return reply({ etag: "compatible-script-content" });
    }
    const runtime = uploaded ? { ...nextMetadata!, bindings: nextMetadata!.bindings.map((binding) => binding.type === "inherit" ?
      oldMetadata.bindings.find((old) => old.name === binding.name)! : binding) } : oldMetadata;
    const version = uploaded ? nextVersion : previousVersion;
    if (url.pathname.endsWith("/settings")) return reply(changed ? { ...runtime, tags: ["changed-tag"] } : runtime);
    if (url.pathname.endsWith("/deployments")) return reply({ deployments: [{ id: uploaded ? nextDeployment : previousDeployment,
      strategy: "percentage", versions: [{ version_id: version, percentage: 100 }] }] });
    if (url.pathname.endsWith(`/versions/${version}`)) return reply({ id: version, resources: { bindings: runtime.bindings,
      script: { etag: "compatible-script-content", handlers: ["fetch", "queue"], named_handlers: [{ name: "CachedPublicAssets", handlers: ["fetch"] }] },
      script_runtime: { compatibility_date: runtime.compatibility_date, compatibility_flags: runtime.compatibility_flags, exports: runtime.exports } } });
    if (url.pathname.endsWith("/subdomain")) return reply({ enabled: true, previews_enabled: false });
    if (url.pathname.endsWith("/workers/domains")) return reply([]);
    throw new Error("Compatible updates cannot create resources or write content");
  }, async (api) => {
    nextMetadata = await api.prepareCompatibleM6WorkerUpload(service, previousVersion);
    expect(writes).toEqual([]);
    expect(nextMetadata.compatibility_date).toBe(oldMetadata.compatibility_date);
    expect(nextMetadata.tags).toEqual(oldMetadata.tags);
    expect(nextMetadata.bindings).toContainEqual({ name: "CASTLOOP_ADMIN_KEY", type: "inherit", version_id: previousVersion });
    expect(nextMetadata.bindings).toContainEqual({ name: "EXTRA_SECRET", type: "inherit", version_id: previousVersion });
    const request = m6ServiceUpdateRequestSchema.parse({ operation_id: crypto.randomUUID(), service_id: service.service_id,
      pause_id: crypto.randomUUID(), expected_service_generation: 1, previous_worker_version_id: previousVersion,
      service_config_sha256: await m6ServiceConfigHash(service), worker_source_sha256: migrationPayloadHash("new-worker"),
      worker_metadata_sha256: migrationPayloadHash(nextMetadata) });
    await expect(api.uploadCompatibleM6Worker(service, request, "changed-worker", nextMetadata)).rejects.toThrow("frozen");
    changed = true;
    await expect(api.uploadCompatibleM6Worker(service, request, "new-worker", nextMetadata)).rejects.toThrow("metadata was frozen");
    changed = false;
    const readiness = { operation_id: crypto.randomUUID(), deployment_id: previousDeployment, worker_version_id: previousVersion,
      service_config_sha256: request.service_config_sha256, default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets",
      cutover_verified: true, publication_routes_verified: true };
    const paused = serviceAdmissionSchema.parse({ schema_version: 1, service_id: service.service_id, mode: "m6", state: "paused",
      generation: 1, pause_id: request.pause_id, invocations: [], runtime_readiness: readiness });
    let admission = paused;
    const effects = createM6UpdateRestEffects(api, { begin: async () => {}, complete: async () => { throw new Error("Separate runtime verification"); },
      admission: async () => admission });
    await expect(effects.deploy(service, request, "new-worker", nextMetadata)).rejects.toThrow("admitted");
    expect(writes).toEqual([]);
    admission = serviceAdmissionSchema.parse({ ...paused, state: "updating", generation: 2, update: { request } });
    expect(await effects.deploy(service, request, "new-worker", nextMetadata)).toEqual({ deployment_id: nextDeployment, worker_version_id: nextVersion });
  });
  expect(writes).toEqual([`PUT /client/v4/accounts/${accountId}/workers/scripts/${worker}`,
    `POST /client/v4/accounts/${accountId}/workers/scripts/${worker}/subdomain`]);
});

test("M6 uploads reject missing receipts or another script's content without replaying PUT or activating the deployment", async () => {
  const fresh = { ...config, public_base_url: `https://${worker}.example.workers.dev` };
  const metadata = buildM6WorkerUploadMetadata(fresh, null, "key", M6_FRESH_WORKER_COMPATIBILITY_DATE);
  for (const missing of [false, true]) {
    const versionId = crypto.randomUUID();
    const writes: string[] = [];
    await withCloudflare((request) => {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") writes.push(request.method);
      if (path.endsWith("/workers/workers")) return reply({});
      if (request.method === "PUT") return reply(missing ? {} : { etag: "uploaded-script" });
      if (path.endsWith("/deployments")) return reply({ deployments: [{ id: crypto.randomUUID(), strategy: "percentage",
        versions: [{ version_id: versionId, percentage: 100 }] }] });
      if (path.endsWith(`/versions/${versionId}`)) return reply({ id: versionId, resources: { bindings: metadata.bindings,
        script: { etag: "another-script", handlers: ["fetch", "queue"], named_handlers: [] },
        script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags, exports: metadata.exports } } });
      throw new Error("No deployment setup or readiness write may follow a missing or mismatched upload receipt");
    }, async (api) => { await expect(api.uploadFreshM6Worker(fresh, "worker-source", "key", metadata)).rejects.toThrow(); });
    expect(writes).toEqual(["POST", "PUT"]);
  }
});
