import { afterEach, expect, test } from "bun:test";
import { stringifyToml } from "../packages/shared/src/index";
import { sqliteServiceConfigHash } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import { SqliteServiceRuntime } from "./sqlite-service-runtime";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { selectSqliteRuntime } from "./sqlite-runtime-update";
import { createSqliteServiceHttp } from "./sqlite-service-http";
import { sqlitePublicationFixture, sqlitePublicationRequest } from "./test-support/sqlite-publication";
import { sqlitePublicationBucket } from "./test-support/sqlite-publication-bucket";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() {
  const config: SqliteServiceConfig = { schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: "service", account_id: "a".repeat(32),
    bucket_name: "private-bucket", worker_name: "test-worker", public_base_url: "https://test-worker.example.workers.dev", workers_dev_base_url: "https://test-worker.example.workers.dev" };
  const setup = sqlitePublicationFixture({ resume: false, runtime: { service_id: config.service_id, worker_version_id: crypto.randomUUID(), service_config_sha256: await sqliteServiceConfigHash(config) } });
  cleanups.push(setup.close);
  const objects = sqlitePublicationBucket(); await objects.bucket.put("system/service.toml", stringifyToml(config));
  let cached = { ...setup.runtime, cache_enabled: true };
  const make = (actual: SqlitePublicationRuntime) => {
    const queue = new SqlitePublicationQueue(setup.storage, selectSqliteRuntime(setup.storage, actual));
    return new SqliteServiceRuntime(setup.storage, queue, new SqlitePublicationContent(setup.storage), objects.bucket, config,
      { describe: async () => cached, purge: async () => {} }, actual);
  };
  const old = make(setup.runtime), initial = crypto.randomUUID();
  await old.prepare({ ...setup.runtime, operation_id: initial }); setup.clearAlarm(); await old.alarm();
  const request = { ...setup.runtime, operation_id: crypto.randomUUID(), worker_source_sha256: "c".repeat(64), worker_metadata_sha256: "d".repeat(64), namespace_id: "b".repeat(32) };
  const activation = { ...request, new_worker_version_id: crypto.randomUUID(), deployment_id: crypto.randomUUID(), script_etag: "verified-script-etag" };
  const actual = { ...setup.runtime, worker_version_id: activation.new_worker_version_id };
  return { ...setup, ...objects, old, make, request, activation, actual,
    cacheVersion: (id: string) => { cached = { ...cached, worker_version_id: id }; } };
}

test("SQLite code updates require explicit drained maintenance and finish paused only after a new native probe", async () => {
  const value = await fixture();
  expect(value.old.ready()).toBe(true);
  expect(value.old.updates.prepare(value.request).update.state).toBe("prepared");
  expect(value.old.ready()).toBe(false);
  const http = createSqliteServiceHttp(value.old, "private-key");
  expect((await http(new Request("https://worker/admin/sqlite-service/resume", { method: "POST", headers: { "X-Castloop-Key": "private-key", "Content-Type": "application/json" },
    body: JSON.stringify({ ...value.runtime, operation_id: crypto.randomUUID(), admission_window_id: crypto.randomUUID() }) }))).status).toBe(503);
  expect(value.old.updates.prepare(value.request).update.state).toBe("prepared");
  expect(value.alarm()).toBe(null);
  const current = value.make(value.actual); expect(current.ready()).toBe(false);
  expect((await current.updates.activate(value.activation)).update.state).toBe("activated");
  expect(current.ready()).toBe(false); expect(value.alarm()).not.toBe(null);
  value.cacheVersion(value.actual.worker_version_id); value.clearAlarm(); await current.alarm();
  expect(current.health()).toMatchObject({ worker_version_id: value.actual.worker_version_id, publication_ready: true,
    state: "paused", drained: true, runtime_update: { state: "completed", operation_id: value.request.operation_id } });
  expect((await current.updates.activate(value.activation)).update.state).toBe("completed"); expect(value.alarm()).toBe(null);
  const window = crypto.randomUUID(); current.queue.resume(window);
  await expect(current.queue.enqueue(sqlitePublicationRequest(value.runtime, window))).rejects.toThrow("stale");
});

test("unprepared versions, changed configuration and earlier content schemas cannot be adopted", async () => {
  const value = await fixture();
  expect(() => value.make(value.actual)).toThrow("no exact");
  value.old.updates.prepare(value.request);
  expect(() => value.make({ ...value.actual, service_config_sha256: "f".repeat(64) })).toThrow("cannot change");
  value.storage.sql.exec("UPDATE publication_content_schema SET version = 2 WHERE id = 1");
  expect(() => value.make(value.actual)).toThrow("cannot convert");
  expect(value.old.queue.identity().worker_version_id).toBe(value.runtime.worker_version_id);
});

test("open or unfinished services cannot prepare code updates and frozen request changes are rejected", async () => {
  const value = await fixture(), window = crypto.randomUUID(); value.old.queue.resume(window);
  expect(() => value.old.updates.prepare(value.request)).toThrow("paused");
  await value.old.queue.enqueue(sqlitePublicationRequest(value.runtime, window)); value.old.queue.pause();
  expect(() => value.old.updates.prepare(value.request)).toThrow("paused");
  const fresh = await fixture(); fresh.old.updates.prepare(fresh.request);
  expect(() => fresh.old.updates.prepare({ ...fresh.request, worker_source_sha256: "e".repeat(64) })).toThrow("evidence differs");
  expect(() => fresh.old.updates.prepare({ ...fresh.request, operation_id: crypto.randomUUID() })).toThrow("paused");
});

test("activation is bound to the actual new version, exact receipt and namespace without relaxing source IO", async () => {
  const value = await fixture(); value.old.updates.prepare(value.request);
  await expect(value.old.updates.activate(value.activation)).rejects.toThrow("executing new version");
  const current = value.make(value.actual);
  await expect(current.updates.activate({ ...value.activation, namespace_id: "f".repeat(32) })).rejects.toThrow("exact prepared");
  await expect(current.updates.activate({ ...value.activation, new_worker_version_id: crypto.randomUUID() })).rejects.toThrow("executing new version");
  await current.updates.activate(value.activation);
  await expect(current.updates.activate({ ...value.activation, script_etag: "other" })).rejects.toThrow("frozen");
});

test("activation runtime change, probe reservation and retained receipt roll back together", async () => {
  const value = await fixture(); value.old.updates.prepare(value.request);
  const current = value.make(value.actual); value.failAlarm();
  await expect(current.updates.activate(value.activation)).rejects.toThrow("scheduling failure");
  expect(current.queue.identity().worker_version_id).toBe(value.runtime.worker_version_id);
  expect(current.updates.status(value.request).update.state).toBe("prepared"); expect(value.alarm()).toBe(null);
  expect(current.health().setup?.state).toBe("ready"); expect(current.ready()).toBe(false);
});

test("a failed or interrupted updated probe blocks readiness and duplicate activation never reschedules it", async () => {
  for (const interrupted of [false, true]) {
    const value = await fixture(); value.old.updates.prepare(value.request);
    const current = value.make(value.actual); await current.updates.activate(value.activation); value.clearAlarm();
    if (interrupted) value.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'running' WHERE id = 1");
    else value.cacheVersion(crypto.randomUUID());
    await current.alarm();
    expect(current.ready()).toBe(false); expect(current.updates.status(value.request).update.state).toBe("blocked");
    expect((await current.updates.activate(value.activation)).update.state).toBe("blocked"); expect(value.alarm()).toBe(null);
  }
});
