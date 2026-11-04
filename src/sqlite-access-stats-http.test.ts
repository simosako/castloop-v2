import { afterEach, expect, spyOn, test } from "bun:test";
import { MAX_SQLITE_ACCESS_STATS_REQUEST_BYTES, MAX_SQLITE_ACCESS_STATS_RESPONSE_BYTES, sqliteAccessStatsDailyResponseSchema,
  sqliteAccessStatsReplaceResponseSchema, sqliteAccessStatsResourcesResponseSchema,
  sqliteAccessStatsSourcesResponseSchema } from "../packages/shared/src/sqlite-access-stats";
import { createSqliteAccessStatsHttp } from "./sqlite-access-stats-http";
import { saveAccessStatsDomain, sqliteAccessStatsFixture } from "./test-support/sqlite-access-stats";
import { SqliteShowService } from "./sqlite-show-service";
import { serveSqliteGateway } from "./sqlite-gateway";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { sqliteServiceFixture } from "../packages/cli/src/test-support/sqlite-service";

const fixtures: Array<ReturnType<typeof sqliteAccessStatsFixture>> = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function setup() {
  const fixture = sqliteAccessStatsFixture(); fixtures.push(fixture);
  let ready = true;
  const handler = createSqliteAccessStatsHttp(fixture.stats, "admin-key", () => ready);
  const get = (path: string, query: Record<string, string> = {}) => {
    const url = new URL(`/admin/sqlite-access-stats/${path}`, fixture.config.workers_dev_base_url);
    for (const [key, value] of Object.entries({ service_id: fixture.identity.service_id,
      service_config_sha256: fixture.identity.service_config_sha256, ...query })) url.searchParams.set(key, value);
    return new Request(url, { headers: { "X-Castloop-Key": "admin-key", "X-Castloop-Show-Id": "daily" } });
  };
  const post = (body: unknown) => new Request(new URL("/admin/sqlite-access-stats/daily", fixture.config.workers_dev_base_url),
    { method: "POST", headers: { "X-Castloop-Key": "admin-key", "X-Castloop-Show-Id": "daily", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const dailyQuery = { source_id: fixture.source.source_id, resource_path: fixture.resourcePath, from: "2026-11-03", to: "2026-11-03" };
  return { ...fixture, handler, get, post, dailyQuery, stop: () => { ready = false; } };
}

test("access statistics authenticate before reading bodies and return no-store responses", async () => {
  const f = setup();
  let read = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { read = true; controller.close(); } }, { highWaterMark: 0 });
  const denied = await f.handler(new Request(new URL("/admin/sqlite-access-stats/daily", f.config.workers_dev_base_url), { method: "POST", body }));
  expect(denied.status).toBe(401);
  expect(read).toBe(false);
  expect(denied.headers.get("Cache-Control")).toBe("no-store");
  const sources = await f.handler(f.get("sources"));
  expect(sources.headers.get("Cache-Control")).toBe("no-store");
  expect(sqliteAccessStatsSourcesResponseSchema.parse(await sources.json()).sources).toEqual([]);
  const resources = sqliteAccessStatsResourcesResponseSchema.parse(await (await f.handler(f.get("resources"))).json());
  expect(resources.resources).toHaveLength(2);
});

test("HTTP daily imports replace, replay and expose source versions and read bounds", async () => {
  const f = setup(), request = f.update();
  const first = await f.handler(f.post(request));
  expect(first.status).toBe(200);
  const result = sqliteAccessStatsReplaceResponseSchema.parse(await first.json());
  expect(result.source.source.collection_mode).toBe("best_effort");
  expect(result.record.input_min_at_ms).toBe(request.input_min_at_ms);
  const replay = sqliteAccessStatsReplaceResponseSchema.parse(await (await f.handler(f.post(request))).json());
  expect(replay.result).toBe("unchanged");
  expect((await f.handler(f.post(f.update("2026-11-03", 2)))).status).toBe(409);
  const daily = sqliteAccessStatsDailyResponseSchema.parse(await (await f.handler(f.get("daily", f.dailyQuery))).json());
  expect(daily.period?.get_200_requests).toBe(1);
  expect(daily.days[0]!.coverage).toBe("observed");
  expect(daily.days[0]!.record?.version).toBe(1);
});

test("HTTP input, configuration, scope and readiness failures retain their distinct status codes", async () => {
  const f = setup();
  for (const body of [{ ...f.update(), extra: "private-input" }, { ...f.update(), source: { ...f.source, api_token: "secret" } }]) {
    expect((await f.handler(f.post(body))).status).toBe(400);
  }
  const wrongContent = f.post(f.update()); wrongContent.headers.set("Content-Encoding", "gzip");
  expect((await f.handler(wrongContent)).status).toBe(400);
  const oversized = new Request(f.post(f.update()).url, { method: "POST", headers: f.post(f.update()).headers,
    body: " ".repeat(MAX_SQLITE_ACCESS_STATS_REQUEST_BYTES + 1) });
  expect((await f.handler(oversized)).status).toBe(400);
  expect((await f.handler(f.get("daily", { ...f.dailyQuery, from: "bad" }))).status).toBe(400);
  expect((await f.handler(f.get("sources", { service_config_sha256: "f".repeat(64) }))).status).toBe(409);
  const wrongShow = f.get("sources"); wrongShow.headers.set("X-Castloop-Show-Id", "weekly");
  expect((await f.handler(wrongShow)).status).toBe(409);
  expect((await f.handler(f.get("sources", { unknown: "value" }))).status).toBe(400);
  const repeated = new URL(f.get("sources").url); repeated.searchParams.append("service_id", f.identity.service_id);
  expect((await f.handler(new Request(repeated, f.get("sources")))).status).toBe(400);
  expect((await f.handler(f.get("unknown"))).status).toBe(404);
  expect((await f.handler(new Request(f.get("sources"), { method: "DELETE" }))).status).toBe(405);
  f.stop();
  expect((await f.handler(f.post(f.update()))).status).toBe(503);
  expect(f.stats.sources(f.identity).sources).toEqual([]);
});

test("daily and source pagination stays within 16 KiB with a year of collection-state metadata", async () => {
  const f = setup();
  const source = { ...f.source, interruptions: Array.from({ length: 80 }, (_, index) => ({
    started_at_ms: f.source.collection_started_at_ms + index * 2000,
    ended_at_ms: f.source.collection_started_at_ms + index * 2000 + 1000, reason_code: "delivery_error" as const,
  })) };
  for (let day = 25; day <= 31; day++) expect((await f.handler(f.post(f.update(`2026-10-${day}`, 1, { source })))).status).toBe(200);
  for (let day = 1; day <= 3; day++) expect((await f.handler(f.post(f.update(`2026-11-0${day}`, 1, { source })))).status).toBe(200);
  const dates: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const response = await f.handler(f.get("daily", { ...f.dailyQuery, from: "2026-10-25", ...(cursor ? { cursor } : {}) }));
    const text = await response.text();
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_SQLITE_ACCESS_STATS_RESPONSE_BYTES);
    const page = sqliteAccessStatsDailyResponseSchema.parse(JSON.parse(text));
    expect(page.period?.get_200_requests).toBe(10);
    dates.push(...page.days.map((day) => day.date_utc));
    cursor = page.next_cursor; pages++;
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(new Set(dates).size).toBe(10);
  await saveAccessStatsDomain(f, "old-media.example.com");
  const oldSource = { ...source, host: "old-media.example.com", source_id: `http_logpush:${source.zone_id}:old-media.example.com` };
  const request = f.update();
  expect((await f.handler(f.post({ ...request, source: oldSource, daily: { ...request.daily, source_id: oldSource.source_id } }))).status).toBe(200);
  const first = sqliteAccessStatsSourcesResponseSchema.parse(await (await f.handler(f.get("sources"))).json());
  expect(first.sources).toHaveLength(1);
  expect(first.next_cursor).not.toBeNull();
  const second = await f.handler(f.get("sources", { cursor: first.next_cursor! }));
  const text = await second.text();
  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_SQLITE_ACCESS_STATS_RESPONSE_BYTES);
  const last = sqliteAccessStatsSourcesResponseSchema.parse(JSON.parse(text));
  expect(new Set([...first.sources, ...last.sources].map((entry) => entry.source.source_id)).size).toBe(2);
  expect(last.next_cursor).toBeNull();
});

test("storage failures report an allowlisted error while a committed import remains replayable", async () => {
  const f = setup(), diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    f.failSync();
    const response = await f.handler(f.post(f.update()));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(JSON.stringify({ error: "access_stats_unavailable" }));
    expect(diagnostic).toHaveBeenCalledWith(JSON.stringify({ event: "sqlite_access_stats_http", reason_code: "access_stats_unavailable" }));
    const replay = sqliteAccessStatsReplaceResponseSchema.parse(await (await f.handler(f.post(f.update()))).json());
    expect(replay.result).toBe("unchanged");
  } finally { diagnostic.mockRestore(); }
});

test("Show routing exposes the new API only on the management origin and keeps stores separate", async () => {
  const f = setup(), weekly = sqlitePublicationFixture(), control = await sqliteServiceFixture();
  try {
    const service = new SqliteShowService(f.storage, "daily", f.runtime, f.config, { purge: async () => {} }, "admin-key");
    const reservation = f.storage.sql.exec<{ reservation_id: string }>("SELECT reservation_id FROM publication_shows WHERE show_id = 'daily'").toArray()[0]!.reservation_id;
    await service.initialize({ ...f.identity, operation_id: crypto.randomUUID(), reservation_id: reservation });
    const other = new SqliteShowService(weekly.storage, "weekly", weekly.runtime, f.config, { purge: async () => {} }, "admin-key");
    await other.initialize({ ...weekly.identity, show_id: "weekly", operation_id: crypto.randomUUID(), reservation_id: crypto.randomUUID() });
    const get = f.get("resources");
    expect((await service.fetch(get)).status).toBe(200);
    const privateOnly = await serveSqliteGateway(new Request(new URL("/admin/sqlite-access-stats/resources", f.config.public_base_url), get),
      f.config.workers_dev_base_url, { fetch: (request) => service.fetch(request), delivery: async () => ({ status: 404 }) },
      async () => new Response(null), f.config.public_base_url);
    expect(privateOnly.status).toBe(404);
    const now = Date.now(), date = new Date(now - 86_400_000).toISOString().slice(0, 10);
    expect((await service.fetch(f.post(f.update(date, 1, { read_at_ms: now })))).status).toBe(200);
    const otherRequest = f.get("sources"); otherRequest.headers.set("X-Castloop-Show-Id", "weekly");
    const response = sqliteAccessStatsSourcesResponseSchema.parse(await (await other.fetch(otherRequest)).json());
    expect(response.sources).toEqual([]);
    const wrongTarget = f.post(f.update(date, 1, { read_at_ms: now })); wrongTarget.headers.set("X-Castloop-Show-Id", "weekly");
    expect((await other.fetch(wrongTarget)).status).toBe(409);
    expect(control.controlStorage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'publication_access_%'").toArray()).toEqual([]);
  } finally { weekly.close(); control.close(); }
});
