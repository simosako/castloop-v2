import { expect, test } from "bun:test";
import { ACCESS_STATS_FORMAT } from "./access-stats";
import { MAX_SQLITE_ACCESS_STATS_REQUEST_BYTES, sqliteAccessStatsDailyRequestSchema,
  sqliteAccessStatsReplaceRequestSchema, sqliteAccessStatsSourceSchema } from "./sqlite-access-stats";

const source = { source_id: `http_logpush:${"a".repeat(32)}:media.example.com`, collector: "http_logpush",
  zone_id: "a".repeat(32), host: "media.example.com", metric_definition: ACCESS_STATS_FORMAT,
  byte_measurement: "edge_body", collection_mode: "best_effort", collection_started_at_ms: Date.parse("2025-01-01T00:00:00Z"),
  collection_ended_at_ms: null, last_complete_at_ms: null, interruptions: [] };
const request = { service_id: "service", service_config_sha256: "a".repeat(64), show_id: "daily", source,
  expected_source_version: 0, expected_version: 0, input_sha256: "b".repeat(64), read_at_ms: Date.parse("2026-11-04T12:00:00Z"),
  input_min_at_ms: Date.parse("2026-11-03T12:00:00Z"), input_max_at_ms: Date.parse("2026-11-03T12:00:00Z"),
  daily: { format: ACCESS_STATS_FORMAT, source_id: source.source_id, show_id: "daily", date_utc: "2026-11-03",
    resource_path: "/podcasts/daily/episodes/first/11111111-1111-4111-8111-111111111111.mp3", resource_kind: "audio",
    episode_id: "first", audio_revision_id: "11111111-1111-4111-8111-111111111111",
    counters: { get_200_requests: 1, get_206_requests: 0, head_requests: 0, not_modified_requests: 0,
      response_bytes: 100, cache_status_requests: { hit: 1 } } } };

test("collection sources bind the source ID, metric definition and allowlisted interruption data", () => {
  expect(sqliteAccessStatsSourceSchema.safeParse(source).success).toBe(true);
  for (const change of [{ host: "another.example.com" }, { zone_id: "b".repeat(32) },
    { host: "worker.example.workers.dev" }, { metric_definition: "episode-daily-v1" }, { byte_measurement: "content_length" },
    { user_agent: "private-agent" }, { collection_ended_at_ms: source.collection_started_at_ms - 1 },
    { interruptions: [{ started_at_ms: 0, ended_at_ms: 1, reason_code: "delivery_error" }] },
    { interruptions: [{ started_at_ms: source.collection_started_at_ms, ended_at_ms: null, reason_code: "private exception" }] }]) {
    expect(sqliteAccessStatsSourceSchema.safeParse({ ...source, ...change }).success).toBe(false);
  }
});

test("daily imports validate identity, observation timestamps and the HTTP collector's cache vocabulary", () => {
  expect(sqliteAccessStatsReplaceRequestSchema.safeParse(request).success).toBe(true);
  for (const change of [{ show_id: "weekly" }, { expected_version: -1 }, { expected_source_version: -1 },
    { input_min_at_ms: null }, { input_max_at_ms: Date.parse("2026-11-04T00:00:00Z") },
    { daily: { ...request.daily, source_id: "another-source" } },
    { daily: { ...request.daily, counters: { ...request.daily.counters, cache_status_requests: { invented: 1 } } } },
    { diagnostic: "private exception" }]) {
    expect(sqliteAccessStatsReplaceRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  }
  const zero = { ...request, input_min_at_ms: null, input_max_at_ms: null,
    daily: { ...request.daily, counters: { ...request.daily.counters, get_200_requests: 0, response_bytes: 0, cache_status_requests: {} } } };
  expect(sqliteAccessStatsReplaceRequestSchema.safeParse(zero).success).toBe(true);
});

test("the request budget reserves space for persisted records, metadata and pagination", () => {
  const large = { ...request, source: { ...source, interruptions: Array.from({ length: 200 }, (_, index) => ({
    started_at_ms: source.collection_started_at_ms + index * 2000,
    ended_at_ms: source.collection_started_at_ms + index * 2000 + 1000, reason_code: "delivery_error",
  })) } };
  expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeGreaterThan(MAX_SQLITE_ACCESS_STATS_REQUEST_BYTES);
  expect(sqliteAccessStatsReplaceRequestSchema.safeParse(large).success).toBe(false);
});

test("daily queries support twelve months within the maximum 366-day window", () => {
  const query = { service_id: request.service_id, service_config_sha256: request.service_config_sha256, show_id: "daily",
    source_id: source.source_id, resource_path: request.daily.resource_path, from_date_utc: "2025-11-04", to_date_utc: "2026-11-04" };
  expect(sqliteAccessStatsDailyRequestSchema.safeParse(query).success).toBe(true);
  for (const change of [{ from_date_utc: "2025-11-03" }, { from_date_utc: "2026-11-05" }, { from_date_utc: "2026-02-30" }, { cursor: "" }]) {
    expect(sqliteAccessStatsDailyRequestSchema.safeParse({ ...query, ...change }).success).toBe(false);
  }
});
