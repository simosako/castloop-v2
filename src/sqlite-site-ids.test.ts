import { afterEach, expect, test } from "bun:test";
import { sha256Hex } from "../packages/shared/src/sha256";
import { SqliteSiteIds } from "./sqlite-site-ids";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const storage = sqlitePublicationFixture(); cleanups.push(storage.close);
  return { storage: storage.storage, ids: new SqliteSiteIds(storage.storage) };
}

test("page IDs hash the whole Episode identity, require no administrator input and survive reload", async () => {
  const f = fixture(), episodeId = "ep-8cc15ae4c2a0628ca3db2113afd7315c79299e865e8108b68d57042d726cd652";
  const episodes = [episodeId, "ordinary-title", "ordinary-title-two", "constructor"].map((episode_id) => ({ episode_id }));
  const ids = await f.ids.reserve("daily", episodes);
  expect(ids[episodeId]).toBe("db0a48404cdf5c53");
  for (const episode of episodes) {
    expect(ids[episode.episode_id]).toBe((await sha256Hex(episode.episode_id)).slice(0, 16));
    expect(f.ids.episode("daily", ids[episode.episode_id])).toBe(episode.episode_id);
  }
  expect(await new SqliteSiteIds(f.storage).reserve("daily", episodes.toReversed())).toEqual(ids);
  expect(await f.ids.reserve("other", episodes)).toEqual(ids);
});

test("collisions extend only the new page ID, and preview never reserves or reassigns an ID", async () => {
  const f = fixture(), hash = await sha256Hex("new-episode");
  for (const length of [16, 20]) f.storage.sql.exec(
    "INSERT INTO publication_site_ids (show_id, episode_id, site_id) VALUES (?, ?, ?)", "daily", `previous-${length}`, hash.slice(0, length));
  expect(await f.ids.preview("daily", "new-episode")).toBe(hash.slice(0, 24));
  expect(f.ids.get("daily", "new-episode")).toBeNull();
  const ids = await f.ids.reserve("daily", [{ episode_id: "new-episode" }]);
  expect(ids["new-episode"]).toBe(hash.slice(0, 24));
  const reloaded = new SqliteSiteIds(f.storage);
  expect(await reloaded.preview("daily", "new-episode")).toBe(hash.slice(0, 24));
  expect((await reloaded.reserve("daily", [{ episode_id: "new-episode" }]))["new-episode"]).toBe(hash.slice(0, 24));
  expect(f.ids.get("daily", "previous-16")).toBe(hash.slice(0, 16));
  expect(f.ids.get("daily", "previous-20")).toBe(hash.slice(0, 20));
  expect(await f.ids.preview("other", "new-episode")).toBe(hash.slice(0, 16));
  expect(f.ids.episode("daily", "b".repeat(16))).toBeNull();
});

test("exhausted collision candidates fail before publication without stealing any reservation", async () => {
  const f = fixture(), hash = await sha256Hex("new-episode");
  for (let length = 16; length <= 64; length += 4) f.storage.sql.exec(
    "INSERT INTO publication_site_ids (show_id, episode_id, site_id) VALUES (?, ?, ?)", "daily", `previous-${length}`, hash.slice(0, length));
  const before = f.ids.all("daily");
  await expect(f.ids.reserve("daily", [{ episode_id: "new-episode" }])).rejects.toThrow("validation_failed");
  expect(f.ids.all("daily")).toEqual(before);
  expect(f.ids.get("daily", "new-episode")).toBeNull();
});
