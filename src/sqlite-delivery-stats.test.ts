import { afterEach, expect, test } from "bun:test";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { SqliteDeliveryStats, sqliteDeliveryCounterDelta } from "./sqlite-delivery-stats";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import type { SqliteDeliveryObservation } from "../packages/shared/src/sqlite-stats";

const fixtures: Array<ReturnType<typeof sqlitePublicationFixture>> = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });

const audioLength = 1_200_000;
function observation(overrides: Partial<SqliteDeliveryObservation> = {}): SqliteDeliveryObservation {
  return { episode_id: "first", audio_revision_id: crypto.randomUUID(), method: "GET", status: 200,
    content_length: audioLength, range_offset: null, bot: false, ...overrides };
}

function statsFixture(startedAtMs: number) {
  const value = sqlitePublicationFixture({ resume: false });
  fixtures.push(value);
  const content = new SqlitePublicationContent(value.storage);
  let now = startedAtMs;
  const audioRevision = crypto.randomUUID();
  value.storage.sql.exec("INSERT INTO publication_shows (show_id, reservation_id, state_version, feed_generation, lifecycle) VALUES ('daily', ?, 0, 0, 'published')", crypto.randomUUID());
  value.storage.sql.exec("INSERT INTO publication_episodes (show_id, episode_id, lifecycle, lifecycle_version, revision_id) VALUES ('daily', 'first', 'published', 0, ?)", crypto.randomUUID());
  value.storage.sql.exec("INSERT INTO publication_media (show_id, episode_id, audio_revision_id, sha256, length_bytes) VALUES ('daily', 'first', ?, ?, ?)",
    audioRevision, "b".repeat(64), audioLength);
  const stats = new SqliteDeliveryStats(value.storage, "daily", value.runtime, () => now);
  const advanceTo = (ms: number) => { now = ms; };
  const recordAt = (ms: number, entries: SqliteDeliveryObservation[]) => { now = ms; stats.record(entries); };
  return { ...value, content, stats, audioRevision, advanceTo, recordAt };
}

test("counter deltas classify HEAD, 304, full GET, initial range, probe range, tail range and bots", () => {
  expect(sqliteDeliveryCounterDelta(observation({ method: "HEAD", status: 200, content_length: 0 }), audioLength))
    .toMatchObject({ head_requests: 1, get_200_requests: 0, get_206_requests: 0, initial_downloads: 0, response_bytes: 0, bot_get_requests: 0 });
  expect(sqliteDeliveryCounterDelta(observation({ method: "HEAD", status: 206, content_length: 0, range_offset: 0 }), audioLength))
    .toMatchObject({ head_requests: 1, initial_downloads: 0 });
  expect(sqliteDeliveryCounterDelta(observation({ status: 304, content_length: 0 }), audioLength))
    .toMatchObject({ not_modified_requests: 1, response_bytes: 0, initial_downloads: 0 });
  expect(sqliteDeliveryCounterDelta(observation({ bot: true }), audioLength))
    .toMatchObject({ bot_get_requests: 1, bot_response_bytes: audioLength, get_200_requests: 0, initial_downloads: 0, response_bytes: 0 });
  expect(sqliteDeliveryCounterDelta(observation(), audioLength))
    .toMatchObject({ get_200_requests: 1, initial_downloads: 1, response_bytes: audioLength });
  expect(sqliteDeliveryCounterDelta(observation({ status: 206, content_length: 65536, range_offset: 0 }), audioLength))
    .toMatchObject({ get_206_requests: 1, initial_downloads: 1, response_bytes: 65536, probe_range_requests: 0 });
  expect(sqliteDeliveryCounterDelta(observation({ status: 206, content_length: 1, range_offset: 0 }), audioLength))
    .toMatchObject({ get_206_requests: 1, initial_downloads: 0, probe_range_requests: 1, response_bytes: 1 });
  expect(sqliteDeliveryCounterDelta(observation({ status: 206, content_length: 1048576, range_offset: 524288 }), audioLength))
    .toMatchObject({ get_206_requests: 1, initial_downloads: 0, probe_range_requests: 0, response_bytes: 1048576 });
  // A file smaller than 64 KiB turns any full-length initial range into an initial download.
  expect(sqliteDeliveryCounterDelta(observation({ status: 206, content_length: 100, range_offset: 0 }), 100))
    .toMatchObject({ initial_downloads: 1, probe_range_requests: 0 });
});

test("records aggregate per day, revision and episode while ignoring unknown media", () => {
  const started = Date.UTC(2026, 9, 10, 4);
  const value = statsFixture(started);
  const day1 = started + 60_000, day2 = Date.UTC(2026, 9, 11, 12);
  value.recordAt(day1, [observation({ audio_revision_id: value.audioRevision }), observation({ audio_revision_id: value.audioRevision, status: 304, content_length: 0 }),
    observation({ method: "HEAD", status: 200, content_length: 0, audio_revision_id: value.audioRevision })]);
  value.recordAt(day2, [observation({ audio_revision_id: value.audioRevision, status: 206, content_length: 1, range_offset: 0 }),
    observation({ audio_revision_id: value.audioRevision, bot: true, status: 206, content_length: 10, range_offset: 0 }),
    observation({ episode_id: "unapproved", audio_revision_id: crypto.randomUUID() })]);
  const page = value.stats.episodePage({ from_date_utc: "2026-10-10", to_date_utc: "2026-10-11" });
  expect(page.episodes).toHaveLength(1);
  expect(page.episodes[0]).toMatchObject({ episode_id: "first", lifecycle: "published", coverage: "partial",
    period: { get_200_requests: 1, get_206_requests: 1, audio_get_requests: 2, initial_downloads: 1,
      response_bytes: audioLength + 1, probe_range_requests: 1, head_requests: 1, not_modified_requests: 1,
      bot_get_requests: 1, bot_response_bytes: 10, equivalent_full_downloads: 1 } });
  expect(page.nextCursor).toBeNull();
  const daily = value.stats.dailyPage({ episode_id: "first", from_date_utc: "2026-10-10", to_date_utc: "2026-10-11" });
  expect(daily.coverage).toBe("partial");
  expect(daily.days.map((day) => day.date_utc)).toEqual(["2026-10-10", "2026-10-11"]);
  expect(daily.days[0]).toMatchObject({ coverage: "partial", counters: { initial_downloads: 1, head_requests: 1 } });
  // 2026-10-11 is the current UTC day (the injected now), so it stays partial with its observed counters.
  expect(daily.days[1]).toMatchObject({ coverage: "partial", counters: { initial_downloads: 0, probe_range_requests: 1, bot_get_requests: 1 } });
  expect(daily.revisions).toHaveLength(1);
  expect(daily.revisions[0]).toMatchObject({ audio_revision_id: value.audioRevision, length_bytes: audioLength, is_current_enclosure: false });
});

test("days before measurement, access-free measured days and pruned days never render as zero", () => {
  const started = Date.UTC(2026, 9, 10, 0);
  const value = statsFixture(started);
  value.recordAt(started + 1000, [observation({ audio_revision_id: value.audioRevision })]);
  const daily = value.stats.dailyPage({ episode_id: "first", from_date_utc: "2026-10-08", to_date_utc: "2026-10-10" });
  expect(daily.days.map((day) => [day.date_utc, day.coverage, day.counters])).toEqual([
    ["2026-10-08", "unmeasured", null],
    ["2026-10-09", "unmeasured", null],
    ["2026-10-10", "partial", { get_200_requests: 1, get_206_requests: 0, audio_get_requests: 1, initial_downloads: 1,
      response_bytes: audioLength, probe_range_requests: 0, head_requests: 0, not_modified_requests: 0,
      bot_get_requests: 0, bot_response_bytes: 0, equivalent_full_downloads: 1 }],
  ]);
  expect(daily.coverage).toBe("partial");
  const noTraffic = value.stats.dailyPage({ episode_id: "first", from_date_utc: "2026-10-10", to_date_utc: "2026-10-10" });
  expect(noTraffic.coverage).not.toBe("unmeasured");
  // A mid-window day without any recorded row still resolves to measured zeros through the window, not the table row.
  value.advanceTo(Date.UTC(2026, 9, 12, 6));
  const span = value.stats.dailyPage({ episode_id: "first", from_date_utc: "2026-10-10", to_date_utc: "2026-10-12" });
  expect(span.days.map((day) => [day.date_utc, day.coverage])).toEqual([["2026-10-10", "measured"], ["2026-10-11", "measured"], ["2026-10-12", "partial"]]);
  expect(span.days[1]).toMatchObject({ counters: { initial_downloads: 0, audio_get_requests: 0 } });
});

test("retention shortening advances the boundary immediately and merges pruned days into lifetime totals", async () => {
  const started = Date.UTC(2026, 8, 1, 0);
  const value = statsFixture(started);
  value.recordAt(started, [observation({ audio_revision_id: value.audioRevision })]);
  const early = value.stats.dailyPage({ episode_id: "first", from_date_utc: "2026-09-01", to_date_utc: "2026-09-01" });
  expect(early.days[0]!.counters).not.toBeNull();
  const operationId = crypto.randomUUID();
  const applied = await value.stats.applyRetention({ ...value.runtime, show_id: "daily", operation_id: operationId, retention_days: 30 }, value.runtime);
  expect(applied.retention_days).toBe(30);
  // One batch (at most 200 rows) per UTC day; the declaration moves first.
  const later = Date.UTC(2026, 9, 10, 1);
  value.advanceTo(later);
  value.stats.record([]);
  const cutoff = "2026-09-11";
  const after = value.stats.dailyPage({ episode_id: "first", from_date_utc: "2026-09-01", to_date_utc: "2026-10-10" });
  expect(value.stats.meta().retained_from_date_utc).toBe(cutoff);
  expect(after.days[0]).toMatchObject({ date_utc: "2026-09-01", coverage: "pruned", counters: null });
  expect(after.lifetime).toMatchObject({ initial_downloads: 1, response_bytes: audioLength, equivalent_full_downloads: 1 });
  // The pruned part is excluded from period totals, but measurable days still contribute their observed zero.
  expect(after.period).toMatchObject({ initial_downloads: 0, response_bytes: 0 });
  expect(after.coverage).toBe("partial");
  // Same operation id with the same content replays the stored record; different content is rejected.
  expect((await value.stats.applyRetention({ ...value.runtime, show_id: "daily", operation_id: operationId, retention_days: 30 }, value.runtime)).applied_at_ms)
    .toBe(applied.applied_at_ms);
  await expect(value.stats.applyRetention({ ...value.runtime, show_id: "daily", operation_id: operationId, retention_days: 60 }, value.runtime)).rejects.toThrow();
  await expect(value.stats.applyRetention({ ...value.runtime, show_id: "daily", operation_id: crypto.randomUUID(), retention_days: 10 }, value.runtime)).rejects.toThrow();
});

test("recording failures are counted, daily paging uses bounded pages and windows are range-checked", () => {
  const started = Date.UTC(2026, 9, 1, 0);
  const value = statsFixture(started);
  const bad: unknown = [{ episode_id: "first", audio_revision_id: "not-a-uuid", method: "GET", status: 200, content_length: 1, range_offset: null, bot: false }];
  expect(() => value.stats.record(bad as never)).toThrow();
  expect(value.stats.meta().recording_error_count).toBe(1);
  expect(value.stats.meta().last_recording_error_at_ms).toBe(started);
  expect(() => value.stats.episodePage({ from_date_utc: "2026-10-05", to_date_utc: "2026-10-01" })).toThrow();
  expect(() => value.stats.episodePage({ from_date_utc: "2025-09-01", to_date_utc: "2026-10-10" })).toThrow();
  value.advanceTo(Date.UTC(2026, 9, 10, 0));
  const span = value.stats.dailyPage({ episode_id: "first", from_date_utc: "2026-09-01", to_date_utc: "2026-10-10" });
  expect(span.days).toHaveLength(31);
  expect(span.days.at(-1)!.date_utc).toBe("2026-10-01");
  expect(span.nextCursor).not.toBeNull();
  const next = value.stats.dailyPage({ episode_id: "first", from_date_utc: "2026-09-01", to_date_utc: "2026-10-10", cursor: span.nextCursor! });
  expect(next.days[0]!.date_utc).toBe("2026-10-02");
  expect(next.days.at(-1)!.date_utc).toBe("2026-10-10");
  expect(next.nextCursor).toBeNull();
  expect(() => value.stats.dailyPage({ episode_id: "first", cursor: btoa(JSON.stringify({ ...value.runtime, show_id: "other" })) } as never)).toThrow();
});
