import { afterEach, expect, test } from "bun:test";
import { accessStatsResourceSchema } from "../../shared/src/access-stats";
import type { AccessStatsEvent } from "../../shared/src/access-stats";
import { AccessLogFileIndex } from "./access-log-file-index";
import { aggregateAccessStats } from "./access-stats-aggregate";
import { readHttpLogpushLogs } from "./http-logpush-read";
import { logAudio, logObject, logR2Fixture, logRecord, logTarget } from "./test-support/http-logpush";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace(): string {
  const root = mkdtempSync("/tmp/opencode/castloop-logpush-read-");
  roots.push(root);
  return root;
}
const otherShow = accessStatsResourceSchema.parse({ show_id: "weekly", resource_kind: "cover", episode_id: null,
  audio_revision_id: null, resource_path: "/podcasts/weekly/cover.png" });
const resources = new Map([logAudio, otherShow].map((resource) => [resource.resource_path, resource]));
const selection = { showId: "daily", fromDateUtc: "2026-11-04", toDateUtc: "2026-11-04" };
const apiToken = "private-log-read-token";

async function collect(root: string, fixture: ReturnType<typeof logR2Fixture>, selected = selection, target = logTarget) {
  const events: AccessStatsEvent[] = [];
  const summary = await readHttpLogpushLogs(root, target, selected, resources, (event) => { events.push(event); },
    { accountId: target.accountId, apiToken, transport: fixture.transport });
  return { events, summary };
}

test("log readout filters UTC boundaries, host, Show and approved resources using occurrence time rather than folders", async () => {
  const records = [
    { ...logRecord, RayID: "before", EdgeStartTimestamp: "2026-11-03T23:59:59Z" },
    { ...logRecord, RayID: "start", EdgeStartTimestamp: "2026-11-04T00:00:00Z" },
    { ...logRecord, RayID: "end", EdgeStartTimestamp: "2026-11-04T23:59:59Z", EdgeResponseStatus: 206 },
    { ...logRecord, RayID: "after", EdgeStartTimestamp: "2026-11-05T00:00:00Z" },
    { ...logRecord, RayID: "another-show", ClientRequestPath: otherShow.resource_path },
    { ...logRecord, RayID: "another-host", ClientRequestHost: "another.example.com" },
    { ...logRecord, RayID: "internal", ClientRequestSource: "edgeWorkerFetch", WorkerSubrequest: true },
    { ...logRecord, RayID: "unapproved", ClientRequestPath: "/podcasts/daily/episodes/first/22222222-2222-4222-8222-222222222222.mp3" },
  ];
  const object = logObject("2026-11-05/delayed.gz", records.map((record) => JSON.stringify(record)).join("\n"));
  const fixture = logR2Fixture([object]);
  const result = await collect(workspace(), fixture);
  expect(result.events.map((event) => event.event_id)).toEqual(["start", "end"]);
  expect(result.summary.inputFiles).toEqual([object.file]);
  expect(result.summary.newOutsideDatesUtc).toEqual(["2026-11-03", "2026-11-05"]);
  expect(aggregateAccessStats(result.events)[0]!.counters).toMatchObject({ get_200_requests: 1, get_206_requests: 1, response_bytes: 240_000 });
});

test("warm indexes skip unrelated and empty file bodies while preserving recomputation results", async () => {
  const wanted = logObject("2026-11-04/wanted.gz", JSON.stringify(logRecord));
  const outside = logObject("2026-11-05/outside.gz", JSON.stringify({ ...logRecord, EdgeStartTimestamp: "2026-11-05T12:00:00Z" }));
  const empty = logObject("2026-11-04/empty.gz", "");
  const fixture = logR2Fixture([outside, wanted, empty], 1), root = workspace();
  const cold = await collect(root, fixture);
  expect(fixture.bodyReads).toHaveLength(3);
  fixture.bodyReads.length = 0;
  const warm = await collect(root, fixture);
  expect(fixture.bodyReads).toEqual([wanted.file.key]);
  expect(warm.events).toEqual(cold.events);
  expect(warm.summary.inputFiles).toEqual(cold.summary.inputFiles);
  expect(warm.summary.newOutsideDatesUtc).toEqual([]);
  unlinkSync(join(root, ".castloop", "access-log-files.sqlite"));
  fixture.bodyReads.length = 0;
  const rebuilt = await collect(root, fixture);
  expect(fixture.bodyReads).toHaveLength(3);
  expect(rebuilt.events).toEqual(cold.events);
  expect(rebuilt.summary).toEqual(cold.summary);
  const indexBytes = readFileSync(join(root, ".castloop", "access-log-files.sqlite"));
  expect(indexBytes.includes(Buffer.from(apiToken))).toBe(false);
  expect(indexBytes.includes(Buffer.from(logRecord.RayID))).toBe(false);
});

test("file-wide occurrence ranges allow index reuse by a different Show", async () => {
  const object = logObject("2026-11-04/multiple-shows.gz", [
    { ...logRecord, EdgeStartTimestamp: "2025-11-04T12:00:00Z" },
    { ...logRecord, RayID: "weekly-request", ClientRequestPath: otherShow.resource_path },
  ].map((record) => JSON.stringify(record)).join("\n"));
  const root = workspace(), fixture = logR2Fixture([object]);
  const first = await collect(root, fixture, { ...selection, fromDateUtc: "2025-11-04", toDateUtc: "2025-11-04" });
  expect(first.events).toHaveLength(1);
  fixture.bodyReads.length = 0;
  const second = await collect(root, fixture, { ...selection, showId: "weekly" });
  expect(second.events.map((event) => event.event_id)).toEqual(["weekly-request"]);
  expect(fixture.bodyReads).toEqual([object.file.key]);
  const index = new AccessLogFileIndex(root);
  try { expect(index.get(logTarget, object.file)).toEqual({
    minOccurredAtMs: Date.parse("2025-11-04T12:00:00Z"), maxOccurredAtMs: Date.parse(logRecord.EdgeStartTimestamp),
  }); } finally { index.close(); }
});

test("new files in later folders add late requests to past-day recomputation and identify outside days", async () => {
  const original = logObject("2026-11-04/original.gz", JSON.stringify(logRecord));
  const root = workspace(), fixture = logR2Fixture([original]);
  await collect(root, fixture);
  const late = logObject("2026-11-06/late.gz", [
    logRecord,
    { ...logRecord, RayID: "new-late", EdgeResponseStatus: 206 },
    { ...logRecord, RayID: "outside-late", EdgeStartTimestamp: "2026-11-02T12:00:00Z" },
  ].map((record) => JSON.stringify(record)).join("\n"));
  fixture.objects.set(late.file.key, late);
  const result = await collect(root, fixture);
  expect(result.events).toHaveLength(3);
  expect(result.summary.newOutsideDatesUtc).toEqual(["2026-11-02"]);
  expect(aggregateAccessStats(result.events)[0]!.counters).toMatchObject({ get_200_requests: 1, get_206_requests: 1 });
  const repeat = await collect(root, fixture);
  expect(aggregateAccessStats(repeat.events)).toEqual(aggregateAccessStats(result.events));
});

test("the listed input set stays fixed and files arriving later are discovered on the next read", async () => {
  const original = logObject("2026-11-04/original.gz", JSON.stringify(logRecord));
  const later = logObject("2026-11-04/later.gz", JSON.stringify({ ...logRecord, RayID: "later" }));
  const fixture = logR2Fixture([original]), originalTransport = fixture.transport;
  fixture.transport = async (input, init) => {
    const response = await originalTransport(input, init);
    if (new URL(String(input)).pathname.endsWith("/objects")) fixture.objects.set(later.file.key, later);
    return response;
  };
  const root = workspace(), first = await collect(root, fixture);
  expect(first.summary.inputFiles).toEqual([original.file]);
  expect(first.events.map((event) => event.event_id)).toEqual([logRecord.RayID]);
  const second = await collect(root, fixture);
  expect(new Set(second.events.map((event) => event.event_id))).toEqual(new Set([logRecord.RayID, "later"]));
});

test("failed parsing leaves that file unindexed and rerunning reproduces the complete results", async () => {
  const bad = logObject("2026-11-04/a.gz", `${JSON.stringify(logRecord)}\n{"private-token":`);
  const fixture = logR2Fixture([bad]), root = workspace();
  await expect(collect(root, fixture)).rejects.toThrow("Invalid JSON in HTTP Requests Logpush file");
  const index = new AccessLogFileIndex(root);
  try { expect(index.get(logTarget, bad.file)).toBeNull(); }
  finally { index.close(); }
  const valid = logObject("2026-11-04/a.gz", JSON.stringify(logRecord));
  fixture.objects.set(valid.file.key, valid);
  const result = await collect(root, fixture);
  expect(result.events.map((event) => event.event_id)).toEqual([logRecord.RayID]);
  expect(readFileSync(join(root, ".castloop", "access-log-files.sqlite")).includes(Buffer.from("private-token"))).toBe(false);
});

test("a consumer interruption does not mark a partly consumed file as indexed", async () => {
  const object = logObject("2026-11-04/a.gz", [logRecord, { ...logRecord, RayID: "second" }].map((record) => JSON.stringify(record)).join("\n"));
  const fixture = logR2Fixture([object]), root = workspace();
  await expect(readHttpLogpushLogs(root, logTarget, selection, resources, () => { throw new Error("Consumer stopped"); },
    { accountId: logTarget.accountId, apiToken, transport: fixture.transport })).rejects.toThrow("Consumer stopped");
  const index = new AccessLogFileIndex(root);
  try { expect(index.get(logTarget, object.file)).toBeNull(); }
  finally { index.close(); }
  expect((await collect(root, fixture)).events).toHaveLength(2);
});

test("readout covers twelve months and supports saved old-host and old-revision references", async () => {
  const oldHost = "old-media.example.com";
  const object = logObject("2026-11-04/history.gz", [
    { ...logRecord, RayID: "year-start", EdgeStartTimestamp: "2025-11-04T00:00:00Z", ClientRequestHost: oldHost },
    { ...logRecord, RayID: "year-end", EdgeStartTimestamp: "2026-11-04T23:59:59Z", ClientRequestHost: oldHost },
  ].map((record) => JSON.stringify(record)).join("\n"));
  const fixture = logR2Fixture([object]);
  const result = await collect(workspace(), fixture, { ...selection, fromDateUtc: "2025-11-04" }, { ...logTarget, hostname: oldHost });
  expect(result.events.map((event) => event.event_id)).toEqual(["year-start", "year-end"]);
  expect(result.events.every((event) => event.source_id.endsWith(`:${oldHost}`) && event.audio_revision_id === logAudio.audio_revision_id)).toBe(true);
});

test("invalid selections and account mismatches fail before requests or local index writes", async () => {
  const root = workspace(), fixture = logR2Fixture([]);
  for (const change of [{ fromDateUtc: "2026-02-30" }, { fromDateUtc: "2026-11-05" }, { fromDateUtc: "2025-11-03" },
    { showId: "../another" }]) {
    await expect(collect(root, fixture, { ...selection, ...change })).rejects.toThrow();
  }
  await expect(readHttpLogpushLogs(root, logTarget, selection, resources, () => {},
    { accountId: "c".repeat(32), apiToken, transport: fixture.transport })).rejects.toThrow("credentials");
  expect(fixture.requests).toEqual([]);
  expect(existsSync(join(root, ".castloop"))).toBe(false);
});
