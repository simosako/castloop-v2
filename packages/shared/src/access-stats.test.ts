import { expect, test } from "bun:test";
import { ACCESS_STATS_FORMAT, accessStatsCountersSchema, accessStatsDailySchema,
  accessStatsEventSchema, accessStatsResourceSchema } from "./access-stats";

const revisionId = "11111111-1111-4111-8111-111111111111";
const audio = { show_id: "daily", resource_kind: "audio" as const, episode_id: "first", audio_revision_id: revisionId,
  resource_path: `/podcasts/daily/episodes/first/${revisionId}.mp3` };
const cover = { show_id: "daily", resource_kind: "cover" as const, episode_id: null, audio_revision_id: null,
  resource_path: "/podcasts/daily/cover.jpg" };
const event = { ...audio, source_id: "http_logpush:zone:media.example.com", event_id: "ray-1",
  occurred_at_ms: Date.parse("2026-11-04T00:00:00Z"), host: "media.example.com", method: "GET" as const, status: 200 as const,
  response_bytes: 100, cache_status: "hit" };
const counters = { get_200_requests: 1, get_206_requests: 0, head_requests: 0, not_modified_requests: 0,
  response_bytes: 100, cache_status_requests: { hit: 1 } };

test("access resources match the existing public audio and cover paths", () => {
  expect(accessStatsResourceSchema.parse(audio)).toEqual(audio);
  expect(accessStatsResourceSchema.parse(cover)).toEqual(cover);
  expect(accessStatsResourceSchema.parse({ ...cover, resource_path: "/podcasts/daily/cover.png" }).resource_kind).toBe("cover");
  for (const change of [{ show_id: "another" }, { episode_id: "another" }, { audio_revision_id: crypto.randomUUID() },
    { episode_id: null }, { resource_kind: "cover" }, { resource_path: `${audio.resource_path}?token=secret` },
    { resource_path: "/podcasts/daily/feed.xml" }, { resource_path: "/system/service.toml" }]) {
    expect(accessStatsResourceSchema.safeParse({ ...audio, ...change }).success).toBe(false);
  }
  expect(accessStatsResourceSchema.safeParse({ ...cover, episode_id: "first" }).success).toBe(false);
  expect(accessStatsResourceSchema.safeParse({ ...cover, audio_revision_id: revisionId }).success).toBe(false);
});

test("common access events validate body bytes and keep listener identifiers out of the schema", () => {
  expect(accessStatsEventSchema.parse(event)).toEqual(event);
  expect(accessStatsEventSchema.parse({ ...event, cache_status: null }).cache_status).toBeNull();
  for (const change of [{ event_id: "" }, { source_id: "" }, { method: "POST" }, { status: 404 },
    { occurred_at_ms: -1 }, { response_bytes: -1 }, { response_bytes: 0.5 },
    { method: "HEAD" }, { status: 304 }, { client_ip: "192.0.2.1" }, { user_agent: "private-agent" },
    { cookie: "secret" }]) {
    expect(accessStatsEventSchema.safeParse({ ...event, ...change }).success).toBe(false);
  }
  for (const change of [{ method: "HEAD", status: 200 }, { method: "HEAD", status: 206 },
    { method: "HEAD", status: 304 }, { method: "GET", status: 304 }]) {
    expect(accessStatsEventSchema.parse({ ...event, ...change, response_bytes: 0 }).response_bytes).toBe(0);
  }
});

test("new daily counters use a separate definition from existing Worker statistics", () => {
  const daily = { ...audio, format: ACCESS_STATS_FORMAT, source_id: event.source_id, date_utc: "2026-11-04", counters };
  expect(accessStatsDailySchema.parse(daily)).toEqual(daily);
  expect(accessStatsDailySchema.safeParse({ ...daily, date_utc: "2026-02-30" }).success).toBe(false);
  expect(accessStatsDailySchema.safeParse({ ...daily, format: "episode-daily-v1" }).success).toBe(false);
  expect(accessStatsDailySchema.safeParse({ ...daily, episode_id: "another" }).success).toBe(false);
  for (const change of [{ initial_downloads: 0 }, { bot_get_requests: 0 }, { probe_range_requests: 0 },
    { get_200_requests: -1 }, { response_bytes: 0.5 }, { cache_status_requests: { hit: 2 } }]) {
    expect(accessStatsCountersSchema.safeParse({ ...counters, ...change }).success).toBe(false);
  }
});
