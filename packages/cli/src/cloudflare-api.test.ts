import { expect, test } from "bun:test";
import { serviceConfigSchema } from "@castloop/shared";
import { CloudflareApi, normalizeHostname } from "./cloudflare-api";

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
