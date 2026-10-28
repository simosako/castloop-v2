import { describe, expect, test } from "bun:test";
import { serveCachedLifecycleAsset } from "./lifecycle-cache";

const AUDIO_PATH = "/podcasts/daily/episodes/first/6cefc5cc-5d0c-4cc7-8e3d-aa99711b74e2.mp3";
const DATA = new TextEncoder().encode("0123456789abcdefghij");
const AUDIO_KEY = `public/podcasts/daily/audio/${"a".repeat(64)}.mp3`;
const COVER_KEY = `public/podcasts/daily/covers/${"b".repeat(64)}.png`;
const AUDIO_PROPS = { showGeneration: 0, episodeGeneration: 0, objectKey: AUDIO_KEY };

function fixture(path = AUDIO_PATH) {
  const calls: Array<{ method: string; key: string; options?: object }> = [];
  const metadata = { key: path.endsWith("feed.xml") ? "public/podcasts/daily/feeds/1.xml" : path.endsWith("cover.png") ? COVER_KEY : AUDIO_KEY, size: DATA.length, etag: "revision-etag", httpEtag: '"revision-etag"',
    uploaded: new Date("2026-10-01T12:00:00.123Z") };
  const bucket = {
    async head(key: string) { calls.push({ method: "head", key }); return metadata; },
    async get(key: string, options?: { onlyIf?: { etagMatches?: string }; range?: { offset: number; length: number } }) {
      calls.push({ method: "get", key, options });
      const range = options?.range;
      const bytes = range ? DATA.slice(range.offset, range.offset + range.length) : DATA;
      return { ...metadata, body: new Blob([bytes]).stream(), async arrayBuffer() { throw new Error("Body must be streamed"); } };
    },
  };
  const env = { CASTLOOP_BUCKET: bucket } as never;
  return { env, bucket, calls, metadata, request: (headers: HeadersInit = {}, method = "GET") =>
    new Request(`https://castloop-cache.invalid${path}`, { method, headers }) };
}

describe("cached public asset handler", () => {
  test("cover HEAD, Range and validators are pinned to its own immutable generation", async () => {
    const setup = fixture("/podcasts/daily/cover.png"), props = { showGeneration: 9, coverGeneration: 1, objectKey: COVER_KEY };
    const head = await serveCachedLifecycleAsset(setup.request({}, "HEAD"), setup.env, props);
    expect(head.status).toBe(200); expect(await head.text()).toBe("");
    const range = await serveCachedLifecycleAsset(setup.request({ Range: "bytes=2-5" }), setup.env, props);
    expect(range.status).toBe(206); expect(await range.text()).toBe("2345");
    expect((await serveCachedLifecycleAsset(setup.request({ "If-None-Match": setup.metadata.httpEtag }), setup.env, props)).status).toBe(304);
    expect((await serveCachedLifecycleAsset(setup.request({ "If-Modified-Since": setup.metadata.uploaded.toUTCString() }), setup.env, props)).status).toBe(304);
    expect((await serveCachedLifecycleAsset(setup.request({ "If-Match": '"wrong"' }), setup.env, props)).status).toBe(412);
    expect(setup.calls.every((call) => call.key === COVER_KEY)).toBe(true);
    setup.calls.length = 0;
    for (const invalid of [{ showGeneration: 9 }, { ...props, coverGeneration: 0 }, { ...props, coverGeneration: 1.5 },
      { ...props, feedGeneration: 1 }, { ...props, episodeGeneration: 1 }]) {
      expect((await serveCachedLifecycleAsset(setup.request(), setup.env, invalid)).status).toBe(503);
    }
    expect(setup.calls).toEqual([]);
    const missing = await serveCachedLifecycleAsset(setup.request(), { CASTLOOP_BUCKET: { head: async () => null } } as never, props);
    expect(missing.status).toBe(503); expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });

  test("Feed HEAD, Range and validators read only the committed snapshot; invalid generations never reach R2", async () => {
    const setup = fixture("/podcasts/daily/feed.xml"), props = { showGeneration: 1, feedGeneration: 1 };
    expect((await serveCachedLifecycleAsset(setup.request({}, "HEAD"), setup.env, props)).status).toBe(200);
    expect((await serveCachedLifecycleAsset(setup.request({ "If-None-Match": '"revision-etag"' }), setup.env, props)).status).toBe(304);
    const range = await serveCachedLifecycleAsset(setup.request({ Range: "bytes=0-3" }), setup.env, props);
    expect(range.status).toBe(206); expect(await range.text()).toBe("0123");
    expect(setup.calls.every((call) => call.key === "public/podcasts/daily/feeds/1.xml")).toBe(true);
    const count = setup.calls.length;
    for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await serveCachedLifecycleAsset(setup.request(), setup.env, { ...props, feedGeneration: generation })).status).toBe(503);
    }
    expect(setup.calls).toHaveLength(count);
  });
  test("GET streams the full object with tags and validators; HEAD reads metadata only", async () => {
    const setup = fixture();
    const props = { showGeneration: 1, episodeGeneration: 2, objectKey: AUDIO_KEY };
    const response = await serveCachedLifecycleAsset(setup.request(), setup.env, props);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789abcdefghij");
    expect(response.headers.get("Cache-Tag")).toBe("show-daily,episode-daily/first");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000");
    expect(response.headers.get("ETag")).toBe('"revision-etag"');
    expect(setup.calls[1]?.options).toEqual({ onlyIf: { etagMatches: "revision-etag" } });
    setup.calls.length = 0;
    const head = await serveCachedLifecycleAsset(setup.request({ Range: "bytes=0-3" }, "HEAD"), setup.env, props);
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("Content-Length")).toBe("20");
    expect(setup.calls.map((call) => call.method)).toEqual(["head"]);
  });

  test("a cold cache serves byte, open-ended, suffix and clamped ranges correctly", async () => {
    for (const [range, body, contentRange] of [["bytes=0-3", "0123", "bytes 0-3/20"],
      ["bytes=16-", "ghij", "bytes 16-19/20"], ["bytes=-4", "ghij", "bytes 16-19/20"],
      ["bytes=18-999", "ij", "bytes 18-19/20"], ["bytes=-999", "0123456789abcdefghij", "bytes 0-19/20"]]) {
      const setup = fixture();
      const response = await serveCachedLifecycleAsset(setup.request({ Range: range! }), setup.env, AUDIO_PROPS);
      expect(response.status).toBe(206);
      expect(await response.text()).toBe(body!);
      expect(response.headers.get("Content-Range")).toBe(contentRange!);
      expect(response.headers.get("Content-Length")).toBe(String(body!.length));
    }
  });

  test("unsatisfiable ranges return no-store 416 without fetching the body; malformed/multiple ranges are ignored", async () => {
    for (const range of ["bytes=20-", "bytes=9-2", "bytes=-0", "bytes=999999999999999999999-"]) {
      const setup = fixture();
      const response = await serveCachedLifecycleAsset(setup.request({ Range: range }), setup.env, AUDIO_PROPS);
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */20");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(setup.calls.map((call) => call.method)).toEqual(["head"]);
    }
    for (const range of ["bytes=0-1,4-5", "bytes=bad", "units=0-3"]) {
      const setup = fixture();
      expect((await serveCachedLifecycleAsset(setup.request({ Range: range }), setup.env, AUDIO_PROPS)).status).toBe(200);
    }
  });

  test("conditional requests use HTTP date granularity and ETag precedence without reading media", async () => {
    const notModified: HeadersInit[] = [{ "If-None-Match": 'W/"revision-etag"' }, { "If-None-Match": '"other", "revision-etag"' },
      { "If-None-Match": "*" }, { "If-Modified-Since": "Thu, 01 Oct 2026 12:00:00 GMT" }];
    for (const headers of notModified) {
      const setup = fixture();
      const response = await serveCachedLifecycleAsset(setup.request(headers), setup.env, AUDIO_PROPS);
      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect(setup.calls.map((call) => call.method)).toEqual(["head"]);
    }
    const preconditions: HeadersInit[] = [{ "If-Match": 'W/"revision-etag"' }, { "If-Match": '"other"' },
      { "If-Unmodified-Since": "Thu, 01 Oct 2026 11:59:59 GMT" }];
    for (const headers of preconditions) {
      const setup = fixture();
      expect((await serveCachedLifecycleAsset(setup.request(headers), setup.env, AUDIO_PROPS)).status).toBe(412);
      expect(setup.calls).toHaveLength(1);
    }
    const setup = fixture();
    const headers = { "If-None-Match": '"other"', "If-Modified-Since": "Fri, 02 Oct 2026 12:00:00 GMT" };
    expect((await serveCachedLifecycleAsset(setup.request(headers), setup.env, AUDIO_PROPS)).status).toBe(200);
  });

  test("If-Range mismatches force full delivery, while matching strong ETags/dates permit ranges", async () => {
    for (const [value, expected] of [['"revision-etag"', 206], ["Thu, 01 Oct 2026 12:00:00 GMT", 206],
      ['W/"revision-etag"', 200], ['"other"', 200], ["Wed, 30 Sep 2026 12:00:00 GMT", 200], ["not-a-date", 200]] as const) {
      const setup = fixture();
      expect((await serveCachedLifecycleAsset(setup.request({ Range: "bytes=0-3", "If-Range": value }), setup.env,
        AUDIO_PROPS)).status).toBe(expected);
    }
  });

  test("object changes between HEAD and GET never deliver an inconsistent response", async () => {
    const setup = fixture();
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async get() { return setup.metadata; } } } as never;
    const original = console.error;
    const logs: string[] = [];
    console.error = (value) => { logs.push(String(value)); };
    try {
      const response = await serveCachedLifecycleAsset(setup.request(), env, AUDIO_PROPS);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(logs[0]).toContain('"reason_code":"public_delivery_failed"');
    } finally { console.error = original; }
  });

  test("only approved asset paths with exact generation props can reach the bucket", async () => {
    const setup = fixture();
    for (const props of [{ showGeneration: -1, episodeGeneration: 0 }, { showGeneration: 0 },
      { showGeneration: 0, episodeGeneration: 0, feedGeneration: 0 }, { showGeneration: 0.5, episodeGeneration: 0 },
      { ...AUDIO_PROPS, objectKey: "system/service.toml" }, { ...AUDIO_PROPS, objectKey: AUDIO_KEY.replace("daily", "other") }]) {
      expect((await serveCachedLifecycleAsset(setup.request(), setup.env, props)).status).toBe(503);
    }
    expect((await serveCachedLifecycleAsset(new Request("https://cache.invalid/system/service.toml"), setup.env, { showGeneration: 0 })).status).toBe(404);
    expect(setup.calls).toEqual([]);
    for (const [path, props, tag] of [["/podcasts/daily/feed.xml", { showGeneration: 0, feedGeneration: 1 }, "feed-daily"],
      ["/podcasts/daily/cover.png", { showGeneration: 0, coverGeneration: 1, objectKey: COVER_KEY }, "cover-daily"]] as const) {
      const other = fixture(path);
      const response = await serveCachedLifecycleAsset(other.request(), other.env, props);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Tag")).toContain(tag);
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    }
  });

});
