import { describe, expect, test } from "bun:test";
import { classifyLifecycleDeletionKey, lifecycleDeletionScopes, readLifecycleDeletionPage } from "./lifecycle-deletion";
import type { DeletionTarget } from "./lifecycle-deletion";

const job = crypto.randomUUID();
const revision = crypto.randomUUID();
const show: DeletionTarget = { kind: "show", showId: "daily" };
const episode: DeletionTarget = { kind: "episode", showId: "daily", episodeId: "first" };

function inventory(keys: string[]) {
  const objects = keys.map((key) => ({ key, etag: `etag-${key}`, size: 300_000_000 }));
  const calls: string[] = [];
  return { calls, objects, env: { CASTLOOP_BUCKET: {
    async head(key: string) { calls.push(`head:${key}`); return objects.find((object) => object.key === key) ?? null; },
    async list(options: { prefix: string; cursor?: string; limit: number }) {
      calls.push(`list:${options.prefix}`);
      const matching = objects.filter((object) => object.key.startsWith(options.prefix));
      const start = Number(options.cursor ?? 0);
      const page = matching.slice(start, start + options.limit);
      return { objects: page, truncated: start + options.limit < matching.length, cursor: String(start + options.limit) };
    },
  } } as never };
}

describe("M6 read-only deletion inventory", () => {
  test("scopes exclude reservation, controls, lifecycle audit, other Shows and similar IDs", () => {
    const forbidden = ["system/show-reservations/daily.json", "system/show-publications/daily.json",
      "system/episode-lifecycle/daily/first.toml", `system/jobs/${job}/request.toml`,
      `staging/lifecycle/shows/daily/${job}/commit.json`, `public/podcasts/daily-two/feed.xml`,
      `public/podcasts/daily/episodes/first-two/${revision}.mp3`, `staging/episodes/daily/first-two/${job}/audio.mp3`];
    for (const key of forbidden) expect(classifyLifecycleDeletionKey(episode, key)).toBe("outside");
    for (const key of forbidden.slice(0, 6)) expect(classifyLifecycleDeletionKey(show, key)).toBe("outside");
    expect(lifecycleDeletionScopes(show)).toHaveLength(5);
    expect(lifecycleDeletionScopes(episode)).toHaveLength(3);
    expect(() => lifecycleDeletionScopes({ kind: "show", showId: "../bad" })).toThrow();
    expect(() => lifecycleDeletionScopes({ kind: "episode", showId: "daily", episodeId: "" })).toThrow();
  });

  test("all approved media, metadata and drafts are payload; commits alone are retained", () => {
    const keys = [`public/podcasts/daily/episodes/first/${revision}.mp3`, "public/episodes/daily/first/metadata.toml",
      `public/episodes/daily/first/revisions/${revision}.toml`, `staging/episodes/daily/first/${job}/episode.toml`,
      `staging/episodes/daily/first/${job}/audio.mp3`];
    for (const key of keys) {
      expect(classifyLifecycleDeletionKey(episode, key)).toBe("payload");
      expect(classifyLifecycleDeletionKey(show, key)).toBe("payload");
    }
    for (const key of ["system/shows/daily/show.toml", "public/podcasts/daily/feed.xml", "public/podcasts/daily/cover.png",
      `staging/shows/daily/${job}/show.toml`, `staging/shows/daily/${job}/cover.jpg`]) {
      expect(classifyLifecycleDeletionKey(show, key)).toBe("payload");
      expect(classifyLifecycleDeletionKey(episode, key)).toBe("outside");
    }
    expect(classifyLifecycleDeletionKey(show, `staging/shows/daily/${job}/commit.json`)).toBe("marker");
    expect(classifyLifecycleDeletionKey(episode, `staging/episodes/daily/first/${job}/commit.json`)).toBe("marker");
    for (const key of ["public/podcasts/daily/private.txt", "public/episodes/daily/first/unknown.toml",
      "staging/episodes/daily/first/not-a-uuid/audio.mp3", `staging/episodes/daily/first/${job}/commit.json/extra`]) {
      expect(classifyLifecycleDeletionKey(show, key)).toBe("unknown");
    }
  });

  test("pages report payload sizes, retained markers and blockers without reading or deleting media", async () => {
    const keys = [`staging/episodes/daily/first/${job}/audio.mp3`, `staging/episodes/daily/first/${job}/commit.json`,
      `staging/episodes/daily/first/${job}/unexpected.txt`, `staging/episodes/daily/first-two/${job}/audio.mp3`];
    const { env, calls, objects } = inventory(keys);
    const before = JSON.stringify(objects);
    const first = await readLifecycleDeletionPage(env, episode, { scopeIndex: 2, limit: 2 });
    expect(first.payload.map((object) => object.key)).toEqual([keys[0]]);
    expect(first.payload[0]?.size).toBe(300_000_000);
    expect(first.retainedMarkers.map((object) => object.key)).toEqual([keys[1]]);
    expect(first.authorizesDeletion).toBe(false);
    expect(first.scopeComplete).toBe(false);
    const last = await readLifecycleDeletionPage(env, episode, { scopeIndex: 2, cursor: first.nextCursor, limit: 2 });
    expect(last.blockers).toEqual([keys[2]]);
    expect(last.scopeComplete).toBe(true);
    expect(JSON.stringify(objects)).toBe(before);
    expect(calls).toEqual(["list:staging/episodes/daily/first/", "list:staging/episodes/daily/first/"]);
  });

  test("exact Show snapshot lookup never lists an adjacent Show", async () => {
    const { env, calls } = inventory(["system/shows/daily/show.toml", "system/shows/daily-two/show.toml"]);
    const page = await readLifecycleDeletionPage(env, show, { scopeIndex: 0 });
    expect(page.payload.map((object) => object.key)).toEqual(["system/shows/daily/show.toml"]);
    expect(calls).toEqual(["head:system/shows/daily/show.toml"]);
    const empty = await readLifecycleDeletionPage(inventory([]).env, show, { scopeIndex: 0 });
    expect(empty.payload).toEqual([]);
  });

  test("invalid limits, stale cursors, inconsistent listings and read failures do not imply completion", async () => {
    const { env } = inventory([]);
    for (const options of [{ scopeIndex: -1 }, { scopeIndex: 5 }, { scopeIndex: 1, limit: 0 },
      { scopeIndex: 1, limit: 1001 }, { scopeIndex: 0, cursor: "x" }, { scopeIndex: 1, cursor: "" }]) {
      await expect(readLifecycleDeletionPage(env, show, options)).rejects.toThrow();
    }
    for (const listed of [{ objects: [], truncated: true, cursor: "x" },
      { objects: [{ key: "public/podcasts/other/feed.xml", size: 1, etag: "x" }], truncated: false },
      { objects: [{ key: "public/podcasts/daily/feed.xml", size: -1, etag: "x" }], truncated: false }]) {
      const broken = { CASTLOOP_BUCKET: { async list() { return listed; } } } as never;
      await expect(readLifecycleDeletionPage(broken, show, { scopeIndex: 1, cursor: "x" })).rejects.toThrow();
    }
    const failure = { CASTLOOP_BUCKET: { async list() { throw new Error("R2 unavailable"); } } } as never;
    await expect(readLifecycleDeletionPage(failure, show, { scopeIndex: 1 })).rejects.toThrow("R2 unavailable");
  });
});
