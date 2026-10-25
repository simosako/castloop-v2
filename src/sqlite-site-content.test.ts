import { afterEach, expect, test } from "bun:test";
import type { EpisodeRevision } from "../packages/shared/src/index";
import { SqliteSiteContent } from "./sqlite-site-content";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { sqlitePublicationBucket } from "./test-support/sqlite-publication-bucket";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const input = { origin: "https://public.example.com", coverExtension: "jpg" as const,
  show: { show_id: "daily", title: "Show", description: "Description", language: "ja", author: "Author" } };
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

test("site batches enforce byte bounds as well as page counts, without truncating saved descriptions", async () => {
  const f = fixture(), episodes = Array.from({ length: 12 }, (_, index) => episode(index, "&".repeat(100_000)));
  f.sites.prepare("owner", 1, "daily", input, episodes);
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
  expect(f.text("public/podcasts/daily/sites/1/episodes/ep-0.html")).toContain("&amp;".repeat(100_000));
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
