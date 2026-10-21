import { afterEach, expect, test } from "bun:test";
import { readSqliteCatalog } from "./sqlite-catalog";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { sqliteCatalogRequestSchema, sqliteCatalogResponseSchema } from "../packages/shared/src/sqlite-catalog";

const values: Array<ReturnType<typeof sqlitePublicationFixture>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });
function fixture() {
  const value = sqlitePublicationFixture(); values.push(value);
  const content = new SqlitePublicationContent(value.storage);
  const show = (id: string, lifecycle = "published", title = id) => {
    content.registerShow(id, crypto.randomUUID());
    value.storage.sql.exec("UPDATE publication_shows SET lifecycle = ? WHERE show_id = ?", lifecycle, id);
    value.storage.sql.exec("INSERT INTO publication_show_content VALUES (?, ?, 'jpg', 1, ?, 4)", id, JSON.stringify({ title }), "a".repeat(64));
  };
  const catalog = (input: unknown) => readSqliteCatalog(value.storage, sqliteCatalogRequestSchema.parse(input), value.runtime, "https://public.example.com");
  return { ...value, content, show, catalog };
}

test("SQLite catalog pages use bounded keyset reads, hide tombstones and bind cursors to exact scope", () => {
  const value = fixture();
  for (let index = 0; index < 24; index++) value.show(`show-${String(index).padStart(2, "0")}`, index === 2 ? "deleted" : "published");
  const first = value.catalog({ kind: "show", include_deleted: false });
  expect(first.shows).toHaveLength(20); expect(first.shows!.some((row) => row.lifecycle === "deleted")).toBe(false);
  expect(first.shows![0]).toMatchObject({ show_id: "show-00", title: "show-00", feed_url: "https://public.example.com/podcasts/show-00/feed.xml" });
  const second = value.catalog({ kind: "show", include_deleted: false, cursor: first.next_cursor });
  expect(second.shows).toHaveLength(3); expect(second.next_cursor).toBe(null);
  expect(second.shows![0].show_id > first.shows!.at(-1)!.show_id).toBe(true);
  expect(() => value.catalog({ kind: "show", include_deleted: true, cursor: first.next_cursor })).toThrow("another query");
  expect(() => readSqliteCatalog(value.storage, { kind: "show", include_deleted: false, cursor: first.next_cursor! },
    { ...value.runtime, worker_version_id: crypto.randomUUID() }, "https://public.example.com")).toThrow("another query");
  expect(value.catalog({ kind: "show", include_deleted: true }).shows!.some((row) => row.lifecycle === "deleted")).toBe(true);
});

test("Episode catalog includes saved unpublished snapshots and parent state without treating delivery as authorized", () => {
  const value = fixture(); value.show("daily", "unpublished");
  for (let index = 0; index < 23; index++) {
    const id = `ep-${String(index).padStart(2, "0")}`;
    value.storage.sql.exec("INSERT INTO publication_episodes (show_id, episode_id, lifecycle, revision_id) VALUES ('daily', ?, ?, ?)",
      id, index === 1 ? "deleted" : index === 2 ? "unpublished" : "published", crypto.randomUUID());
    value.storage.sql.exec("INSERT INTO publication_episode_content VALUES ('daily', ?, ?, ?)", id, crypto.randomUUID(),
      JSON.stringify({ title: `Title ${id}`, published_at: "2026-10-16T12:00:00Z" }));
  }
  value.queue.pause();
  const first = value.catalog({ kind: "episode", show_id: "daily", include_deleted: false });
  expect(first).toMatchObject({ state: "paused", show: { lifecycle: "unpublished" }, snapshot_only: true, authorizes_recovery: false });
  expect(first.episodes).toHaveLength(20); expect(first.episodes![1]).toMatchObject({ lifecycle: "unpublished", title: "Title ep-02" });
  expect(value.catalog({ kind: "episode", show_id: "daily", include_deleted: false, cursor: first.next_cursor }).episodes).toHaveLength(2);
  expect(() => value.catalog({ kind: "show", include_deleted: false, cursor: first.next_cursor })).toThrow();
  expect(() => value.catalog({ kind: "episode", show_id: "missing", include_deleted: false })).toThrow("missing");
});

test("catalog hides metadata during unfinished work and escapes titles only at presentation", async () => {
  const value = fixture(); value.show("daily", "published", "Private\tTitle\nLine");
  await value.queue.enqueue(value.request({ kind: "show", show_id: "daily" }));
  expect(value.catalog({ kind: "show", include_deleted: false }).shows![0]).toMatchObject({ unfinished_operation: true, title: null, feed_url: null });
  value.queue.claim(); await value.queue.block(value.queue.snapshot().active!.job_id, "execution_interrupted");
  expect(value.catalog({ kind: "show", include_deleted: false }).shows![0].title).toBe(null);
});

test("strict catalog request and response reject unknown fields, target changes, duplicates and repeated cursors", () => {
  const value = fixture(); value.show("daily");
  expect(() => value.catalog({ kind: "episode", include_deleted: false })).toThrow();
  expect(() => value.catalog({ kind: "show", include_deleted: false, show_id: "daily" })).toThrow();
  expect(() => value.catalog({ kind: "show", include_deleted: false, cursor: "not-json" })).toThrow();
  expect(() => value.catalog({ kind: "show", include_deleted: false, unknown: true })).toThrow();
  const response = value.catalog({ kind: "show", include_deleted: false });
  expect(sqliteCatalogResponseSchema.safeParse({ ...response, shows: [response.shows![0], response.shows![0]] }).success).toBe(false);
  expect(sqliteCatalogResponseSchema.safeParse({ ...response, next_cursor: "same" }).success).toBe(false);
});
