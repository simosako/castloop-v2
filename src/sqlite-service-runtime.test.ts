import { afterEach, expect, test } from "bun:test";
import { stringifyToml } from "../packages/shared/src/index";
import { sqliteServiceConfigHash } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { SqliteServiceRuntime } from "./sqlite-service-runtime";
import { createSqliteServiceHttp } from "./sqlite-service-http";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { sqlitePublicationBucket } from "./test-support/sqlite-publication-bucket";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() {
  const config: SqliteServiceConfig = { schema_version: 2, publication_protocol: "sqlite-sequential-v1", service_id: "service", account_id: "a".repeat(32),
    bucket_name: "test-bucket", worker_name: "test-worker", public_base_url: "https://test-worker.example.workers.dev", workers_dev_base_url: "https://test-worker.example.workers.dev" };
  const value = sqlitePublicationFixture({ resume: false, runtime: { service_id: config.service_id, worker_version_id: crypto.randomUUID(), service_config_sha256: await sqliteServiceConfigHash(config) } });
  cleanups.push(value.close);
  const objects = sqlitePublicationBucket(); await objects.bucket.put("system/service.toml", stringifyToml(config));
  const content = new SqlitePublicationContent(value.storage), purges: string[] = [];
  const cached = { worker_version_id: value.runtime.worker_version_id, service_config_sha256: value.runtime.service_config_sha256, cache_enabled: true };
  const hooks: { purge?: () => Promise<void> } = {};
  const create = () => new SqliteServiceRuntime(value.storage, value.queue, content, objects.bucket, config,
    { describe: async () => cached, purge: async (showId) => { purges.push(showId); await hooks.purge?.(); } });
  const runtime = create(), http = createSqliteServiceHttp(runtime, "private-key");
  const request = { ...value.runtime, operation_id: crypto.randomUUID() };
  const call = (route: string, body?: object) => http(new Request(`https://test-worker.example.workers.dev/admin/sqlite-service/${route}`, {
    method: body ? "POST" : "GET", headers: { "X-Castloop-Key": "private-key", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { ...value, ...objects, config, content, cached, purges, hooks, runtime, request, create, call };
}

test("readiness requires the actual Alarm, R2 config and exact cached runtime, and finishes paused", async () => {
  const value = await fixture();
  expect(value.runtime.health()).toMatchObject({ publication_ready: false, state: "paused", drained: true, setup: null });
  expect((await value.runtime.prepare(value.request)).setup?.state).toBe("scheduled");
  expect(value.runtime.ready()).toBe(false);
  expect(await value.runtime.alarm()).toBe(true);
  expect(value.runtime.health()).toMatchObject({ publication_ready: true, state: "paused", drained: true, setup: { state: "ready" } });
  expect(value.purges).toHaveLength(1);
  expect(await value.runtime.alarm()).toBe(false);
  expect(value.create().ready()).toBe(true);
  expect(value.runtime.health().invocation_id).not.toBe(value.runtime.health().invocation_id);
});

test("runtime setup and Alarm reservation roll back together", async () => {
  const value = await fixture(); value.failAlarm();
  await expect(value.runtime.prepare(value.request)).rejects.toThrow("scheduling failure");
  expect(value.runtime.health().setup).toBeNull(); expect(value.alarm()).toBeNull();
});

test("duplicate setup does not reschedule or replace running or blocked work", async () => {
  const value = await fixture(); await value.runtime.prepare(value.request); value.clearAlarm();
  await value.runtime.prepare(value.request); expect(value.alarm()).toBeNull();
  await expect(value.runtime.prepare({ ...value.request, operation_id: crypto.randomUUID() })).rejects.toThrow("retained");
  value.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'running'");
  expect(await value.create().alarm()).toBe(true);
  expect(value.runtime.health().setup?.state).toBe("blocked");
  value.calls.length = 0; await value.runtime.alarm(); expect(value.calls).toEqual([]);
});

for (const fault of ["version", "config", "cache", "bucket", "purge"] as const) {
  test(`runtime ${fault} failure stays blocked and cannot resume or register`, async () => {
    const value = await fixture(); await value.runtime.prepare(value.request);
    if (fault === "version") value.cached.worker_version_id = crypto.randomUUID();
    if (fault === "config") value.cached.service_config_sha256 = "f".repeat(64);
    if (fault === "cache") value.cached.cache_enabled = false;
    if (fault === "bucket") await value.bucket.put("system/service.toml", stringifyToml({ ...value.config, bucket_name: "other-bucket" }));
    if (fault === "purge") value.hooks.purge = async () => { throw new Error("private-key private text"); };
    await value.runtime.alarm();
    expect(value.runtime.health()).toMatchObject({ publication_ready: false, state: "paused", setup: { state: "blocked" } });
    expect((await value.call("resume", { ...value.request, admission_window_id: crypto.randomUUID() })).status).toBe(503);
  });
}

test("pending purge is not ready, remains responsive, and cannot be mistaken for an interrupted execution", async () => {
  const value = await fixture(); await value.runtime.prepare(value.request);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
  value.hooks.purge = async () => { enter(); await released; };
  const work = value.runtime.alarm(); await entered;
  try { expect(value.runtime.health().setup?.state).toBe("running"); expect(value.runtime.ready()).toBe(false);
    await value.runtime.alarm(); expect(value.runtime.health().setup?.state).toBe("running");
  } finally { release(); await work; }
  expect(value.runtime.ready()).toBe(true);
});

test("authenticated service commands bind exact runtime and explicit resume window", async () => {
  const value = await fixture();
  expect((await value.call("prepare", value.request)).status).toBe(202); await value.runtime.alarm();
  expect((await value.call("resume", { ...value.request, worker_version_id: crypto.randomUUID(), admission_window_id: crypto.randomUUID() })).status).toBe(409);
  const window = crypto.randomUUID();
  expect((await value.call("resume", { ...value.request, admission_window_id: window })).status).toBe(200);
  const registration = { ...value.request, admission_window_id: window, show_id: "daily", reservation_id: crypto.randomUUID() };
  expect((await value.call("register-show", registration)).status).toBe(200);
  expect(await value.runtime.inspect("daily")).toMatchObject({ show_lifecycle: "draft", expected_show_state_version: 0, reservation_id: registration.reservation_id });
  expect((await value.call("register-show", { ...registration, reservation_id: crypto.randomUUID() })).status).toBe(409);
  expect((await value.call("pause", value.request)).status).toBe(200);
  expect(value.runtime.health()).toMatchObject({ state: "paused", drained: true });
});

test("the native Worker is a separate bundle with real DO and cached entrypoint exports", async () => {
  const output = await Bun.build({ entrypoints: ["src/sqlite-worker.ts"], target: "browser", external: ["cloudflare:workers"] });
  expect(output.success).toBe(true); expect(output.outputs).toHaveLength(1);
  const source = await output.outputs[0].text();
  expect(source).toContain("SqlitePublicationService"); expect(source).toContain("SqliteCachedAssets");
  expect(source).not.toContain("queueM6Candidate");
  const legacy = await Bun.build({ entrypoints: ["src/worker.ts"], target: "browser", external: ["cloudflare:workers"] });
  expect(legacy.success).toBe(true);
  expect(await legacy.outputs[0].text()).not.toContain("SqlitePublicationService");
});
