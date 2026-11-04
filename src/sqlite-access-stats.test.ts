import { afterEach, expect, test } from "bun:test";
import { sqliteAccessStatsDailyResponseSchema, sqliteAccessStatsReplaceResponseSchema } from "../packages/shared/src/sqlite-access-stats";
import { SqliteAccessStats, SqliteAccessStatsConflict } from "./sqlite-access-stats";
import { saveAccessStatsDomain, sqliteAccessStatsFixture } from "./test-support/sqlite-access-stats";

const fixtures: Array<ReturnType<typeof sqliteAccessStatsFixture>> = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
function setup() { const fixture = sqliteAccessStatsFixture(); fixtures.push(fixture); return fixture; }

test("daily replacement is idempotent and late-input recomputation replaces rather than adds", async () => {
  const f = setup(), request = f.update();
  const first = await f.stats.replace(request);
  expect(sqliteAccessStatsReplaceResponseSchema.parse(first)).toEqual(first);
  expect([first.result, first.source.version, first.record.version]).toEqual(["changed", 1, 1]);
  const replay = await f.stats.replace(request);
  expect([replay.result, replay.record.version]).toEqual(["unchanged", 1]);
  const changed = await f.stats.replace(f.update("2026-11-03", 3, { expected_version: 1 }));
  expect(changed.record.daily.counters.get_200_requests).toBe(3);
  expect(changed.record.version).toBe(2);
  await expect(f.stats.replace(f.update("2026-11-03", 2, { expected_version: 1 }))).rejects.toBeInstanceOf(SqliteAccessStatsConflict);
  const daily = f.stats.daily(f.query());
  expect(daily.period?.get_200_requests).toBe(3);
  expect(sqliteAccessStatsDailyResponseSchema.parse(daily)).toEqual(daily);
});

test("a source update and daily replacement share their version checks and transaction", async () => {
  const f = setup();
  await f.stats.replace(f.update());
  const source = { ...f.source, interruptions: [{ started_at_ms: Date.parse("2026-11-03T10:00:00Z"),
    ended_at_ms: Date.parse("2026-11-03T11:00:00Z"), reason_code: "delivery_error" as const }] };
  await expect(f.stats.replace(f.update("2026-11-03", 2, { source, expected_source_version: 1, expected_version: 0 })))
    .rejects.toBeInstanceOf(SqliteAccessStatsConflict);
  expect(f.stats.sources(f.identity).sources[0]!.source.interruptions).toEqual([]);
  const changed = await f.stats.replace(f.update("2026-11-03", 2, { source, expected_source_version: 1, expected_version: 1 }));
  expect(changed.source.version).toBe(2);
  await expect(f.stats.replace(f.update("2026-11-03", 3, { expected_version: 2, expected_source_version: 1 })))
    .rejects.toBeInstanceOf(SqliteAccessStatsConflict);
  expect(f.stats.daily(f.query()).coverage).toBe("partial");
  expect(f.stats.daily(f.query()).period?.get_200_requests).toBe(2);
});

test("refreshing identical inputs advances read freshness without changing the counter version", async () => {
  const f = setup();
  f.setNow(Date.parse("2026-11-03T12:00:00Z"));
  const request = f.update("2026-11-03", 0);
  await f.stats.replace(request);
  expect(f.stats.daily(f.query()).coverage).toBe("partial");
  f.setNow(Date.parse("2026-11-04T12:00:00Z"));
  const refreshed = await f.stats.replace(f.update("2026-11-03", 0));
  expect(refreshed.result).toBe("unchanged");
  expect(refreshed.record.version).toBe(1);
  expect(f.stats.daily(f.query()).coverage).toBe("observed");
  await f.stats.replace(request);
  expect(f.stats.daily(f.query()).days[0]!.record?.read_at_ms).toBe(refreshed.record.read_at_ms);
});

test("observation zero, missing days, partial collection and expired details remain distinct", async () => {
  const f = setup();
  await f.stats.replace(f.update("2026-11-01", 0));
  await f.stats.replace(f.update("2026-11-03", 2));
  const result = f.stats.daily(f.query("2026-11-01", "2026-11-04"));
  expect(result.days.map((day) => [day.coverage, day.record?.daily.counters.get_200_requests ?? null]))
    .toEqual([["observed", 0], ["unmeasured", null], ["observed", 2], ["unmeasured", null]]);
  expect(result.coverage).toBe("partial");
  expect(result.period?.get_200_requests).toBe(2);
  const absent = f.stats.daily(f.query("2026-10-01"));
  expect(absent.period).toBeNull();
  expect(absent.coverage).toBe("unmeasured");
  const expired = f.stats.daily(f.query("2025-01-01"));
  expect(expired.days[0]!.coverage).toBe("pruned");
  expect(expired.period).toBeNull();
});

test("retention excludes old days from totals and prunes at most a bounded batch during updates", async () => {
  const f = setup();
  await f.stats.replace(f.update("2026-11-03", 2));
  f.setNow(Date.parse("2027-12-08T12:00:00Z"));
  const before = f.stats.daily(f.query());
  expect(before.days[0]!.coverage).toBe("pruned");
  expect(before.period).toBeNull();
  await expect(f.stats.replace(f.update("2026-11-03"))).rejects.toBeInstanceOf(SqliteAccessStatsConflict);
  await f.stats.replace(f.update("2027-12-07"));
  expect(f.storage.sql.exec("SELECT date_utc FROM publication_access_daily_stats ORDER BY date_utc").toArray())
    .toEqual([{ date_utc: "2027-12-07" }]);
  expect(f.stats.sources(f.identity).sources).toHaveLength(1);
});

test("approved old revisions and unpublished resources remain available and other Shows are rejected", async () => {
  const f = setup(), older = crypto.randomUUID();
  f.storage.sql.exec("INSERT INTO publication_media (show_id, episode_id, audio_revision_id, sha256, length_bytes) VALUES ('daily', 'first', ?, ?, 100)", older, "c".repeat(64));
  f.storage.sql.exec("UPDATE publication_episodes SET lifecycle = 'unpublished' WHERE show_id = 'daily'");
  const resources = f.stats.resources(f.identity).resources;
  expect(resources.map((resource) => resource.resource_path)).toContain(`/podcasts/daily/episodes/first/${older}.mp3`);
  expect(resources.map((resource) => resource.resource_path)).toContain("/podcasts/daily/cover.jpg");
  await f.stats.replace(f.update());
  await expect(f.stats.replace({ ...f.update(), service_config_sha256: "f".repeat(64) })).rejects.toBeInstanceOf(SqliteAccessStatsConflict);
  const another = f.update("2026-11-03", 1, { show_id: "weekly", daily: { ...f.update().daily,
    resource_path: `/podcasts/weekly/episodes/first/${f.revisionId}.mp3`, show_id: "weekly" } });
  await expect(f.stats.replace(another)).rejects.toBeInstanceOf(SqliteAccessStatsConflict);
});

test("saved domain history admits old-host logs after the current public host changes", async () => {
  const f = setup(), hostname = "old-media.example.com";
  await saveAccessStatsDomain(f, hostname);
  const source = { ...f.source, host: hostname, source_id: `http_logpush:${f.source.zone_id}:${hostname}` };
  const request = f.update();
  const result = await f.stats.replace({ ...request, source, daily: { ...request.daily, source_id: source.source_id } });
  expect(result.source.source.host).toBe(hostname);
  const other = { ...source, host: "unknown.example.com", source_id: `http_logpush:${f.source.zone_id}:unknown.example.com` };
  await expect(f.stats.replace({ ...request, source: other, daily: { ...request.daily, source_id: other.source_id } }))
    .rejects.toBeInstanceOf(SqliteAccessStatsConflict);
});

test("pagination binds resource, source, interval, Show and current configuration", async () => {
  const f = setup();
  await f.stats.replace(f.update());
  const query = f.query("2026-09-01", "2026-11-03"), first = f.stats.daily(query);
  expect(first.days).toHaveLength(31);
  expect(first.next_cursor).not.toBeNull();
  const second = f.stats.daily({ ...query, cursor: first.next_cursor! });
  expect(second.days[0]!.date_utc).toBe("2026-10-02");
  expect(second.period).toEqual(first.period);
  expect(() => f.stats.daily({ ...query, to_date_utc: "2026-11-02", cursor: first.next_cursor! })).toThrow(SqliteAccessStatsConflict);
  expect(() => f.stats.resources({ ...f.identity, cursor: first.next_cursor! })).toThrow(SqliteAccessStatsConflict);
  for (let index = 0; index < 25; index++) f.storage.sql.exec(
    "INSERT INTO publication_media (show_id, episode_id, audio_revision_id, sha256, length_bytes) VALUES ('daily', 'first', ?, ?, 100)", crypto.randomUUID(), "a".repeat(64));
  const page = f.stats.resources(f.identity);
  expect(page.resources).toHaveLength(20);
  const rest = f.stats.resources({ ...f.identity, cursor: page.next_cursor! });
  expect(rest.resources).toHaveLength(7);
  expect(new Set([...page.resources, ...rest.resources].map((resource) => resource.resource_path)).size).toBe(27);
});

test("a lost durability acknowledgement can be replayed without adding counts", async () => {
  const f = setup(), request = f.update();
  f.failSync();
  await expect(f.stats.replace(request)).rejects.toThrow("durability confirmation");
  const replay = await f.stats.replace(request);
  expect(replay.result).toBe("unchanged");
  expect(replay.record.daily.counters.get_200_requests).toBe(1);
  expect(replay.record.version).toBe(1);
  f.storage.sql.exec("UPDATE publication_access_stats_schema SET version = 2 WHERE id = 1");
  expect(() => new SqliteAccessStats(f.storage, "daily", f.queue, f.config)).toThrow("Unsupported access statistics schema");
  expect(f.storage.sql.exec("SELECT version FROM publication_access_daily_stats").toArray()).toEqual([{ version: 1 }]);
});
