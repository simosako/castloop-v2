import { expect, test } from "bun:test";
import { sqlitePublicationRequestHash, sqliteServiceConfigHash } from "@castloop/shared";
import type { SqliteServiceConfig } from "@castloop/shared";
import { sqlitePublicationRequest } from "../../../src/test-support/sqlite-publication";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { SqliteServiceClient } from "./sqlite-service-client";
import { classifySqliteInvocation, sanitizeSqliteInvocation, SqliteObservationGuard } from "../../../scripts/test-support/sqlite-observability";

const config: SqliteServiceConfig = { schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: "trial", account_id: "a".repeat(32),
  bucket_name: "private-bucket", worker_name: "test-worker", public_base_url: "https://test-worker.example.workers.dev", workers_dev_base_url: "https://test-worker.example.workers.dev" };
const version = "11111111-1111-4111-8111-111111111111", window = "22222222-2222-4222-8222-222222222222";
const runtime = { service_id: config.service_id, service_config_sha256: await sqliteServiceConfigHash(config), worker_version_id: version };
const request = sqlitePublicationRequest(runtime, window), requestHash = await sqlitePublicationRequestHash(request);
const status = { protocol: "sqlite-sequential-v1", service_id: config.service_id, request_id: request.request_id, job_id: request.job_id, request_sha256: requestHash, sequence: 1, state: "succeeded" } as const;
const health = { ...runtime, protocol: "sqlite-sequential-v1", invocation_id: window, publication_ready: true, state: "open", admission_window_id: window,
  queued: 0, active: null, drained: true, setup: { operation_id: window, state: "ready" }, runtime_update: null } as const;
const json = (value: unknown, code = 200) => Response.json(value, { status: code, headers: { "Cache-Control": "no-store" } });
const quiet = { delay: async () => {}, onDiagnostic: () => {} };

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

test("publication status GET retries and binds redacted cancellation to the unchanged frozen request", async () => {
  const calls: Request[] = [], guard = new SqliteObservationGuard();
  const client = new SqlitePublicationClient(config, "private-admin", async (input, init) => {
    const call = new Request(input, init); calls.push(call);
    if (calls.length === 1) {
      const row = sanitizeSqliteInvocation(JSON.stringify({ outcome: "canceled", scriptVersion: { id: version }, event: {
        request: { url: `${config.public_base_url}/admin/sqlite-publication/jobs/[REDACTED]`, method: call.method,
          headers: { "X-Castloop-Status-Request": call.headers.get("X-Castloop-Status-Request") } }, response: { status: 200 } } }));
      expect(classifySqliteInvocation(row)).toBe("reconcile"); guard.record(row); throw new Error("connection lost");
    }
    return json(status);
  }, 30000, quiet);
  expect(await client.observe(request)).toEqual(status); expect(calls.length).toBe(2);
  expect(calls.every((call) => call.method === "GET" && call.url.endsWith(`/jobs/${request.request_id}`) && call.headers.get("X-Castloop-Status-Request") === request.request_id)).toBe(true);
  guard.assertHealthy(); expect(() => guard.assertCanMutate()).toThrow("reconciliation");
  guard.reconcile(guard.pendingReconciliation(), { ...runtime, admission_window_id: window }, health, [{ expected: { job_id: request.job_id, request_id: request.request_id, request_sha256: requestHash }, observed: status }]);
  guard.assertCanMutate();
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

test("service health GET retries, but pause/resume POST is never retried", async () => {
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
    await expect(failed.control("resume", { ...runtime, operation_id: crypto.randomUUID() }, window)).rejects.toThrow("without automatic replay"); expect(writes).toBe(1);
  }
});

test("publication waiting counts retry requests against the shared 300-request limit", async () => {
  let calls = 0, remaining = 300;
  const client = new SqlitePublicationClient(config, "private-admin", async () => {
    if (++calls % 2) throw new Error("transient disconnect");
    return json({ ...status, state: "queued" });
  }, 30000, quiet);
  const budget = { beforeAttempt: () => { if (!remaining) return false; remaining--; return true; } };
  for (let poll = 0; poll < 150; poll++) expect((await client.observe(request, budget))?.state).toBe("queued");
  expect(calls).toBe(300); expect(remaining).toBe(0);
  await expect(client.observe(request, budget)).rejects.toThrow("deadline_exceeded"); expect(calls).toBe(300);
});

test("valid JSON with the wrong service, request, hash or schema is not a transient transport failure", async () => {
  for (const bad of [{ ...status, service_id: "other" }, { ...status, request_id: crypto.randomUUID() }, { ...status, request_sha256: "f".repeat(64) }, { state: "succeeded" }]) {
    let reads = 0;
    const client = new SqlitePublicationClient(config, "private-admin", async () => { reads++; return json(bad); }, 30000, quiet);
    await expect(client.observe(request)).rejects.toThrow();
    expect(reads).toBe(1);
  }
  let reads = 0;
  const client = new SqliteServiceClient(config, "private-admin", async () => { reads++; return json({ ...health, service_config_sha256: "f".repeat(64) }); }, quiet);
  await expect(client.health()).rejects.toThrow(); expect(reads).toBe(1);
});
