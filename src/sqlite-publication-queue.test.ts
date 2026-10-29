import { afterEach, expect, test } from "bun:test";
import { directPublicationFixture } from "./test-support/direct-publication";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

test("foreign service/config identities are rejected without effects", async () => {
  const f = await directPublicationFixture(); cleanups.push(f.close);
  for (const change of [{ service_id: "other" }, { service_config_sha256: "f".repeat(64) }]) {
    await expect(f.publish({ ...f.show(), ...change })).rejects.toThrow();
  }
  expect(f.purges).toEqual([]); expect(f.content.inspect("daily").show?.lifecycle).toBe("draft");
});

test("worker version changes do not affect admission; identity still guards no-ops", async () => {
  const f = await directPublicationFixture(); cleanups.push(f.close);
  const request = f.show(); await f.publish(request);
  expect((await f.publish(request)).result).toBe("unchanged");
  await expect(f.publish({ ...request, service_config_sha256: "f".repeat(64) })).rejects.toThrow("runtime_mismatch");
  const changed = f.show(); changed.metadata.title = "Changed";
  expect((await f.publish(changed)).result).toBe("changed");
});

test("validation failure leaves no failed-job ledger and the next valid publication can proceed", async () => {
  const f = await directPublicationFixture(); cleanups.push(f.close); await f.publish(f.show());
  const invalid = f.episode(); invalid.metadata.title = "a".repeat(256);
  await expect(f.publish(invalid)).rejects.toThrow();
  expect(f.content.inspect("daily", "first").episode).toBeNull();
  expect((await f.publish(f.episode())).result).toBe("changed");
});

test("schema and service mismatches do not reset existing data", () => {
  const f = sqlitePublicationFixture(); cleanups.push(f.close);
  expect(() => new SqlitePublicationQueue(f.storage, { ...f.runtime, service_id: "other" })).toThrow("differs");
  expect(f.queue.identity()).toEqual(f.runtime);
  f.database.exec("UPDATE publication_queue_schema SET version = 1");
  expect(() => new SqlitePublicationQueue(f.storage, f.runtime)).toThrow("Unsupported");
  expect(f.database.query("SELECT version FROM publication_queue_schema").get()).toEqual({ version: 1 });
});

for (const version of [1, 9, 10, 11, 12, 13]) test(`earlier queue schema ${version} is rejected without conversion`, () => {
  const f = sqlitePublicationFixture(); cleanups.push(f.close);
  f.database.exec(`UPDATE publication_queue_schema SET version = ${version}`);
  expect(() => new SqlitePublicationQueue(f.storage, f.runtime)).toThrow("Unsupported");
  expect(f.database.query("SELECT version FROM publication_queue_schema").get()).toEqual({ version });
});
