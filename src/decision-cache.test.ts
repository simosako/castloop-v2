import { expect, test } from "bun:test";
import { cachedDeliveryDecisions, DELIVERY_DECISION_MAX_AGE_SECONDS, purgeDeliveryDecisions,
  readCachedDeliveryDecision, readCachedSiteDeliveryDecision, serveCachedDeliveryDecision } from "./decision-cache";
import type { SqliteDeliveryDecision } from "./sqlite-publication-content";
import type { SiteDeliveryDecision } from "./site-gateway";

const feed = "/podcasts/daily/feed.xml";
const cover = "/podcasts/daily/cover.jpg";
const audio = `/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`;
const siteId = "a1b2c3d4e5f60718";
const feedDecision: SqliteDeliveryDecision = { status: 200, key: `public${feed}`,
  content_type: "application/rss+xml; charset=utf-8", cache_props: { showGeneration: 2, feedGeneration: 5 } };

test("allowed decisions are cacheable with the same tags as their body caches while stops stay uncached", async () => {
  const assetDecision: SqliteDeliveryDecision = { status: 200, key: `public${feed}`,
    content_type: "application/rss+xml; charset=utf-8", cache_props: { showGeneration: 2, feedGeneration: 5 } };
  const siteDecision: SiteDeliveryDecision = { status: 200, props: { generation: 5, showGeneration: 2 } };
  const assetTags = new Map<string, string[]>([
    [feed, ["show-daily", "feed-daily"]],
    [cover, ["show-daily", "cover-daily"]],
    [audio, ["show-daily", "episode-daily/first"]],
  ]);
  const siteTags = new Map<string, string[]>([
    ["/podcasts/daily/", ["site-daily", "site-list-daily"]],
    [`/podcasts/daily/${siteId}/`, ["site-daily", `site-episode-daily/${siteId}`]],
  ]);
  const source = {
    delivery: async () => assetDecision,
    siteDelivery: async () => siteDecision,
  };
  for (const [path, tags] of assetTags) {
    const response = await serveCachedDeliveryDecision(new Request(`https://decisions.invalid${path}`), source);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(`public, max-age=${DELIVERY_DECISION_MAX_AGE_SECONDS}`);
    expect(response.headers.get("Cache-Tag")).toBe(tags.join(","));
    expect(JSON.parse(await response.text())).toEqual(assetDecision);
  }
  for (const [path, tags] of siteTags) {
    const response = await serveCachedDeliveryDecision(new Request(`https://decisions.invalid${path}`), source);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(`public, max-age=${DELIVERY_DECISION_MAX_AGE_SECONDS}`);
    expect(response.headers.get("Cache-Tag")).toBe(tags.join(","));
    expect(JSON.parse(await response.text())).toEqual(siteDecision);
  }
  for (const status of [404, 410, 503] as const) {
    const stopping = await serveCachedDeliveryDecision(new Request(`https://decisions.invalid${feed}`),
      { delivery: async () => ({ status }), siteDelivery: async () => ({ status }) });
    expect(stopping.status).toBe(status);
    expect(stopping.headers.get("Cache-Control")).toBe("no-store");
    expect(stopping.headers.has("Cache-Tag")).toBe(false);
  }
});

test("unknown paths and non-GET methods never reach the decision source or the cache", async () => {
  const source = {
    delivery: async () => { throw new Error("Unexpected asset decision"); },
    siteDelivery: async () => { throw new Error("Unexpected site decision"); },
  };
  for (const path of ["/", "/system/service.toml", "/podcasts/daily/unknown.xml", "/podcasts/daily/page/0/"]) {
    const response = await serveCachedDeliveryDecision(new Request(`https://decisions.invalid${path}`), source);
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  }
  const method = await serveCachedDeliveryDecision(new Request(`https://decisions.invalid${feed}`, { method: "POST" }), source);
  expect(method.status).toBe(405);
  expect(method.headers.get("Cache-Control")).toBe("no-store");
});

test("readers restore decisions from cache responses and reject anything malformed", async () => {
  const cacheable = await serveCachedDeliveryDecision(new Request(`https://decisions.invalid${feed}`),
    { delivery: async () => feedDecision, siteDelivery: async () => { throw new Error("Unexpected site decision"); } });
  expect(await readCachedDeliveryDecision(cacheable)).toEqual(feedDecision);
  for (const status of [404, 410, 503] as const) {
    const response = new Response(JSON.stringify({ status }), { status });
    expect(await readCachedDeliveryDecision(response)).toEqual({ status });
    expect(await readCachedSiteDeliveryDecision(response)).toEqual({ status });
  }
  const siteProps = { generation: 5, showGeneration: 2, episodeGeneration: 3 };
  const sitePage = await readCachedSiteDeliveryDecision(new Response(JSON.stringify({ status: 200, props: siteProps })));
  expect(sitePage).toEqual({ status: 200, props: siteProps });
  for (const body of ["not json", "{}", "[]", JSON.stringify({ status: 200 }), JSON.stringify({ status: 200, key: "", content_type: "text/plain", cache_props: {} }),
    JSON.stringify({ status: 200, key: "public/x", content_type: "text/plain", cache_props: "props" })]) {
    const response = new Response(body, { status: 200 });
    expect(readCachedDeliveryDecision(response)).rejects.toThrow("differs");
  }
  for (const body of ["not json", JSON.stringify({ status: 200 }), JSON.stringify({ status: 200, props: { generation: "5", showGeneration: 2 } }),
    JSON.stringify({ status: 200, props: { generation: 5 } })]) {
    const response = new Response(body, { status: 200 });
    expect(readCachedSiteDeliveryDecision(response)).rejects.toThrow("differs");
  }
  for (const status of [204, 500, 302]) {
    expect(readCachedDeliveryDecision(new Response(null, { status }))).rejects.toThrow("status differs");
    expect(readCachedSiteDeliveryDecision(new Response(null, { status }))).rejects.toThrow("status differs");
  }
});

test("the gateway reader addresses the decision entrypoint with canonical paths only", async () => {
  const requested: string[] = [];
  const siteDecision: SiteDeliveryDecision = { status: 200, props: { generation: 5, showGeneration: 2 } };
  const fetcher = {
    fetch: async (request: Request) => {
      requested.push(`${request.method} ${request.url}`);
      return Response.json(request.url.endsWith("page/2/") ? siteDecision : feedDecision);
    },
  };
  const decisions = cachedDeliveryDecisions(fetcher);
  expect(await decisions.asset("/podcasts/daily/feed.xml")).toEqual(feedDecision);
  expect(await decisions.site({ kind: "listing", showId: "daily", page: 2 })).toEqual(siteDecision);
  expect(requested).toEqual([
    "GET https://castloop-decisions.invalid/podcasts/daily/feed.xml",
    "GET https://castloop-decisions.invalid/podcasts/daily/page/2/",
  ]);
});

test("decision purges cover the body-cache tag families plus site tags and reject unknown inputs", async () => {
  const targets: CachePurgeOptions[] = [];
  const cache = { purge: async (options: CachePurgeOptions) => { targets.push(options); return { success: true, errors: [] }; } };
  await purgeDeliveryDecisions(cache, { showId: "daily" });
  await purgeDeliveryDecisions(cache, { showId: "daily", episodeId: "first" });
  await purgeDeliveryDecisions(cache, { showId: "daily", siteId });
  expect(targets).toEqual([
    { tags: ["show-daily", "feed-daily", "cover-daily", "site-daily"], pathPrefixes: ["/podcasts/daily/"] },
    { tags: ["feed-daily", "episode-daily/first"], pathPrefixes: ["/podcasts/daily/episodes/first/"] },
    { tags: ["site-list-daily", `site-episode-daily/${siteId}`] },
  ]);
  expect(purgeDeliveryDecisions(cache, { showId: "../escape" })).rejects.toThrow("Invalid");
  expect(purgeDeliveryDecisions(cache, { showId: "daily", siteId: "not-a-site-id" })).rejects.toThrow("site ID");
  expect(purgeDeliveryDecisions(undefined, { showId: "daily" })).rejects.toThrow("unavailable");
});
