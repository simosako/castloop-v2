import { describe, expect, spyOn, test } from "bun:test";
import { serveLifecyclePublicRequest } from "./lifecycle-gateway";
import { episodeLifecycleSchema, stringifyLifecycleToml } from "../packages/shared/src/index";
import type { LifecycleState } from "../packages/shared/src/index";
import type { PublicCacheProps } from "./public-assets";

const revision = crypto.randomUUID();
const audioPath = `/podcasts/daily/episodes/first/${revision}.mp3`;

function fixture(showState: LifecycleState = "active", episodeState: LifecycleState = "active") {
  let show = { schema_version: 2, show_id: "daily", lifecycle: showState, generation: 2, feed_generation: 3 };
  let episode = episodeLifecycleSchema.parse({ schema_version: 1, show_id: "daily", episode_id: "first",
    lifecycle: episodeState, generation: 4 });
  const reads: string[] = [];
  const env = { CASTLOOP_BUCKET: {
    async get(key: string) {
      reads.push(key);
      if (key === "system/show-publications/daily.json") return {
        size: 256, etag: "show", json: async () => show,
      };
      if (key === "system/episode-lifecycle/daily/first.toml") return {
        size: 256, etag: "episode", text: async () => stringifyLifecycleToml(episode),
      };
      return null;
    },
    async head() { return null; },
  } } as never;
  return { env, reads, stopShow(state: LifecycleState) { show = { ...show, lifecycle: state, generation: show.generation + 1 }; },
    stopEpisode(state: LifecycleState) { episode = { ...episode, lifecycle: state, generation: episode.generation + 1 }; } };
}

describe("M6 uncached gateway delivery", () => {
  test("persistent logs do not receive raw exception messages or secrets", async () => {
    const setup = fixture();
    const logs: unknown[][] = [];
    const logger = spyOn(console, "error").mockImplementation((...values: unknown[]) => { logs.push(values); });
    try {
      const response = await serveLifecyclePublicRequest(new Request(`https://public.example${audioPath}`), setup.env,
        async () => { throw new Error("title=private owner@example.com Bearer super-secret-token"); });
      expect(response?.status).toBe(503);
      expect(logs).toHaveLength(1);
      const text = JSON.stringify(logs);
      expect(text).toContain("public_delivery_failed");
      for (const value of ["title=private", "owner@example.com", "super-secret-token"]) expect(text).not.toContain(value);
    } finally {
      logger.mockRestore();
    }
  });
  test("every warm-cache request rechecks state and stops all revision links before conditional/Range processing", async () => {
    const setup = fixture();
    let cachedCalls = 0;
    const fetch = async () => { cachedCalls += 1; return new Response("cached audio"); };
    expect((await serveLifecyclePublicRequest(new Request(`https://public.example${audioPath}`), setup.env, fetch))?.status).toBe(200);
    expect((await serveLifecyclePublicRequest(new Request(`https://other.example${audioPath}?x=1`), setup.env, fetch))?.status).toBe(200);
    setup.stopEpisode("unpublished");
    for (const method of ["GET", "HEAD"] as const) {
      for (const path of [audioPath, `/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`]) {
        const response = await serveLifecyclePublicRequest(new Request(`https://other.example${path}?generation=0`, {
          method, headers: { "Range": "bytes=0-1", "If-None-Match": '"old-etag"' },
        }), setup.env, fetch);
        expect(response?.status).toBe(404);
        expect(response?.headers.get("Cache-Control")).toBe("no-store");
        if (method === "HEAD") expect(await response?.text()).toBe("");
      }
    }
    expect(cachedCalls).toBe(2);
    expect(setup.reads.filter((key) => key.endsWith("daily.json"))).toHaveLength(6);
  });

  test("Show gates feed, cover and audio with consistent 404/410 and never calls the cached entrypoint", async () => {
    for (const [state, status] of [["draft", 404], ["unpublished", 404], ["deleting", 410], ["deleted", 410]] as const) {
      const setup = fixture(state);
      for (const path of ["/podcasts/daily/feed.xml", "/podcasts/daily/cover.jpg", audioPath]) {
        const response = await serveLifecyclePublicRequest(new Request(`https://public.example${path}`, { method: "HEAD" }),
          setup.env, async () => { throw new Error("Cache must not be called"); });
        expect(response?.status).toBe(status);
        expect(await response?.text()).toBe("");
      }
    }
  });

  test("trusted props ignore client generation and retain active Range/HEAD/304 headers while separating client TTL", async () => {
    const setup = fixture();
    const props: PublicCacheProps[] = [];
    const requests: Request[] = [];
    for (const [method, status] of [["GET", 206], ["HEAD", 200], ["GET", 304]] as const) {
      const request = new Request(`https://public.example${audioPath}?showGeneration=999`, {
        method, headers: { "Range": "bytes=0-1", "If-None-Match": '"etag"' },
      });
      const response = await serveLifecyclePublicRequest(request, setup.env, async (received, asset, cacheProps) => {
        props.push(cacheProps);
        requests.push(received);
        expect(asset.key).toBe(`public${audioPath}`);
        return new Response(status === 304 ? null : "ab", { status, headers: { "Content-Range": "bytes 0-1/10",
          "Accept-Ranges": "bytes", "ETag": '"etag"', "Cache-Control": "public, max-age=31536000, immutable",
          "Cloudflare-CDN-Cache-Control": "public, max-age=31536000", "CDN-Cache-Control": "max-age=99", "Cache-Tag": "inner-tag" } });
      });
      expect(response?.status).toBe(status);
      expect(response?.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
      expect(response?.headers.get("Content-Range")).toBe("bytes 0-1/10");
      expect(response?.headers.get("ETag")).toBe('"etag"');
      expect(response?.headers.has("Cloudflare-CDN-Cache-Control")).toBe(false);
      expect(response?.headers.has("CDN-Cache-Control")).toBe(false);
      expect(response?.headers.has("Cache-Tag")).toBe(false);
      expect(requests.at(-1)).toBe(request);
      expect(requests.at(-1)?.headers.get("Range")).toBe("bytes=0-1");
      if (method === "HEAD" || status === 304) expect(await response?.text()).toBe("");
    }
    expect(props).toEqual(Array.from({ length: 3 }, () => ({ showGeneration: 2, episodeGeneration: 4 })));
    const feed = await serveLifecyclePublicRequest(new Request("https://public.example/podcasts/daily/feed.xml"), setup.env,
      async (_request, _asset, props) => { expect(props).toEqual({ showGeneration: 2, feedGeneration: 3 }); return new Response("feed"); });
    expect(feed?.status).toBe(200);
  });

  test("internal non-success responses are not client cached", async () => {
    const setup = fixture();
    for (const status of [404, 416, 500]) {
      const response = await serveLifecyclePublicRequest(new Request(`https://public.example${audioPath}`), setup.env,
        async () => new Response(null, { status }));
      expect(response?.status).toBe(status);
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("state corruption, read failure or cached transport failure returns 503 without cached fallback", async () => {
    const setup = fixture();
    const failures = [
      { CASTLOOP_BUCKET: { async get() { throw new Error("R2 unavailable"); } } } as never,
      { CASTLOOP_BUCKET: { async get() { return { size: 100, json: async () => ({ bad: "record" }) }; } } } as never,
    ];
    for (const env of failures) {
      const response = await serveLifecyclePublicRequest(new Request(`https://public.example${audioPath}`, { method: "HEAD" }), env,
        async () => { throw new Error("Cached fallback must not run"); });
      expect(response?.status).toBe(503);
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      expect(await response?.text()).toBe("");
    }
    const failed = await serveLifecyclePublicRequest(new Request(`https://public.example${audioPath}`), setup.env,
      async () => { throw new Error("Inner unavailable"); });
    expect(failed?.status).toBe(503);
  });

  test("unsupported paths and methods never reach state or cached transport", async () => {
    const setup = fixture();
    for (const request of [new Request("https://public.example/system/shows/daily/show.toml"),
      new Request("https://public.example/staging/episodes/daily/first/audio.mp3"),
      new Request("https://public.example/podcasts/daily/feed.xml", { method: "POST" }),
      new Request("https://public.example/admin/health")]) {
      expect(await serveLifecyclePublicRequest(request, setup.env, async () => { throw new Error("Unexpected cache call"); })).toBeNull();
    }
    expect(setup.reads).toEqual([]);
  });
});
