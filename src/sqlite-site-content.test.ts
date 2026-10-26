import { afterEach, expect, test } from "bun:test";
import type { EpisodeRevision } from "../packages/shared/src/index";
import { SqliteSiteContent } from "./sqlite-site-content";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { sqlitePublicationBucket } from "./test-support/sqlite-publication-bucket";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const input = { origin: "https://public.example.com", coverExtension: "jpg" as const,
  show: { show_id: "daily", title: "Show", description: "Description", language: "ja", author: "Author" }, episodeSiteIds: {} };
function episode(index: number, description = "Description"): EpisodeRevision {
  const id = `ep-${index}`, revision = "00000000-0000-4000-8000-000000000001";
  return { schema_version: 1, episode_id: id, revision_id: revision, title: id, description, guid: id,
    published_at: "2026-10-25T00:00:00Z", updated_at: "2026-10-25T00:00:00Z", duration_seconds: 1,
    enclosure_url: `${input.origin}/podcasts/daily/episodes/${id}/${revision}.mp3`,
    content_type: "audio/mpeg", length_bytes: 100, sha256: "a".repeat(64) };
}
function fixture() {
  const storage = sqlitePublicationFixture(); cleanups.push(storage.close);
  return { ...sqlitePublicationBucket(), sites: new SqliteSiteContent(storage.storage), storage: storage.storage };
}

for (const count of [20, 100, 1000]) test(`Episode update at ${count} Episodes replaces listings and only its own detail`, async () => {
  const f = fixture(), episodes = Array.from({ length: count }, (_, index) => episode(index, `<p>説明 ${index}<br>全文</p>`));
  const finish = async (id: string) => {
    const sizes: number[] = [];
    while (!f.sites.complete(id)) {
      const before = f.calls.length;
      await f.sites.batch(id, f.bucket);
      const writes = f.calls.slice(before).filter((call) => call.method === "PUT");
      sizes.push(writes.length);
      expect(writes.length).toBeLessThanOrEqual(20);
      expect(writes.reduce((sum, call) => sum + f.entries.get(call.key)!.size, 0)).toBeLessThanOrEqual(4_000_000);
    }
    f.sites.confirmPurge(id, "media"); f.sites.confirmPurge(id, "site"); f.sites.commit(id);
    return sizes;
  };
  const episodeSiteIds = await f.sites.ids.reserve("daily", episodes);
  const page = (id: string) => ({ kind: "episode" as const, showId: "daily", siteId: episodeSiteIds[id] });
  f.sites.prepare("initial", 1, "daily", { ...input, episodeSiteIds }, episodes);
  await finish("initial");
  const retained = f.sites.page(page("ep-1"));
  const before = JSON.stringify(episodes);
  f.sites.prepare("changed", 2, "daily", { ...input, episodeSiteIds }, episodes, "ep-0");
  const batches = await finish("changed");
  expect(batches.reduce((sum, size) => sum + size, 0)).toBe(Math.ceil(count / 20) + 1);
  expect(batches.length).toBe(Math.ceil((Math.ceil(count / 20) + 1) / 20));
  expect(f.sites.page(page("ep-1"))).toEqual(retained);
  expect(f.sites.page(page("ep-0"))!.generation).toBe(2);
  expect(f.storage.sql.exec("SELECT * FROM publication_site_sources WHERE owner_id = ?", "changed").toArray()).toHaveLength(count);
  expect(f.storage.sql.exec("SELECT * FROM publication_site_candidates WHERE owner_id = ?", "changed").toArray()).toHaveLength(Math.ceil(count / 20) + 1);
  expect(JSON.stringify(episodes)).toBe(before);
});

test("site batches enforce byte bounds as well as page counts, without truncating saved descriptions", async () => {
  const f = fixture(), episodes = Array.from({ length: 12 }, (_, index) => episode(index, "&".repeat(100_000)));
  const episodeSiteIds = await f.sites.ids.reserve("daily", episodes);
  f.sites.prepare("owner", 1, "daily", { ...input, episodeSiteIds }, episodes);
  let batches = 0;
  while (!f.sites.complete("owner")) {
    const start = f.calls.length;
    await f.sites.batch("owner", f.bucket);
    const writes = f.calls.slice(start).filter((call) => call.method === "PUT");
    expect(writes.length).toBeLessThanOrEqual(20);
    expect(writes.reduce((sum, call) => sum + f.entries.get(call.key)!.bytes.length, 0)).toBeLessThanOrEqual(4_000_000);
    batches++;
  }
  expect(batches).toBe(2);
  expect(f.sites.page({ kind: "listing", showId: "daily", page: 1 })).toBeNull();
  expect(() => f.sites.commit("owner")).toThrow("confirmed");
  f.sites.confirmPurge("owner", "media");
  expect(() => f.sites.commit("owner")).toThrow("confirmed");
  f.sites.confirmPurge("owner", "site"); f.sites.commit("owner");
  expect(f.text(`public/podcasts/daily/sites/1/episodes/${episodeSiteIds["ep-0"]}.html`)).toContain("&amp;".repeat(100_000));
  expect(f.sites.state("daily")).toEqual({ generation: 1, enabled: 1, pages: 1 });
});

test("oversized site inventory fails before freezing or writing any candidates", async () => {
  const f = fixture();
  expect(() => f.sites.prepare("owner", 1, "daily", input, [episode(0, "x".repeat(2_000_001))])).toThrow();
  expect(f.sites.build("owner")).toBeNull(); expect(f.calls).toHaveLength(0);
});

test("site generation does not repeat a completed batch or commit unrendered candidates", async () => {
  const f = fixture(); f.sites.prepare("owner", 1, "daily", input, []);
  expect(() => f.sites.confirmPurge("owner", "media")).toThrow("complete");
  expect(await f.sites.batch("owner", f.bucket)).toBe(true);
  expect(await f.sites.batch("owner", f.bucket)).toBe(true);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(f.sites.state("daily")).toBeNull();
});
