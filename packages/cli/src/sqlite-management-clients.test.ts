import { expect, test } from "bun:test";
import { sqliteServiceConfigHash } from "@castloop/shared";
import type { SqliteServiceConfig } from "@castloop/shared";
import { directShow, directCover } from "../../../src/test-support/direct-publication";
import { sqliteDirectPublishRequestSchema } from "../../shared/src/sqlite-direct-publication";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { SqliteServiceClient } from "./sqlite-service-client";

const config: SqliteServiceConfig = { schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: "trial", account_id: "a".repeat(32),
  bucket_name: "private-bucket", worker_name: "test-worker", public_base_url: "https://test-worker.example.workers.dev", workers_dev_base_url: "https://test-worker.example.workers.dev" };
const version = "11111111-1111-4111-8111-111111111111", invocation = "22222222-2222-4222-8222-222222222222";
const runtime = { service_id: config.service_id, service_config_sha256: await sqliteServiceConfigHash(config), worker_version_id: version };
const request = sqliteDirectPublishRequestSchema.parse({ service_id: runtime.service_id, service_config_sha256: runtime.service_config_sha256,
  schema_version: 1, protocol: "sqlite-sequential-v1", show_id: "daily",
  expected_show_state_version: 0, action: "publish", kind: "show", metadata: directShow, cover: directCover });
const status = { ...runtime, protocol: "sqlite-sequential-v1", show_id: "daily", result: "changed", revision_id: crypto.randomUUID() } as const;
const health = { ...runtime, protocol: "sqlite-sequential-v1", domain_changes: "sqlite-domain-change-v1", invocation_id: invocation, publication_ready: true,
  revision_history: "sqlite-revisions-v1", website: "static-show-v2", delivery_statistics: "episode-daily-v1" } as const;
const json = (value: unknown, code = 200) => Response.json(value, { status: code, headers: { "Cache-Control": "no-store" } });
const quiet = { delay: async () => {}, onDiagnostic: () => {} };
const publicationStatus = { ...runtime, protocol: "sqlite-sequential-v1", publication_ready: true } as const;

for (const [fault, response] of [
  ["malformed JSON", () => new Response("private-admin invalid JSON", { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } })],
  ["oversized body", () => new Response("x".repeat(16385), { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } })],
  ["cacheable response", () => Response.json({ secret: "private-admin" })],
  ["partial response", () => new Response("{}", { status: 206, headers: { "Content-Range": "bytes 0-1/2" } })],
] as const) {
  test(`publication capability rejects ${fault} without echoing secrets or retrying`, async () => {
    const calls: Request[] = [];
    const client = new SqlitePublicationClient(config, "private-admin", async (input, init) => {
      calls.push(new Request(input, init)); return response();
    }, 30000, quiet);
    let error: unknown;
    try { await client.describe(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private-admin");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(`${config.workers_dev_base_url}/admin/sqlite-publication/status`);
    expect(calls[0]!.headers.get("X-Castloop-Key")).toBe("private-admin");
  });
}

test("publication status GET retries without a publication job or status identity", async () => {
  const calls: Request[] = [];
  const client = new SqlitePublicationClient(config, "private-admin", async (input, init) => {
    const call = new Request(input, init); calls.push(call);
    if (calls.length === 1) throw new Error("connection lost");
    return json(publicationStatus);
  }, 30000, quiet);
  expect(await client.describe()).toEqual(publicationStatus); expect(calls.length).toBe(2);
  expect(calls.every((call) => call.method === "GET" && call.url.endsWith("/status") && !call.headers.has("X-Castloop-Status-Request"))).toBe(true);
});

test("publication submit POST is never retried for unknown transport, HTTP or body failures", async () => {
  for (const fault of ["transport", "http", "body"] as const) {
    let calls = 0;
    const client = new SqlitePublicationClient(config, "private-admin", async (_input, init) => {
      calls++; expect(init?.method).toBe("POST"); expect(new Headers(init?.headers).has("X-Castloop-Status-Request")).toBe(false);
      if (fault === "transport") throw new Error("private transport failure");
      if (fault === "http") return json({ error: "private" }, 503);
      return new Response("not JSON", { status: 202, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } });
    }, 30000, quiet);
    await expect(client.submit(request)).rejects.toThrow(); expect(calls).toBe(1);
  }
});

test("service health GET retries, but mutating POSTs are never retried", async () => {
  let reads = 0;
  const client = new SqliteServiceClient(config, "private-admin", async (_input, init) => {
    expect(init?.method).toBe("GET"); if (++reads === 1) throw new Error("connection lost"); return json(health);
  }, quiet);
  expect(await client.health()).toEqual(health); expect(reads).toBe(2);
  for (const fault of ["transport", "http"] as const) {
    let writes = 0;
    const failed = new SqliteServiceClient(config, "private-admin", async (_input, init) => {
      writes++; expect(init?.method).toBe("POST"); if (fault === "transport") throw new Error("unknown response"); return json({ error: "unavailable" }, 503);
    }, quiet);
    await expect(failed.catalog({ kind: "show", include_deleted: false })).rejects.toThrow("without automatic replay"); expect(writes).toBe(1);
  }
});

test("valid JSON with the wrong publication target, runtime or schema is not retried", async () => {
  for (const bad of [{ ...status, service_id: "other" }, { ...status, show_id: "other" }, { ...status, service_config_sha256: "f".repeat(64) }, { state: "succeeded" }]) {
    let reads = 0;
    const client = new SqlitePublicationClient(config, "private-admin", async () => { reads++; return json(bad); }, 30000, quiet);
    await expect(client.submit(request)).rejects.toThrow();
    expect(reads).toBe(1);
  }
  let reads = 0;
  const client = new SqliteServiceClient(config, "private-admin", async () => { reads++; return json({ ...health, service_config_sha256: "f".repeat(64) }); }, quiet);
  await expect(client.health()).rejects.toThrow(); expect(reads).toBe(1);
  for (const website of [undefined, "static-show-v1", "unknown-version"]) {
    let calls = 0;
    const incompatible = new SqliteServiceClient(config, "private-admin", async (_input, init) => {
      calls++; expect(init?.method).toBe("GET"); return json({ ...health, website });
    }, quiet);
    await expect(incompatible.health()).rejects.toThrow(); expect(calls).toBe(1);
  }
});
