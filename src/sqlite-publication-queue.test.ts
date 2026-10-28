import { afterEach, expect, test } from "bun:test";
import { directPublicationFixture } from "./test-support/direct-publication";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

test("new services start paused and Resume requires a new explicit window", () => {
  const f = sqlitePublicationFixture({ resume: false }); cleanups.push(f.close);
  expect(f.queue.snapshot()).toMatchObject({ state: "paused", active: null, queued: 0, drained: true });
  const window = crypto.randomUUID(); f.queue.resume(window);
  expect(f.queue.snapshot().state).toBe("open"); f.queue.pause();
  expect(() => f.queue.resume(window)).toThrow();
  f.queue.resume(crypto.randomUUID()); expect(f.queue.snapshot().state).toBe("open");
});

test("foreign service/runtime/config and stale admission are rejected without effects", async () => {
  const f = await directPublicationFixture(); cleanups.push(f.close);
  for (const change of [{ service_id: "other" }, { worker_version_id: crypto.randomUUID() },
    { service_config_sha256: "f".repeat(64) }, { admission_window_id: crypto.randomUUID() }]) {
    await expect(f.publish({ ...f.show(), ...change })).rejects.toThrow();
  }
  expect(f.purges).toEqual([]); expect(f.content.inspect("daily").show?.lifecycle).toBe("draft");
});

test("no-op still checks runtime and config, but does not require reopening admission", async () => {
  const f = await directPublicationFixture(); cleanups.push(f.close);
  const request = f.show(); await f.publish(request); f.queue.pause();
  expect((await f.publish(request)).result).toBe("unchanged");
  await expect(f.publish({ ...request, worker_version_id: crypto.randomUUID() })).rejects.toThrow("runtime_mismatch");
  const changed = f.show(); changed.metadata.title = "Changed";
  await expect(f.publish(changed)).rejects.toThrow("stale_window");
});

test("validation failure leaves no failed-job ledger and the next valid publication can proceed", async () => {
  const f = await directPublicationFixture(); cleanups.push(f.close); await f.publish(f.show());
  const invalid = f.episode(); invalid.metadata.title = "a".repeat(256);
  await expect(f.publish(invalid)).rejects.toThrow();
  expect(f.content.inspect("daily", "first").episode).toBeNull();
  expect((await f.publish(f.episode())).result).toBe("changed");
});

test("schema and runtime mismatches do not reset existing data", () => {
  const f = sqlitePublicationFixture(); cleanups.push(f.close);
  expect(() => new SqlitePublicationQueue(f.storage, { ...f.runtime, worker_version_id: crypto.randomUUID() })).toThrow("differs");
  expect(f.queue.identity()).toEqual(f.runtime);
  f.database.exec("UPDATE publication_queue_schema SET version = 1");
  expect(() => new SqlitePublicationQueue(f.storage, f.runtime)).toThrow("Unsupported");
  expect(f.database.query("SELECT version FROM publication_queue_schema").get()).toEqual({ version: 1 });
});

for (const version of [1, 9, 10, 11, 12]) test(`earlier queue schema ${version} is rejected without conversion`, () => {
  const f = sqlitePublicationFixture(); cleanups.push(f.close);
  f.database.exec(`UPDATE publication_queue_schema SET version = ${version}`);
  expect(() => new SqlitePublicationQueue(f.storage, f.runtime)).toThrow("Unsupported");
  expect(f.database.query("SELECT version FROM publication_queue_schema").get()).toEqual({ version });
});
