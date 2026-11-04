import { expect, test } from "bun:test";
import { accessStatsEventSchema, accessStatsResourceSchema } from "../../shared/src/access-stats";
import type { AccessStatsResource } from "../../shared/src/access-stats";
import { aggregateAccessStats } from "./access-stats-aggregate";
import { httpLogpushRecordToEvent, parseHttpLogpushRecord } from "./http-logpush-events";
import type { HttpLogpushSource } from "./http-logpush-events";

function parseHttpLogpushEvent(input: unknown, source: HttpLogpushSource, resources: ReadonlyMap<string, AccessStatsResource>) {
  return httpLogpushRecordToEvent(parseHttpLogpushRecord(input), source, resources);
}

const revisionId = "11111111-1111-4111-8111-111111111111";
const audio = accessStatsResourceSchema.parse({ show_id: "daily", resource_kind: "audio", episode_id: "first",
  audio_revision_id: revisionId, resource_path: `/podcasts/daily/episodes/first/${revisionId}.mp3` });
const cover = accessStatsResourceSchema.parse({ show_id: "daily", resource_kind: "cover", episode_id: null,
  audio_revision_id: null, resource_path: "/podcasts/daily/cover.jpg" });
const resources = new Map([audio, cover].map((resource) => [resource.resource_path, resource]));
const source = { zoneId: "a".repeat(32), hostname: "media.example.com" };
const record = { EdgeStartTimestamp: "2026-11-04T00:00:00Z", RayID: "7b52f2c4f9f64c1a",
  ClientRequestHost: source.hostname, ClientRequestPath: audio.resource_path, ClientRequestMethod: "GET",
  EdgeResponseStatus: 200, EdgeResponseBodyBytes: 120_000, CacheCacheStatus: "hit",
  ClientRequestSource: "eyeball", WorkerSubrequest: false };

test("HTTP Logpush converts only the selected fields to a common access event", () => {
  const event = parseHttpLogpushEvent(record, source, resources)!;
  expect(event).toEqual({ ...audio, source_id: `http_logpush:${source.zoneId}:${source.hostname}`,
    event_id: record.RayID, occurred_at_ms: Date.parse(record.EdgeStartTimestamp), host: source.hostname,
    method: "GET", status: 200, response_bytes: 120_000, cache_status: "hit" });
  expect(accessStatsEventSchema.parse(event)).toEqual(event);
  expect(parseHttpLogpushEvent({ ...record, ClientRequestPath: cover.resource_path }, source, resources))
    .toMatchObject({ ...cover, method: "GET", response_bytes: 120_000 });
});

test("host and zone identity remain stable when a Logpush job is recreated", () => {
  const event = parseHttpLogpushEvent(record, source, resources);
  const recreated = parseHttpLogpushEvent({ ...record, ClientRequestHost: "MEDIA.EXAMPLE.COM" },
    { zoneId: source.zoneId.toUpperCase(), hostname: "MEDIA.EXAMPLE.COM" }, resources);
  expect(recreated).toEqual(event);
});

test("HTTP Logpush filters other hosts, internal requests and unapproved public paths", () => {
  for (const change of [{ ClientRequestHost: "another.example.com" }, { ClientRequestSource: "edgeWorkerFetch" },
    { ClientRequestSource: "healthcheck" }, { WorkerSubrequest: true }, { ClientRequestMethod: "POST" },
    { EdgeResponseStatus: 404 }, { EdgeResponseStatus: 307 },
    { ClientRequestPath: "/podcasts/another/cover.jpg" },
    { ClientRequestPath: `/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3` },
    { ClientRequestPath: "/podcasts/daily/feed.xml" }, { ClientRequestPath: "/system/service.toml" }]) {
    expect(parseHttpLogpushEvent({ ...record, ...change }, source, resources)).toBeNull();
  }
});

test("HTTP Logpush preserves GET body bytes and normalizes HEAD and 304 bodies to zero", () => {
  for (const status of [200, 206]) {
    expect(parseHttpLogpushEvent({ ...record, EdgeResponseStatus: status }, source, resources))
      .toMatchObject({ status, response_bytes: 120_000 });
  }
  for (const method of ["GET", "HEAD"]) {
    for (const status of [200, 206, 304]) {
      if (method === "GET" && status !== 304) continue;
      const event = parseHttpLogpushEvent({ ...record, ClientRequestMethod: method, EdgeResponseStatus: status }, source, resources);
      expect(event).toMatchObject({ method, status, response_bytes: 0 });
      expect(accessStatsEventSchema.safeParse(event).success).toBe(true);
    }
  }
});

test("HTTP Logpush uses the configured RFC 3339 occurrence time, including UTC offsets", () => {
  const event = parseHttpLogpushEvent({ ...record, EdgeStartTimestamp: "2026-11-04T00:30:00+01:00" }, source, resources);
  expect(event?.occurred_at_ms).toBe(Date.parse("2026-11-03T23:30:00Z"));
  for (const EdgeStartTimestamp of ["2026-02-30T12:00:00Z", "2026-11-04T24:00:00Z", "2026-11-04T12:00:00",
    "2026-11-04T12:00Z", 1_793_750_400_000]) {
    expect(() => parseHttpLogpushEvent({ ...record, EdgeStartTimestamp }, source, resources))
      .toThrow("Invalid HTTP Requests Logpush record");
  }
});

test("invalid or privacy-expanding Logpush records fail without echoing their contents", () => {
  const { RayID: _rayId, ...missingId } = record;
  for (const input of [null, missingId, { ...record, EdgeResponseBodyBytes: -1 },
    { ...record, EdgeResponseStatus: "200" }, { ...record, WorkerSubrequest: "false" },
    { ...record, ClientIP: "192.0.2.1" }, { ...record, ClientRequestUserAgent: "private-agent" },
    { ...record, ClientRequestURI: `${audio.resource_path}?token=secret` }]) {
    try {
      parseHttpLogpushEvent(input, source, resources);
      throw new Error("Expected Logpush record validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Invalid HTTP Requests Logpush record");
    }
  }
});

test("Logpush conversion and recomputation deduplicate replayed files and include late records by occurrence day", () => {
  const original = parseHttpLogpushEvent({ ...record, EdgeStartTimestamp: "2026-11-03T23:59:59Z" }, source, resources)!;
  const late = parseHttpLogpushEvent({ ...record, RayID: "7b52f2c4f9f64c1b",
    EdgeStartTimestamp: "2026-11-03T23:59:58Z", EdgeResponseStatus: 206, CacheCacheStatus: "miss" }, source, resources)!;
  const today = parseHttpLogpushEvent({ ...record, RayID: "7b52f2c4f9f64c1c" }, source, resources)!;
  const before = aggregateAccessStats([original, today]);
  const after = aggregateAccessStats([today, original, original, late, late]);
  expect(before[0]!.counters.get_206_requests).toBe(0);
  expect(after.map((day) => [day.date_utc, day.counters.get_200_requests, day.counters.get_206_requests]))
    .toEqual([["2026-11-03", 1, 1], ["2026-11-04", 1, 0]]);
  expect(after).toEqual(aggregateAccessStats([late, original, today]));
});
