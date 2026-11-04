import { z } from "zod";
import { validateId } from "../../shared/src/ids";
import { ACCESS_STATS_FORMAT } from "../../shared/src/access-stats";
import type { AccessStatsDaily, AccessStatsEvent, AccessStatsResource } from "../../shared/src/access-stats";
import { sqliteAccessStatsSourceSchema, sqliteAccessStatsDailyRequestSchema, sqliteAccessStatsReplaceRequestSchema,
  sqliteAccessStatsSourcesResponseSchema, sqliteAccessStatsResourcesResponseSchema, sqliteAccessStatsDailyResponseSchema,
  sqliteAccessStatsSourceRecordSchema } from "../../shared/src/sqlite-access-stats";
import type { SqliteAccessStatsSource, SqliteAccessStatsSourceRecord } from "../../shared/src/sqlite-access-stats";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import { administratorKey } from "./administrator-key";
import { aggregateAccessStats } from "./access-stats-aggregate";
import { AccessLogFileIndex } from "./access-log-file-index";
import type { R2RestOptions, R2RestTransport } from "./bounded-http-read";
import { readHttpLogpushLogs } from "./http-logpush-read";
import { assertRealParentDirectories, syncLocalJournalDirectory } from "./local-journal-path";
import { readLogpushConfiguration } from "./logpush-config";
import { runLogpushCommand } from "./logpush";
import { sha256HexSync } from "./sha256";
import { SqliteServiceClient } from "./sqlite-service-client";
import { closeSync, fsyncSync, openSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DAY_MS = 86_400_000;
const UNSUPPORTED_METRICS = ["initial_downloads", "probe_range_requests", "bot_exclusion"];
export type AccessStatsAction = "access" | "refresh" | "logs";
export type AccessStatsOptions = { sourceId?: string; resourcePath?: string; from?: string; to?: string; cursor?: string; output?: string };

export function accessStatsSelection(action: AccessStatsAction, options: AccessStatsOptions) {
  const allowed = action === "access" ? ["sourceId", "resourcePath", "from", "to", "cursor"] :
    action === "refresh" ? ["sourceId", "from", "to"] : ["sourceId", "from", "to", "output"];
  if (Object.entries(options).some(([key, value]) => value !== undefined && !allowed.includes(key))) throw new Error("Unsupported access statistics options");
  if (options.sourceId !== undefined) sqliteAccessStatsDailyRequestSchema.shape.source_id.parse(options.sourceId);
  if (options.resourcePath !== undefined) sqliteAccessStatsDailyRequestSchema.shape.resource_path.parse(options.resourcePath);
  if (options.cursor !== undefined) sqliteAccessStatsDailyRequestSchema.shape.cursor.unwrap().parse(options.cursor);
  if (action !== "access" && !options.sourceId || action === "logs" && !options.output ||
    options.resourcePath && !options.sourceId || action === "access" && !options.resourcePath && (options.from !== undefined || options.to !== undefined)) {
    throw new Error("Refresh/logs require --source; logs also requires --output. Access dates require --source and --resource");
  }
  const today = new Date().toISOString().slice(0, 10), to = options.to ?? today;
  z.iso.date().parse(to);
  const from = options.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
  z.iso.date().parse(from);
  const days = (Date.parse(to) - Date.parse(from)) / DAY_MS + 1;
  if (days < 1 || days > 366 || to > today) throw new Error("Access statistics require 1 to 366 UTC dates ending no later than today");
  return { from_date_utc: from, to_date_utc: to };
}

async function sources(client: SqliteServiceClient, showId: string) {
  const first = await client.accessSources(showId), records = [...first.sources];
  let page = first;
  const cursors = new Set<string>();
  while (page.next_cursor !== null) {
    if (cursors.has(page.next_cursor)) throw new Error("Access statistics source pagination did not advance");
    cursors.add(page.next_cursor);
    page = await client.accessSources(showId, page.next_cursor); records.push(...page.sources);
  }
  return { ...first, sources: records };
}
async function resources(client: SqliteServiceClient, showId: string): Promise<Map<string, AccessStatsResource>> {
  const values = new Map<string, AccessStatsResource>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await client.accessResources(showId, cursor);
    for (const resource of page.resources) values.set(resource.resource_path, resource);
    if (page.next_cursor === null) return values;
    if (cursors.has(page.next_cursor)) throw new Error("Access statistics resource pagination did not advance");
    cursors.add(page.next_cursor); cursor = page.next_cursor;
  }
}
function logSource(root: string, config: SqliteServiceConfig, sourceId: string) {
  const saved = readLogpushConfiguration(root, config);
  const source = saved?.zones.flatMap((zone) => zone.sources).find((source) => source.source_id === sourceId);
  if (!saved || !source) throw new Error("No saved Logpush source; inspect logpush status for the configured source ID");
  return { saved, source, target: { accountId: config.account_id, bucketName: saved.bucket_name,
    serviceId: config.service_id, zoneId: source.zone_id, hostname: source.host } };
}

function mergedSource(previous: SqliteAccessStatsSource | undefined, observed: SqliteAccessStatsSource, enabled: boolean, at: number): SqliteAccessStatsSource {
  if (previous && previous.collection_started_at_ms !== observed.collection_started_at_ms) throw new Error("Saved Logpush collection start differs from the Show source");
  const intervals = new Map<string, SqliteAccessStatsSource["interruptions"][number]>();
  for (const entry of [...(previous?.interruptions ?? []), ...observed.interruptions]) {
    const key = `${entry.reason_code}:${entry.started_at_ms}`, old = intervals.get(key);
    intervals.set(key, { ...entry, ended_at_ms: old?.ended_at_ms === null || old?.ended_at_ms === undefined ? entry.ended_at_ms :
      entry.ended_at_ms === null ? old.ended_at_ms : Math.max(old.ended_at_ms, entry.ended_at_ms) });
  }
  const lastComplete = observed.last_complete_at_ms === null ? previous?.last_complete_at_ms ?? null :
    Math.max(previous?.last_complete_at_ms ?? 0, observed.last_complete_at_ms);
  for (const entry of intervals.values()) {
    if (entry.ended_at_ms !== null) continue;
    if (entry.reason_code === "job_disabled" && enabled && at > entry.started_at_ms) entry.ended_at_ms = at;
    if (entry.reason_code === "delivery_error" && lastComplete !== null && lastComplete > entry.started_at_ms) entry.ended_at_ms = lastComplete;
  }
  return sqliteAccessStatsSourceSchema.parse({ ...observed,
    collection_ended_at_ms: observed.collection_ended_at_ms ?? previous?.collection_ended_at_ms ?? null,
    last_complete_at_ms: lastComplete,
    interruptions: [...intervals.values()].sort((a, b) => a.started_at_ms - b.started_at_ms || a.reason_code.localeCompare(b.reason_code)) });
}

export async function readAccessStats(root: string, config: SqliteServiceConfig, showId: string, options: AccessStatsOptions, transport?: R2RestTransport) {
  const dates = accessStatsSelection("access", options);
  const client = new SqliteServiceClient(config, administratorKey(root), transport);
  validateId(showId, "show");
  if (!options.sourceId) return { view: "sources" as const, ...await client.accessSources(showId, options.cursor) };
  if (!options.resourcePath) {
    const source = (await sources(client, showId)).sources.find((entry) => entry.source.source_id === options.sourceId);
    if (!source) throw new Error("No saved access statistics source for this Show; refresh it first");
    return { view: "resources" as const, source, ...await client.accessResources(showId, options.cursor) };
  }
  return { view: "daily" as const, ...await client.accessDaily(showId, { source_id: options.sourceId,
    resource_path: options.resourcePath, ...dates, ...(options.cursor ? { cursor: options.cursor } : {}) }) };
}

export async function refreshAccessStats(root: string, config: SqliteServiceConfig, showId: string,
  options: AccessStatsOptions, cloudflare: R2RestOptions, transport = cloudflare.transport) {
  const dates = accessStatsSelection("refresh", options); validateId(showId, "show");
  const { source: configured, target } = logSource(root, config, options.sourceId!);
  const client = new SqliteServiceClient(config, administratorKey(root), transport);
  const health = await client.health(showId);
  if (!health.publication_ready) throw new Error("Access statistics refresh requires a ready Show");
  const saved = await sources(client, showId), previous = saved.sources.find((entry) => entry.source.source_id === configured.source_id);
  if (dates.from_date_utc < saved.retained_from_date_utc || dates.to_date_utc > saved.current_date_utc) throw new Error("Refresh dates must be inside the Show's current 400-day retention window");
  const approved = await resources(client, showId);
  if (!approved.size) throw new Error("No approved media resources for this Show");
  const observed = z.object({ configuration_matches: z.literal(true), job_enabled: z.boolean(), observed_at_ms: z.number(),
    sources: z.array(sqliteAccessStatsSourceSchema) }).safeParse(await runLogpushCommand(root, config, "status", { zoneId: configured.zone_id }, cloudflare));
  if (!observed.success) throw new Error("Logpush source configuration was not verified; inspect logpush status before refresh");
  const current = observed.data.sources.find((source) => source.source_id === configured.source_id)!;
  const source = mergedSource(previous?.source, current, observed.data.job_enabled, observed.data.observed_at_ms);
  const selectedDates: string[] = [], skippedDates: string[] = [];
  for (let at = Date.parse(`${dates.from_date_utc}T00:00:00Z`); at <= Date.parse(`${dates.to_date_utc}T00:00:00Z`); at += DAY_MS) {
    const date = new Date(at).toISOString().slice(0, 10);
    (at + DAY_MS > source.collection_started_at_ms && at < (source.collection_ended_at_ms ?? Infinity) ? selectedDates : skippedDates).push(date);
  }
  if (!selectedDates.length) throw new Error("Refresh dates do not overlap the source collection period");
  const versions = new Map<string, number>();
  if (previous) for (const path of approved.keys()) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (;;) {
      const page = await client.accessDaily(showId, { source_id: source.source_id, resource_path: path, ...dates, ...(cursor ? { cursor } : {}) });
      for (const day of page.days) if (day.record) versions.set(`${day.date_utc}:${path}`, day.record.version);
      if (page.next_cursor === null) break;
      if (cursors.has(page.next_cursor)) throw new Error("Access statistics daily pagination did not advance");
      cursors.add(page.next_cursor); cursor = page.next_cursor;
    }
  }
  const events: AccessStatsEvent[] = [], times = new Map<string, { min: number; max: number }>();
  const readAt = Date.now();
  const summary = await readHttpLogpushLogs(root, target, { showId, fromDateUtc: dates.from_date_utc, toDateUtc: dates.to_date_utc }, approved, (event) => {
    events.push(event);
    const key = `${new Date(event.occurred_at_ms).toISOString().slice(0, 10)}:${event.resource_path}`, range = times.get(key);
    times.set(key, { min: Math.min(range?.min ?? Infinity, event.occurred_at_ms), max: Math.max(range?.max ?? 0, event.occurred_at_ms) });
  }, cloudflare);
  const aggregated = new Map(aggregateAccessStats(events).map((daily) => [`${daily.date_utc}:${daily.resource_path}`, daily]));
  const filesByDate = new Map<string, string>(), index = new AccessLogFileIndex(root);
  try {
    const files = summary.inputFiles.map((file) => ({ file, range: index.get(target, file)! }));
    for (const date of selectedDates) {
      const at = Date.parse(`${date}T00:00:00Z`);
      filesByDate.set(date, sha256HexSync(JSON.stringify(files.filter(({ range }) =>
        range.minOccurredAtMs !== null && range.maxOccurredAtMs !== null && range.minOccurredAtMs < at + DAY_MS && range.maxOccurredAtMs >= at).map(({ file }) => file))));
    }
  } finally { index.close(); }
  let sourceVersion = previous?.version ?? 0, sourceRecord: SqliteAccessStatsSourceRecord | undefined;
  let changed = 0, unchanged = 0;
  const configHash = await sqliteServiceConfigHash(config);
  for (const date of selectedDates) for (const resource of approved.values()) {
    const key = `${date}:${resource.resource_path}`;
    const daily: AccessStatsDaily = aggregated.get(key) ?? { ...resource, source_id: source.source_id, date_utc: date, format: ACCESS_STATS_FORMAT,
      counters: { get_200_requests: 0, get_206_requests: 0, head_requests: 0, not_modified_requests: 0, response_bytes: 0, cache_status_requests: {} } };
    const range = times.get(key);
    const inputHash = sha256HexSync(JSON.stringify({ account_id: config.account_id, bucket_name: target.bucketName,
      service_id: config.service_id, files_sha256: filesByDate.get(date), daily }));
    const request = sqliteAccessStatsReplaceRequestSchema.parse({ service_id: config.service_id, service_config_sha256: configHash, show_id: showId,
      source, expected_source_version: sourceVersion, daily, expected_version: versions.get(key) ?? 0, input_sha256: inputHash,
      read_at_ms: readAt, input_min_at_ms: range?.min ?? null, input_max_at_ms: range?.max ?? null });
    const result = await client.replaceAccessDaily(request);
    sourceVersion = result.source.version; sourceRecord = result.source;
    if (result.result === "changed") changed++; else unchanged++;
  }
  return { result: "access-stats-refreshed", format: ACCESS_STATS_FORMAT, service_id: config.service_id, show_id: showId, ...dates,
    source: sourceRecord!, read_at_ms: readAt, changed, unchanged, input_file_count: summary.inputFiles.length,
    skipped_collection_dates_utc: skippedDates, new_outside_dates_utc: summary.newOutsideDatesUtc, unsupported_metrics: UNSUPPORTED_METRICS };
}

export async function exportAccessLogs(root: string, config: SqliteServiceConfig, showId: string,
  options: AccessStatsOptions, cloudflare: R2RestOptions, transport = cloudflare.transport) {
  const dates = accessStatsSelection("logs", options); validateId(showId, "show");
  const { source, target } = logSource(root, config, options.sourceId!);
  const client = new SqliteServiceClient(config, administratorKey(root), transport);
  const approved = await resources(client, showId);
  const output = resolve(options.output!);
  assertRealParentDirectories(output, "Access log export");
  const fd = openSync(output, "wx", 0o600);
  let complete = false, count = 0;
  try {
    const summary = await readHttpLogpushLogs(root, target, { showId, fromDateUtc: dates.from_date_utc, toDateUtc: dates.to_date_utc }, approved, (event) => {
      const line = Buffer.from(`${JSON.stringify(event)}\n`);
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
      count++;
    }, cloudflare);
    fsyncSync(fd); syncLocalJournalDirectory(dirname(output)); complete = true;
    return { result: "access-logs-exported", format: "access-event-ndjson-v1", service_id: config.service_id, show_id: showId,
      source, ...dates, output, record_count: count, includes_delivery_duplicates: true,
      input_file_count: summary.inputFiles.length, new_outside_dates_utc: summary.newOutsideDatesUtc };
  } finally {
    closeSync(fd);
    if (!complete) { unlinkSync(output); syncLocalJournalDirectory(dirname(output)); }
  }
}

const accessViewSchema = z.discriminatedUnion("view", [sqliteAccessStatsSourcesResponseSchema.extend({ view: z.literal("sources") }),
  sqliteAccessStatsResourcesResponseSchema.extend({ view: z.literal("resources"), source: sqliteAccessStatsSourceRecordSchema }),
  sqliteAccessStatsDailyResponseSchema.extend({ view: z.literal("daily") })]);

export function formatAccessStats(input: unknown): string {
  const value = accessViewSchema.parse(input), lines = [`Access statistics for Show ${value.show_id}`,
    `Definition: ${ACCESS_STATS_FORMAT}; edge_body; best_effort; bots included`,
    `Unsupported metrics: ${UNSUPPORTED_METRICS.join(", ")}`,
    `Daily retention: ${value.retention_days} days (from ${value.retained_from_date_utc}, UTC)`];
  if (value.view === "sources") {
    lines.push("", "SOURCE_ID\tSTARTED_AT\tLAST_DELIVERY");
    for (const { source } of value.sources) lines.push(`${source.source_id}\t${new Date(source.collection_started_at_ms).toISOString()}\t${source.last_complete_at_ms === null ? "-" : new Date(source.last_complete_at_ms).toISOString()}`);
    if (!value.sources.length) lines.push("No saved sources. Use logpush status for the configured source ID, then stats refresh SHOW --source ID.");
  } else {
    lines.push(`Source: ${value.source.source.source_id}`);
    lines.push(`Collection: ${new Date(value.source.source.collection_started_at_ms).toISOString()} .. ${value.source.source.collection_ended_at_ms === null ? "ongoing" : new Date(value.source.source.collection_ended_at_ms).toISOString()}`);
    lines.push(`Known interruptions: ${JSON.stringify(value.source.source.interruptions)}`);
    if (value.view === "resources") {
      lines.push("", "KIND\tRESOURCE_PATH");
      for (const resource of value.resources) lines.push(`${resource.resource_kind}\t${resource.resource_path}`);
    } else {
      lines.push(`Resource: ${value.resource.resource_path}`, `UTC dates: ${value.from_date_utc} .. ${value.to_date_utc}; coverage: ${value.coverage}`,
        `Period counters: ${value.period === null ? "unmeasured" : JSON.stringify(value.period)}`, "",
        "DATE_UTC\tCOVERAGE\tGET_200\tGET_206\tHEAD\t304\tBODY_BYTES\tREAD_AT\tAPPLIED_AT");
      for (const day of value.days) {
        const record = day.record, c = record?.daily.counters;
        lines.push(`${day.date_utc}\t${day.coverage}\t${c?.get_200_requests ?? "-"}\t${c?.get_206_requests ?? "-"}\t${c?.head_requests ?? "-"}\t${c?.not_modified_requests ?? "-"}\t${c?.response_bytes ?? "-"}\t${record ? new Date(record.read_at_ms).toISOString() : "-"}\t${record ? new Date(record.applied_at_ms).toISOString() : "-"}`);
      }
    }
  }
  if (value.next_cursor) lines.push("", `Next page: --cursor ${value.next_cursor}`);
  return lines.join("\n");
}
