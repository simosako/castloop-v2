import { afterEach, expect, test } from "bun:test";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { SqliteDeliveryStats } from "./sqlite-delivery-stats";
import { createSqliteStatsHttp } from "./sqlite-stats-http";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { sqliteHealthSchema } from "../packages/shared/src/sqlite-service-api";
import type { SqliteHealth } from "../packages/shared/src/sqlite-service-api";
import { sqliteStatsEpisodesResponseSchema, sqliteStatsEpisodeDailyResponseSchema } from "../packages/shared/src/sqlite-stats";
import type { SqliteDeliveryObservation } from "../packages/shared/src/sqlite-stats";

const fixtures: Array<ReturnType<typeof sqlitePublicationFixture>> = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });

function httpFixture() {
  const value = sqlitePublicationFixture({ resume: false });
  fixtures.push(value);
  new SqlitePublicationContent(value.storage);
  const audioRevision = crypto.randomUUID();
  value.storage.sql.exec("INSERT INTO publication_shows (show_id, reservation_id, state_version, feed_generation, lifecycle) VALUES ('daily', ?, 0, 0, 'published')", crypto.randomUUID());
  value.storage.sql.exec("INSERT INTO publication_episodes (show_id, episode_id, lifecycle, lifecycle_version, revision_id) VALUES ('daily', 'first', 'published', 0, ?)", crypto.randomUUID());
  value.storage.sql.exec("INSERT INTO publication_media (show_id, episode_id, audio_revision_id, sha256, length_bytes) VALUES ('daily', 'first', ?, ?, 6000000)", audioRevision, "b".repeat(64));
  const stats = new SqliteDeliveryStats(value.storage, "daily", value.runtime, () => Date.UTC(2026, 9, 20, 12));
  const health = (): SqliteHealth => sqliteHealthSchema.parse({ ...value.runtime, protocol: "sqlite-sequential-v1",
    feed_storage: "immutable-generation-v1", cover_storage: "immutable-generation-v1",
    publication_read_boundary: "show-episode-v1", feed_generation_allocator: "reservation-v1",
    domain_changes: "sqlite-domain-change-v1", availability_controls: "show-admission-delivery-v1",
    revision_history: "sqlite-revisions-v1", delivery_statistics: "episode-daily-v1", website: "static-show-v1",
    invocation_id: crypto.randomUUID(), publication_ready: true, state: "open", admission_window_id: null,
    availability_version: 0, admission_state: "open", delivery_policy: "enabled", queued: 0, active: null,
    drained: true, setup: null, runtime_update: null, scope: "show", show_id: "daily", maintenance_operation_id: null });
  const handler = createSqliteStatsHttp(stats, "admin-key", "daily", health);
  const request = (path: string, init: RequestInit = {}) => new Request(`https://worker.example.workers.dev/admin/sqlite-stats/${path}`, {
    ...init, headers: { "X-Castloop-Key": "admin-key", "X-Castloop-Show-Id": "daily", ...(init.headers ?? {}) } });
  return { value, stats, handler, request, audioRevision };
}

test("statistics endpoints require authentication, return bounded pages and reject unknown routes", async () => {
  const { handler, request, audioRevision } = httpFixture();
  const anonymous = await handler(new Request("https://worker.example.workers.dev/admin/sqlite-stats/episodes"));
  expect(anonymous.status).toBe(401);
  stats: {
    const response = await handler(request("episodes?from=2026-08-01&to=2026-08-30"));
    expect(response.status).toBe(200);
    const parsed = sqliteStatsEpisodesResponseSchema.parse(await response.json());
    expect(parsed.show_id).toBe("daily");
    expect(parsed.retention_days).toBe(400);
    expect(parsed.collection_mode).toBe("best_effort_non_blocking");
    expect(parsed.episodes).toHaveLength(1);
    expect(parsed.episodes[0]!.coverage).toBe("unmeasured");
    expect(parsed.episodes[0]!.period).toBeNull();  // the whole window precedes measurement
  }
  const daily = await handler(request(`episodes/first?from=2026-10-19&to=2026-10-20`));
  expect(daily.status).toBe(200);
  const dailyParsed = sqliteStatsEpisodeDailyResponseSchema.parse(await daily.json());
  expect(dailyParsed.episode_id).toBe("first");
  expect(dailyParsed.days.map((day) => day.coverage)).toEqual(["unmeasured", "partial"]);
  expect((await handler(request("episodes/first?from=bad"))).status).toBe(400);
  expect((await handler(request("episodes/unknown-episode"))).status).toBe(404);
  expect((await handler(request("retention/not-a-uuid"))).status).toBe(404);
  expect((await handler(request("episodes", { method: "POST" }))).status).toBe(405);
  return void audioRevision;
});

test("retention changes apply once, replay identically, conflict on divergence and answer lookups", async () => {
  const { handler, request, value } = httpFixture();
  const operationId = crypto.randomUUID();
  const body = { ...value.runtime, show_id: "daily", operation_id: operationId, retention_days: 90 };
  const applied = await handler(request("retention", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
  expect(applied.status).toBe(200);
  const appliedJson = await applied.json() as { retention: { retention_days: number; applied_at_ms: number } };
  expect(appliedJson.retention.retention_days).toBe(90);
  const replay = await handler(request("retention", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }));
  expect(replay.status).toBe(200);
  expect((await replay.json() as { retention: { applied_at_ms: number } }).retention.applied_at_ms)
    .toBe(appliedJson.retention.applied_at_ms);
  const divergent = await handler(request("retention", { method: "POST",
    body: JSON.stringify({ ...body, retention_days: 120 }), headers: { "Content-Type": "application/json" } }));
  expect(divergent.status).toBe(409);
  const invalid = await handler(request("retention", { method: "POST",
    body: JSON.stringify({ ...body, operation_id: crypto.randomUUID(), retention_days: 10 }), headers: { "Content-Type": "application/json" } }));
  expect(invalid.status).toBe(409);
  const status = await handler(request(`retention/${operationId}`));
  expect(status.status).toBe(200);
  expect(((await status.json()) as { retention: { retention_days: number } }).retention.retention_days).toBe(90);
  const missing = await handler(request(`retention/${crypto.randomUUID()}`));
  expect(missing.status).toBe(404);
  const notJson = await handler(request("retention", { method: "POST", body: "plain", headers: { "Content-Type": "text/plain" } }));
  expect(notJson.status).toBe(400);
});

test("recording through the Show statistics store answers later page queries", async () => {
  const { stats, audioRevision } = httpFixture();
  const approved: SqliteDeliveryObservation = { episode_id: "first", audio_revision_id: audioRevision, method: "GET",
    status: 200, content_length: 6000000, range_offset: null, bot: false };
  const unknown: SqliteDeliveryObservation = { episode_id: "first", audio_revision_id: crypto.randomUUID(), method: "GET",
    status: 200, content_length: 6000000, range_offset: null, bot: false };
  // Unknown media is ignored: the delivery gate would not have approved it.
  stats.record([approved, unknown]);
  const page = stats.episodePage({ from_date_utc: "2026-10-20", to_date_utc: "2026-10-20" });
  expect(page.episodes[0]!.period).toMatchObject({ initial_downloads: 1, response_bytes: 6000000 });
});
