import { afterEach, expect, test } from "bun:test";
import { sqliteServiceConfigHash } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { SqliteServiceRuntime } from "./sqlite-service-runtime";
import { createSqliteServiceHttp } from "./sqlite-service-http";
import { createSqlitePublicationHttp } from "./sqlite-publication-http";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() {
  const config: SqliteServiceConfig = { schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: "service", account_id: "a".repeat(32),
    bucket_name: "test-bucket", worker_name: "test-worker", public_base_url: "https://test-worker.example.workers.dev", workers_dev_base_url: "https://test-worker.example.workers.dev" };
  const value = sqlitePublicationFixture({ runtime: { service_id: config.service_id, worker_version_id: crypto.randomUUID(), service_config_sha256: await sqliteServiceConfigHash(config) } });
  cleanups.push(value.close);
  const content = new SqlitePublicationContent(value.storage), purges: string[] = [];
  const create = () => new SqliteServiceRuntime(value.storage, value.queue, content, config,
    { purge: async (showId) => { purges.push(showId); } });
  const runtime = create(), http = createSqliteServiceHttp(runtime, "private-key");
  const call = (route: string, body?: object) => http(new Request(`https://test-worker.example.workers.dev/admin/sqlite-service/${route}`, {
    method: body ? "POST" : "GET", headers: { "X-Castloop-Key": "private-key", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { ...value, config, content, purges, runtime, request: { ...value.identity, operation_id: crypto.randomUUID() }, create, call };
}

test("a fresh runtime is immediately ready and reports no maintenance vocabulary", async () => {
  const value = await fixture();
  expect(value.runtime.ready()).toBe(true);
  expect(value.runtime.health()).toMatchObject({ publication_ready: true, service_id: "service" });
  expect(value.runtime.health()).not.toHaveProperty("state");
  expect(value.runtime.health()).not.toHaveProperty("setup");
  expect(value.runtime.health().invocation_id).not.toBe(value.runtime.health().invocation_id);
});

test("a pending domain change gates readiness until it is committed", async () => {
  const value = await fixture();
  value.storage.sql.exec(`INSERT INTO publication_domain_changes (operation_id, request_json, request_sha256, state)
    VALUES ('${crypto.randomUUID()}', '{}', '${"a".repeat(64)}', 'prepared')`);
  expect(value.create().ready()).toBe(false);
  expect(value.create().health()).toMatchObject({ publication_ready: false });
});

test("worker version drift alone never disables the runtime", async () => {
  const value = await fixture();
  const next = { ...value.queue.identity(), worker_version_id: crypto.randomUUID() };
  const restarted = new SqlitePublicationQueue(value.storage, next);
  expect(restarted.identity()).toEqual(next);
  expect(value.create().ready()).toBe(true);
});

test("runtime requireTarget accepts the exact identity and rejects foreign configurations", async () => {
  const value = await fixture();
  expect(value.runtime.requireTarget(value.request)).toEqual(value.request);
  expect(() => value.runtime.requireTarget({ ...value.request, service_config_sha256: "f".repeat(64) })).toThrow();
  expect(() => value.runtime.requireTarget({ ...value.request, service_id: "other" })).toThrow();
});

test("both SQLite HTTP handlers await authentication before runtime access or body parsing", async () => {
  const value = await fixture();
  const forbidden = { get() { throw new Error("Authentication must precede runtime access"); } };
  const service = createSqliteServiceHttp(new Proxy(value.runtime, forbidden), "private-key");
  const publication = createSqlitePublicationHttp(new Proxy(value.queue, forbidden), "private-key", () => {
    throw new Error("Authentication must precede readiness inspection");
  });
  for (const [path, http] of [["sqlite-service/catalog", service], ["sqlite-publication/publish", publication]] as const) {
    for (const key of [undefined, "wrong-key"]) {
      const input = new Request(`https://service.example/admin/${path}`, { method: "POST", body: "{",
        headers: { "Content-Type": "application/json", ...(key ? { "X-Castloop-Key": key } : {}) } });
      const response = await http(input);
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(input.bodyUsed).toBe(false);
    }
  }
  expect(value.runtime.ready()).toBe(true);
});

test("the native Worker bundle contains real DO and cache exports without Queue handlers", async () => {
  const output = await Bun.build({ entrypoints: ["src/sqlite-worker.ts"], target: "browser", external: ["cloudflare:workers"] });
  expect(output.success).toBe(true); expect(output.outputs).toHaveLength(1);
  const source = await output.outputs[0].text();
  expect(source).toContain("SqlitePublicationService"); expect(source).toContain("SqliteCachedAssets");
  expect(source).not.toContain("queueM6Candidate");
  expect(source).not.toContain("queue-management-v1");
  expect(source).not.toContain("queue-commit-v1");
});
