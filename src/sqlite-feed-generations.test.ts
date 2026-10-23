import { afterEach, expect, test } from "bun:test";
import { reserveSqliteFeedGeneration } from "./sqlite-feed-generations";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture() { const value = sqlitePublicationFixture(); cleanups.push(value.close); return value; }
const domain = () => ({ kind: "domain" as const, id: crypto.randomUUID(), showId: "daily", requestSha256: "b".repeat(64) });

test("domain and publication reservations share one monotonic Feed namespace without changing FIFO sequence", async () => {
  const value = fixture(), content = new SqlitePublicationContent(value.storage);
  expect(reserveSqliteFeedGeneration(value.storage, domain())).toBe(1);
  const request = value.request();
  expect((await value.queue.enqueue(request)).sequence).toBe(1);
  expect(value.queue.claim().state).toBe("claimed");
  expect(content.feedGeneration(request)).toBe(2);
  expect(content.publicationSequence(request)).toBe(1);
  expect(reserveSqliteFeedGeneration(value.storage, domain())).toBe(3);
  expect(content.feedGeneration(request)).toBe(2);
});

test("reservations survive re-instantiation and bind the complete owner and target", () => {
  const value = fixture(), request = domain();
  expect(reserveSqliteFeedGeneration(value.storage, request)).toBe(1);
  new SqlitePublicationQueue(value.storage, value.runtime);
  expect(reserveSqliteFeedGeneration(value.storage, request)).toBe(1);
  for (const change of [{ showId: "other" }, { requestSha256: "c".repeat(64) }]) {
    expect(() => reserveSqliteFeedGeneration(value.storage, { ...request, ...change })).toThrow("frozen");
  }
  expect(reserveSqliteFeedGeneration(value.storage, domain())).toBe(2);
});

test("failed admission rolls the generation reservation back with the job and Alarm", async () => {
  const value = fixture(), request = value.request(); value.failAlarm();
  await expect(value.queue.enqueue(request)).rejects.toThrow("scheduling failure");
  expect(value.storage.sql.exec("SELECT * FROM publication_feed_generations").toArray()).toEqual([]);
  expect(value.queue.status(request.request_id)).toBeNull();
  expect((await value.queue.enqueue(request)).sequence).toBe(1);
});

test("tampered generation ownership and exhausted counters cannot be adopted", async () => {
  const value = fixture(), content = new SqlitePublicationContent(value.storage), request = value.request();
  await value.queue.enqueue(request); value.queue.claim();
  value.storage.sql.exec("UPDATE publication_feed_generations SET request_sha256 = ?", "f".repeat(64));
  expect(() => content.feedGeneration(request)).toThrow("reservation differs");
  value.storage.sql.exec("UPDATE sqlite_sequence SET seq = ? WHERE name = 'publication_feed_generations'", Number.MAX_SAFE_INTEGER);
  expect(() => reserveSqliteFeedGeneration(value.storage, domain())).toThrow("exhausted");
});

test("earlier queue format is rejected without creating reservations or converting stored rows", () => {
  const value = fixture();
  value.storage.sql.exec("UPDATE publication_queue_schema SET version = 5");
  expect(() => new SqlitePublicationQueue(value.storage, value.runtime)).toThrow("Unsupported");
  expect(value.storage.sql.exec("SELECT version FROM publication_queue_schema").toArray()).toEqual([{ version: 5 }]);
});
