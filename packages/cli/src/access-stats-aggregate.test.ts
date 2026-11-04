import { expect, test } from "bun:test";
import { ACCESS_STATS_FORMAT, accessStatsDailySchema, accessStatsEventSchema } from "../../shared/src/access-stats";
import type { AccessStatsEvent } from "../../shared/src/access-stats";
import { aggregateAccessStats } from "./access-stats-aggregate";

const revisionId = "11111111-1111-4111-8111-111111111111";
const otherRevisionId = "22222222-2222-4222-8222-222222222222";
const event = accessStatsEventSchema.parse({ source_id: "http_logpush:zone:media.example.com", event_id: "ray-1",
  occurred_at_ms: Date.parse("2026-11-04T00:00:00Z"), host: "media.example.com", show_id: "daily",
  resource_path: `/podcasts/daily/episodes/first/${revisionId}.mp3`, resource_kind: "audio", episode_id: "first",
  audio_revision_id: revisionId, method: "GET", status: 200, response_bytes: 1_000, cache_status: "hit" });

test("daily aggregation classifies all supported responses and cache statuses", () => {
  const events: AccessStatsEvent[] = [event,
    { ...event, event_id: "ray-2", status: 206, response_bytes: 100, cache_status: "miss" },
    { ...event, event_id: "ray-3", status: 304, response_bytes: 0, cache_status: "revalidated" },
    { ...event, event_id: "ray-4", method: "HEAD", response_bytes: 0 },
    { ...event, event_id: "ray-5", method: "HEAD", status: 206, response_bytes: 0 },
    { ...event, event_id: "ray-6", method: "HEAD", status: 304, response_bytes: 0, cache_status: "revalidated" }];
  const original = JSON.stringify(events);
  const result = aggregateAccessStats(events);
  expect(result).toEqual([{ format: ACCESS_STATS_FORMAT, source_id: event.source_id, date_utc: "2026-11-04",
    show_id: "daily", resource_path: event.resource_path, resource_kind: "audio", episode_id: "first",
    audio_revision_id: revisionId, counters: { get_200_requests: 1, get_206_requests: 1, head_requests: 3,
      not_modified_requests: 1, response_bytes: 1_100, cache_status_requests: { hit: 3, miss: 1, revalidated: 2 } } }]);
  expect(accessStatsDailySchema.parse(result[0])).toEqual(result[0]);
  expect(JSON.stringify(events)).toBe(original);
});

test("deduplication is scoped to the source and UTC occurrence day", () => {
  const previous = { ...event, occurred_at_ms: Date.parse("2026-11-03T23:59:59Z") };
  const anotherSource = { ...event, source_id: "http_logpush:other-zone:media.example.com" };
  const result = aggregateAccessStats([event, { ...event }, previous, { ...previous }, anotherSource, { ...anotherSource }]);
  expect(result).toHaveLength(3);
  expect(result.map((row) => row.counters.get_200_requests)).toEqual([1, 1, 1]);
  expect(result.filter((row) => row.source_id === event.source_id).map((row) => row.date_utc))
    .toEqual(["2026-11-03", "2026-11-04"]);
});

test("daily groups keep Shows, Episodes, audio revisions and covers separate", () => {
  const events: AccessStatsEvent[] = [event,
    { ...event, event_id: "second-revision", audio_revision_id: otherRevisionId,
      resource_path: `/podcasts/daily/episodes/first/${otherRevisionId}.mp3` },
    { ...event, event_id: "second-episode", episode_id: "second",
      resource_path: `/podcasts/daily/episodes/second/${revisionId}.mp3` },
    { ...event, event_id: "another-show", show_id: "another",
      resource_path: `/podcasts/another/episodes/first/${revisionId}.mp3` },
    { ...event, event_id: "cover", resource_kind: "cover", episode_id: null, audio_revision_id: null,
      resource_path: "/podcasts/daily/cover.jpg" }];
  const result = aggregateAccessStats(events);
  expect(result).toHaveLength(5);
  expect(new Set(result.map((row) => row.resource_path)).size).toBe(5);
  expect(result.every((row) => row.counters.get_200_requests === 1 && row.counters.response_bytes === 1_000)).toBe(true);
  for (const row of result) expect(accessStatsDailySchema.safeParse(row).success).toBe(true);
});

test("recomputation is deterministic, accepts a record iterator and keeps no state between runs", () => {
  const events = [event, { ...event, event_id: "ray-2", cache_status: "miss" },
    { ...event, event_id: "ray-3", cache_status: "bypass" },
    { ...event, event_id: "ray-4", occurred_at_ms: Date.parse("2026-11-03T23:59:59Z") }];
  const result = aggregateAccessStats(events);
  const serialized = JSON.stringify(result);
  function* replay() {
    for (const item of events.toReversed()) {
      yield item;
      yield { ...item };
    }
  }
  expect(JSON.stringify(aggregateAccessStats(replay()))).toBe(serialized);
  result[0]!.counters.get_200_requests = 999;
  result[0]!.counters.cache_status_requests.hit = 999;
  expect(JSON.stringify(aggregateAccessStats(events))).toBe(serialized);
  expect(aggregateAccessStats([])).toEqual([]);
});

test("common aggregation handles a collector without cache measurements", () => {
  const result = aggregateAccessStats([{ ...event, source_id: "other-collector:media.example.com", cache_status: null }]);
  expect(result[0]!.counters.cache_status_requests).toEqual({ unavailable: 1 });
  expect(accessStatsDailySchema.safeParse(result[0]).success).toBe(true);
});
