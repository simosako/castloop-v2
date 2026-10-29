import { expect, test } from "bun:test";
import { serveSqliteGateway } from "./sqlite-gateway";
import type { SqliteDeliveryDecision } from "./sqlite-publication-content";

const management = "https://worker.example.workers.dev";
const feed = "/podcasts/daily/feed.xml";
const allowed = (generation: number): Extract<SqliteDeliveryDecision, { status: 200 }> => ({ status: 200, key: `public${feed}`,
  content_type: "application/rss+xml; charset=utf-8", cache_props: { showGeneration: 1, feedGeneration: generation } });

test("cover warm hits, purge misses and late fills cannot cross committed generations or bypass stopping gates", async () => {
  const path = "/podcasts/daily/cover.jpg";
  let decision: SqliteDeliveryDecision = { status: 200, key: `public${path}`, content_type: "image/jpeg",
    cache_props: { showGeneration: 1, coverGeneration: 1, objectKey: `public${path}` } };
  const service = { fetch: async () => new Response(null), delivery: async () => decision };
  const cache = new Map<number, string>(); let reads = 0;
  const cached = async (_: Request, props: { coverGeneration?: number }) => {
    const generation = props.coverGeneration!; reads++;
    if (!cache.has(generation)) cache.set(generation, `cover-${generation}`);
    return new Response(cache.get(generation));
  };
  const read = () => serveSqliteGateway(new Request(`${management}${path}`), management, service, cached);
  expect(await (await read()).text()).toBe("cover-1"); expect(await (await read()).text()).toBe("cover-1");
  cache.clear(); expect(await (await read()).text()).toBe("cover-1");
  decision = { status: 200, key: `public${path}`, content_type: "image/jpeg", cache_props: { showGeneration: 2, coverGeneration: 3, objectKey: `public${path}` } };
  cache.set(1, "late-old-cover-fill"); expect(await (await read()).text()).toBe("cover-3");
  decision = { status: 503 }; const stopped = await read(); expect(stopped.status).toBe(503);
  expect(stopped.headers.get("Cache-Control")).toBe("no-store"); expect(reads).toBe(4);
});

test("gateway rechecks current DO visibility even on cache hits and partitions late fills by committed feed generation", async () => {
  let decision: SqliteDeliveryDecision = allowed(1), reads = 0, cacheReads = 0;
  const cache = new Map<string, string>();
  const service = { fetch: async () => new Response(null), delivery: async () => { reads++; return decision; } };
  const cached = async (_: Request, props: { feedGeneration?: number }) => {
    cacheReads++; const key = String(props.feedGeneration);
    return new Response(cache.get(key) ?? `generation-${key}`, { headers: { "Cache-Tag": "feed-daily", "Cache-Control": "public, max-age=300" } });
  };
  const request = () => new Request(`${management}${feed}?tracking=ignored`);
  expect(await (await serveSqliteGateway(request(), management, service, cached)).text()).toBe("generation-1");
  cache.set("1", "late-old-fill"); decision = allowed(2);
  const current = await serveSqliteGateway(request(), management, service, cached);
  expect(await current.text()).toBe("generation-2");
  expect(current.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
  expect(current.headers.has("Cache-Tag")).toBe(false);
  for (const status of [404, 410, 503] as const) {
    decision = { status }; const response = await serveSqliteGateway(request(), management, service, cached);
    expect(response.status).toBe(status); expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  expect(reads).toBe(5); expect(cacheReads).toBe(2);
});

test("gateway forwards Range and conditional requests but never credentials or query data to the cache", async () => {
  const service = { fetch: async () => new Response(null), delivery: async () => allowed(1) };
  for (const status of [200, 206, 304, 412, 416]) {
    const request = new Request(`${management}${feed}?secret=not-forwarded`, { headers: { Authorization: "private-token", "X-Castloop-Key": "private-key",
      Cookie: "private-cookie", Range: "bytes=0-1", "If-Range": '"etag"', "If-None-Match": '"etag"' } });
    const response = await serveSqliteGateway(request, management, service, async (input) => {
      expect(new URL(input.url).search).toBe(""); expect(input.headers.has("Authorization")).toBe(false); expect(input.headers.has("X-Castloop-Key")).toBe(false);
      expect(input.headers.has("Cookie")).toBe(false);
      expect(input.headers.get("Range")).toBe("bytes=0-1"); expect(input.headers.get("If-None-Match")).toBe('"etag"');
      return new Response(status === 304 ? null : "data", { status, headers: { "Content-Range": "bytes 0-1/4" } });
    });
    expect(response.status).toBe(status);
  }
  const head = await serveSqliteGateway(new Request(`${management}${feed}`, { method: "HEAD" }), management, service,
    async (input) => { expect(input.method).toBe("HEAD"); return new Response("not-forwarded"); });
  expect(await head.text()).toBe("");
});

test("administration is workers.dev-only and invalid paths or methods never enter cached delivery", async () => {
  let requests = 0;
  const service = { fetch: async () => { requests++; return new Response("admin", { headers: { "Cache-Control": "no-store" } }); },
    delivery: async () => { throw new Error("Unexpected visibility read"); } };
  const cached = async () => { throw new Error("Unexpected cache access"); };
  expect((await serveSqliteGateway(new Request(`${management}/admin/sqlite-service/health`), management, service, cached)).status).toBe(200);
  expect((await serveSqliteGateway(new Request("https://public.example/admin/sqlite-service/health"), management, service, cached)).status).toBe(404);
  expect((await serveSqliteGateway(new Request(`https://public.example${feed}`), management, service, cached)).status).toBe(404);
  for (const path of ["/system/service.toml", "/staging/uploads/private", "/podcasts/daily/not-approved", "/.well-known/castloop/runtime?nonce=" + crypto.randomUUID()]) {
    expect((await serveSqliteGateway(new Request(`${management}${path}`), management, service, cached)).status).toBe(404);
  }
  expect((await serveSqliteGateway(new Request(`${management}${feed}`, { method: "POST" }), management, service, cached)).status).toBe(405);
  expect(requests).toBe(1);
});

test("old public URLs redirect only after current delivery approval and never enter the body cache", async () => {
  const publicOrigin = "https://podcasts.example.com";
  for (const path of [feed, "/podcasts/daily/cover.jpg", "/podcasts/daily/cover.png",
    `/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`]) {
    for (const method of ["GET", "HEAD"]) {
      let decisions = 0;
      const service = { fetch: async () => { throw new Error("Unexpected administration"); },
        delivery: async (input: string) => { decisions++; expect(input).toBe(path); return { ...allowed(1), key: `public${path}`,
          cache_props: path === feed ? allowed(1).cache_props : { showGeneration: 1, objectKey: `public${path}` } }; } };
      const response = await serveSqliteGateway(new Request(`${management}${path}?private=not-forwarded`, { method,
        headers: { Authorization: "secret", Cookie: "private", "X-Castloop-Key": "key", Range: "bytes=0-1", "If-None-Match": '"old"' } }),
      management, service, async () => { throw new Error("Redirect cannot read cached bodies"); }, publicOrigin);
      expect(response.status).toBe(path === feed ? 301 : 307);
      expect(response.headers.get("Location")).toBe(`${publicOrigin}${path}`);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe(""); expect(decisions).toBe(1);
      for (const name of ["Authorization", "Cookie", "X-Castloop-Key", "Cache-Tag", "Content-Range"]) expect(response.headers.has(name)).toBe(false);
    }
  }
});

test("pause, nonpublic and blocked decisions prevent redirects including conditional HEAD requests", async () => {
  for (const status of [404, 410, 503] as const) {
    for (const method of ["GET", "HEAD"]) {
      const response = await serveSqliteGateway(new Request(`${management}${feed}`, { method,
        headers: { Range: "bytes=0-1", "If-None-Match": '"warm"' } }), management,
      { fetch: async () => { throw new Error("Unexpected administration"); }, delivery: async () => ({ status }) },
      async () => { throw new Error("Stopping gates must precede cache access"); }, "https://podcasts.example.com");
      expect(response.status).toBe(status); expect(response.headers.has("Location")).toBe(false);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  }
});

test("custom domain serves canonical bodies without loops and preserves conditional streaming headers", async () => {
  const publicOrigin = "https://podcasts.example.com";
  for (const status of [200, 206, 304, 412, 416]) {
    const response = await serveSqliteGateway(new Request(`${publicOrigin}${feed}?private=ignored`, {
      headers: { Authorization: "secret", Cookie: "private", "X-Castloop-Key": "key", Range: "bytes=0-1",
        "If-Range": '"revision"', "If-None-Match": '"revision"', "If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT" } }),
    management, { fetch: async () => new Response(null), delivery: async () => allowed(1) }, async (input) => {
      expect(input.url).toBe(`https://castloop-cache.invalid${feed}`);
      expect(input.headers.get("Range")).toBe("bytes=0-1"); expect(input.headers.get("If-Range")).toBe('"revision"');
      expect(input.headers.get("If-None-Match")).toBe('"revision"');
      expect(input.headers.get("If-Modified-Since")).toBe("Mon, 01 Jan 2024 00:00:00 GMT");
      for (const name of ["Authorization", "Cookie", "X-Castloop-Key"]) expect(input.headers.has(name)).toBe(false);
      return new Response(status === 304 ? null : "body", { status });
    }, publicOrigin);
    expect(response.status).toBe(status); expect(response.headers.has("Location")).toBe(false);
  }
});

test("custom domains never gain administration and unknown origins or internal paths never redirect", async () => {
  const publicOrigin = "https://podcasts.example.com"; let administrations = 0;
  const service = { fetch: async () => { administrations++; return new Response(null, { status: 204 }); },
    delivery: async () => { throw new Error("Unapproved input cannot reach delivery"); } };
  const cached = async () => { throw new Error("Unexpected cached fetch"); };
  for (const url of [`${publicOrigin}/admin/sqlite-service/health`, `https://unknown.example${feed}`,
    `${publicOrigin}/system/service.toml`, `${management}/staging/uploads/private`,
    `${management}/podcasts/daily/feeds/1.xml`, `${publicOrigin}/.well-known/castloop/runtime`]) {
    const response = await serveSqliteGateway(new Request(url, { headers: { "X-Forwarded-Host": new URL(management).hostname,
      Origin: management, "X-Castloop-Key": "secret" } }), management, service, cached, publicOrigin);
    expect(response.status).toBe(404); expect(response.headers.has("Location")).toBe(false);
  }
  const admin = await serveSqliteGateway(new Request(`${management}/admin/sqlite-service/health`), management, service, cached, publicOrigin);
  expect(admin.status).toBe(204); expect(admin.headers.has("Location")).toBe(false); expect(administrations).toBe(1);
  expect((await serveSqliteGateway(new Request(`${management}${feed}`, { method: "POST" }), management, service, cached, publicOrigin)).status).toBe(405);
});

test("removing the canonical custom origin restores workers.dev bodies and rejects the former origin", async () => {
  const service = { fetch: async () => new Response(null), delivery: async () => allowed(2) };
  const response = await serveSqliteGateway(new Request(`${management}${feed}`), management, service, async () => new Response("restored"));
  expect(response.status).toBe(200); expect(response.headers.has("Location")).toBe(false); expect(await response.text()).toBe("restored");
  expect((await serveSqliteGateway(new Request(`https://podcasts.example.com${feed}`), management, service,
    async () => { throw new Error("Former origin cannot reach cache"); })).status).toBe(404);
});

test("gateway observations cover audio responses once after finalization and skip failures, redirects and unclassifiable ranges", async () => {
  const audio = `/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`;
  const decision = (path: string): SqliteDeliveryDecision => ({ status: 200, key: `public${path}`, content_type: "audio/mpeg",
    cache_props: { showGeneration: 1, episodeGeneration: 0, objectKey: `public${path}` } });
  const observed: unknown[] = [];
  const sink = (entry: unknown) => { observed.push(entry); };
  const serve = async (method: "GET" | "HEAD", headers: Record<string, string>, respond: () => Response, path = audio) =>
    serveSqliteGateway(new Request(`https://podcasts.example.com${path}`, { method, headers }), "https://worker.example.workers.dev",
      { fetch: async () => new Response(null), delivery: async () => decision(path) }, async () => respond(), "https://podcasts.example.com", sink);
  const full = await serve("GET", {}, () => new Response("audio", { status: 200, headers: { "Content-Length": "1200000" } }));
  expect(full.status).toBe(200);
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({ episode_id: "first", method: "GET", status: 200, content_length: 1200000, range_offset: null, bot: false });
  await serve("GET", { Range: "bytes=0-65535", "User-Agent": "AppleCoreMedia/1.0" },
    () => new Response("data", { status: 206, headers: { "Content-Length": "65536", "Content-Range": "bytes 0-65535/1200000" } }));
  await serve("GET", { Range: "bytes=524288-", "User-Agent": "Twitterbot/1.0" },
    () => new Response("data", { status: 206, headers: { "Content-Length": "675512", "Content-Range": "bytes 524288-1199999/1200000" } }));
  await serve("HEAD", { "User-Agent": "castloop-verify/1.0" }, () => new Response(null, { status: 200, headers: { "Content-Length": "1200000" } }));
  await serve("GET", { "If-None-Match": '"etag"' }, () => new Response(null, { status: 304 }));
  await serve("GET", {}, () => new Response(null, { status: 416, headers: { "Content-Range": "bytes */1200000" } }));
  await serve("GET", {}, () => new Response("data", { status: 206, headers: { "Content-Length": "65536" } }));
  for (const path of ["/podcasts/daily/feed.xml", "/podcasts/daily/cover.jpg"]) {
    await serve("GET", {}, () => new Response("data", { status: 200 }), path);
  }
  const redirected = await serveSqliteGateway(new Request(`https://worker.example.workers.dev${audio}`), "https://worker.example.workers.dev",
    { fetch: async () => new Response(null), delivery: async () => decision(audio) }, async () => { throw new Error("Unexpected cache read"); },
    "https://podcasts.example.com", sink);
  expect(redirected.status).toBe(307);
  expect(observed).toHaveLength(5);
  expect(observed[1]).toMatchObject({ status: 206, range_offset: 0, content_length: 65536, bot: false });
  expect(observed[2]).toMatchObject({ status: 206, range_offset: 524288, bot: true });
  expect(observed[3]).toMatchObject({ method: "HEAD", status: 200, bot: true });
  expect(observed[4]).toMatchObject({ status: 304, content_length: 0 });
});

test("gateway observations are isolated from delivery failures and never change responses", async () => {
  const audio = `/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`;
  const decision: SqliteDeliveryDecision = { status: 200, key: `public${audio}`, content_type: "audio/mpeg",
    cache_props: { showGeneration: 1, episodeGeneration: 0, objectKey: `public${audio}` } };
  const exploding = (entry: unknown) => { throw new Error(`statistics sink failed for ${JSON.stringify(entry)}`); };
  const response = await serveSqliteGateway(new Request(`https://podcasts.example.com${audio}`), "https://worker.example.workers.dev",
    { fetch: async () => new Response(null), delivery: async () => decision },
    async () => new Response("audio", { status: 200, headers: { "Content-Length": "5" } }), "https://podcasts.example.com", exploding);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("audio");
});

test("a mismatched delivery key cannot authorize a redirect", async () => {
  const response = await serveSqliteGateway(new Request(`${management}${feed}`), management,
    { fetch: async () => new Response(null), delivery: async () => ({ ...allowed(1), key: "public/podcasts/other/feed.xml" }) },
    async () => { throw new Error("Unexpected cached fetch"); }, "https://podcasts.example.com");
  expect(response.status).toBe(503); expect(response.headers.has("Location")).toBe(false);
});

test("custom domain HEAD suppresses bodies and malformed canonical origins cannot redirect", async () => {
  const service = { fetch: async () => new Response(null), delivery: async () => allowed(1) };
  const publicOrigin = "https://podcasts.example.com";
  const head = await serveSqliteGateway(new Request(`${publicOrigin}${feed}`, { method: "HEAD" }), management, service,
    async (input) => { expect(input.method).toBe("HEAD"); return new Response("suppressed"); }, publicOrigin);
  expect(head.status).toBe(200); expect(await head.text()).toBe(""); expect(head.headers.has("Location")).toBe(false);
  for (const invalid of ["http://podcasts.example.com", `${publicOrigin}/`, `${publicOrigin}/path`, `${publicOrigin}?secret=x`,
    "https://user:secret@podcasts.example.com", "https://podcasts.example.com:8080", "not-an-origin"]) {
    const response = await serveSqliteGateway(new Request(`${management}${feed}`), management,
      { fetch: async () => { throw new Error("Unexpected management"); }, delivery: async () => { throw new Error("Unexpected delivery"); } },
      async () => { throw new Error("Unexpected cached fetch"); }, invalid);
    expect(response.status).toBe(503); expect(response.headers.has("Location")).toBe(false);
  }
});
