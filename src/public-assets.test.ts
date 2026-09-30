import { describe, expect, test } from "bun:test";
import { parsePublicAssetPath, publicAssetCacheProps, publicAssetCacheTags } from "./public-assets";
import type { PublicVisibilitySnapshot } from "./lifecycle-control";

const revisionId = "01234567-89ab-4cde-8fab-0123456789ab";
const audioPath = `/podcasts/daily/episodes/first/${revisionId}.mp3`;
const snapshot: PublicVisibilitySnapshot = { visibility: "public", showId: "daily", showGeneration: 8, feedGeneration: 3 };

describe("approved public asset paths", () => {
  test("feed, supported cover formats and immutable audio map to the existing R2 layout", () => {
    expect(parsePublicAssetPath("/podcasts/daily/feed.xml")).toEqual({ kind: "feed", showId: "daily",
      key: "public/podcasts/daily/feed.xml", contentType: "application/rss+xml; charset=utf-8" });
    expect(parsePublicAssetPath("/podcasts/daily/cover.png")?.contentType).toBe("image/png");
    expect(parsePublicAssetPath("/podcasts/daily/cover.jpg")?.contentType).toBe("image/jpeg");
    expect(parsePublicAssetPath(audioPath)).toEqual({ kind: "audio", showId: "daily", episodeId: "first", revisionId,
      key: `public${audioPath}`, contentType: "audio/mpeg" });
  });

  test("private paths, encodings, non-slugs, malformed UUIDs and extra URL components are rejected", () => {
    for (const path of ["/system/shows/daily/show.toml", "/staging/audio.mp3", "/podcasts/daily/cover.jpeg",
      "/podcasts/Daily/feed.xml", "/podcasts/daily-/feed.xml", "/podcasts/daily/feed.xml?x=1",
      "/podcasts/daily/feed.xml#fragment", "/podcasts/daily/../feed.xml", "/podcasts/%64aily/feed.xml",
      "/podcasts/daily%2fother/feed.xml", "/podcasts/daily/feed.xml/extra", "https://example.com/podcasts/daily/feed.xml",
      audioPath.replace(revisionId, "a".repeat(36)), audioPath.replace(".mp3", ".wav"), audioPath.replace("/first/", "/first_/"),
      `/podcasts/${"a".repeat(33)}/feed.xml`, audioPath.replace("/first/", `/${"a".repeat(81)}/`)]) {
      expect(parsePublicAssetPath(path)).toBeNull();
    }
  });

  test("ID lengths at the approved maximum remain accepted", () => {
    expect(parsePublicAssetPath(`/podcasts/${"a".repeat(32)}/feed.xml`)).not.toBeNull();
    expect(parsePublicAssetPath(`/podcasts/${"a".repeat(32)}/episodes/${"b".repeat(80)}/${revisionId}.mp3`)).not.toBeNull();
  });
});

describe("server-controlled public cache identity", () => {
  test("feed, cover and audio use their applicable visibility generations", () => {
    const feed = parsePublicAssetPath("/podcasts/daily/feed.xml")!;
    const cover = parsePublicAssetPath("/podcasts/daily/cover.png")!;
    const audio = parsePublicAssetPath(audioPath)!;
    expect(publicAssetCacheProps(feed, snapshot)).toEqual({ showGeneration: 8, feedGeneration: 3 });
    expect(publicAssetCacheProps(cover, snapshot)).toEqual({ showGeneration: 8 });
    expect(publicAssetCacheProps(audio, { ...snapshot, episodeId: "first", episodeGeneration: 4 }))
      .toEqual({ showGeneration: 8, episodeGeneration: 4 });
    expect(publicAssetCacheProps(audio, { ...snapshot, episodeId: "first", episodeGeneration: 5 }))
      .not.toEqual(publicAssetCacheProps(audio, { ...snapshot, episodeId: "first", episodeGeneration: 4 }));
  });

  test("non-public/mismatched state and invalid generations cannot produce cache props", () => {
    const feed = parsePublicAssetPath("/podcasts/daily/feed.xml")!;
    const audio = parsePublicAssetPath(audioPath)!;
    for (const state of [{ visibility: "not_found" }, { visibility: "gone" }, { ...snapshot, showId: "other" },
      { ...snapshot, showGeneration: -1 }, { ...snapshot, feedGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...snapshot, episodeId: "first", episodeGeneration: 0 }] as PublicVisibilitySnapshot[]) {
      expect(() => publicAssetCacheProps(feed, state)).toThrow();
    }
    expect(() => publicAssetCacheProps(audio, snapshot)).toThrow();
    expect(() => publicAssetCacheProps(audio, { ...snapshot, episodeId: "other", episodeGeneration: 0 })).toThrow();
    expect(() => publicAssetCacheProps(audio, { ...snapshot, episodeId: "first", episodeGeneration: NaN })).toThrow();
  });

  test("hierarchical tags retain old feed/cover identities and avoid ambiguous Show/Episode slug joins", () => {
    expect(publicAssetCacheTags(parsePublicAssetPath("/podcasts/daily/feed.xml")!)).toEqual(["show-daily", "feed-daily"]);
    expect(publicAssetCacheTags(parsePublicAssetPath("/podcasts/daily/cover.png")!)).toEqual(["show-daily", "cover-daily"]);
    expect(publicAssetCacheTags(parsePublicAssetPath(audioPath)!)).toEqual(["show-daily", "episode-daily/first"]);
    const left = parsePublicAssetPath(`/podcasts/a-b/episodes/c/${revisionId}.mp3`)!;
    const right = parsePublicAssetPath(`/podcasts/a/episodes/b-c/${revisionId}.mp3`)!;
    expect(publicAssetCacheTags(left)[1]).not.toBe(publicAssetCacheTags(right)[1]);
  });
});
