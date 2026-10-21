import { expect, test } from "bun:test";
import { serveSqliteGateway } from "./sqlite-gateway";
import type { SqliteDeliveryDecision } from "./sqlite-publication-content";

const management = "https://worker.example.workers.dev";
const feed = "/podcasts/daily/feed.xml";
const allowed = (generation: number): SqliteDeliveryDecision => ({ status: 200, key: `public${feed}`,
  content_type: "application/rss+xml; charset=utf-8", cache_props: { showGeneration: 1, feedGeneration: generation } });

test("cover warm hits, purge misses and late fills cannot cross committed generations or bypass stopping gates", async () => {
  const path = "/podcasts/daily/cover.jpg";
  let decision: SqliteDeliveryDecision = { status: 200, key: `public${path}`, content_type: "image/jpeg",
    cache_props: { showGeneration: 1, coverGeneration: 1 } };
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
  decision = { status: 200, key: `public${path}`, content_type: "image/jpeg", cache_props: { showGeneration: 2, coverGeneration: 3 } };
  cache.set(1, "late-old-cover-fill"); expect(await (await read()).text()).toBe("cover-3");
  decision = { status: 503 }; const stopped = await read(); expect(stopped.status).toBe(503);
  expect(stopped.headers.get("Cache-Control")).toBe("no-store"); expect(reads).toBe(4);
});

test("gateway rechecks current DO visibility even on cache hits and partitions late fills by committed feed generation", async () => {
  let decision = allowed(1), reads = 0, cacheReads = 0;
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
