import { z } from "zod";
import { ACCESS_STATS_FORMAT, accessStatsCountersSchema } from "../packages/shared/src/access-stats";
import type { AccessStatsCounters, AccessStatsResource } from "../packages/shared/src/access-stats";
import { MAX_SQLITE_ACCESS_STATS_RESPONSE_BYTES, SQLITE_ACCESS_STATS_DAILY_PAGE_SIZE, SQLITE_ACCESS_STATS_PAGE_SIZE,
  SQLITE_ACCESS_STATS_RETENTION_DAYS, sqliteAccessStatsSourceRecordSchema, sqliteAccessStatsSourceSchema,
  sqliteAccessStatsStoredDailySchema } from "../packages/shared/src/sqlite-access-stats";
import type { SqliteAccessStatsCoverage, SqliteAccessStatsDailyRequest, SqliteAccessStatsDailyResponse,
  SqliteAccessStatsDay, SqliteAccessStatsReplaceRequest, SqliteAccessStatsReplaceResponse,
  SqliteAccessStatsResourcesRequest, SqliteAccessStatsResourcesResponse, SqliteAccessStatsSource,
  SqliteAccessStatsSourceRecord, SqliteAccessStatsSourcesRequest, SqliteAccessStatsSourcesResponse,
  SqliteAccessStatsStoredDaily } from "../packages/shared/src/sqlite-access-stats";
import { parsePublicAssetPath } from "../packages/shared/src/public-assets";
import { sqlitePublicationProtocol } from "../packages/shared/src/sqlite-publication";
import type { SqliteServiceIdentity } from "../packages/shared/src/sqlite-publication";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { ensureSchemaVersionTable } from "./sqlite-publication-queue";
import type { PublicationQueueStorage, SqlitePublicationQueue } from "./sqlite-publication-queue";

const DAY_MS = 86_400_000;
const PRUNE_BATCH_ROWS = 200;
const cursorSchema = z.object({ context: z.string(), after: z.string().min(1).max(320) }).strict();
type SourceRow = { source_json: string; version: number; updated_at_ms: number };
type DailyRow = { source_id: string; date_utc: string; resource_path: string; resource_kind: "audio" | "cover";
  episode_id: string | null; audio_revision_id: string | null; counters_json: string; version: number;
  input_sha256: string; read_at_ms: number; input_min_at_ms: number | null; input_max_at_ms: number | null; applied_at_ms: number };

export class SqliteAccessStatsInputError extends Error {
  constructor() { super("Invalid access statistics query"); }
}
export class SqliteAccessStatsConflict extends Error {
  constructor() { super("Access statistics configuration, target or version differs"); }
}

function dateUtc(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function jsonBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function countersJson(value: AccessStatsCounters): string {
  return JSON.stringify({ ...value, cache_status_requests: Object.fromEntries(
    Object.entries(value.cache_status_requests).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) });
}
function pageCount(items: readonly unknown[], emptyResponse: object): number {
  let remaining = MAX_SQLITE_ACCESS_STATS_RESPONSE_BYTES - jsonBytes({ ...emptyResponse, next_cursor: "x".repeat(2048) });
  let count = 0;
  for (const item of items) {
    const bytes = jsonBytes(item) + (count > 0 ? 1 : 0);
    if (bytes > remaining) break;
    remaining -= bytes;
    count++;
  }
  if (items.length && !count) throw new Error("Access statistics entry exceeds its response budget");
  return count;
}

export class SqliteAccessStats {
  constructor(private readonly storage: PublicationQueueStorage, readonly showId: string,
    private readonly queue: SqlitePublicationQueue, private readonly config: SqliteServiceConfig,
    private readonly now: () => number = Date.now) {
    storage.transactionSync(() => {
      ensureSchemaVersionTable(storage, "publication_access_stats_schema", 1,
        "Unsupported access statistics schema; do not reset stored statistics");
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_access_stats_sources (
        source_id TEXT PRIMARY KEY NOT NULL, source_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0), updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_access_daily_stats (
        source_id TEXT NOT NULL, date_utc TEXT NOT NULL CHECK(length(date_utc) = 10), resource_path TEXT NOT NULL,
        resource_kind TEXT NOT NULL CHECK(resource_kind IN ('audio', 'cover')), episode_id TEXT, audio_revision_id TEXT,
        counters_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), input_sha256 TEXT NOT NULL,
        read_at_ms INTEGER NOT NULL CHECK(read_at_ms >= 0), input_min_at_ms INTEGER, input_max_at_ms INTEGER,
        applied_at_ms INTEGER NOT NULL CHECK(applied_at_ms >= 0),
        PRIMARY KEY(source_id, date_utc, resource_path)
      ) WITHOUT ROWID`);
      storage.sql.exec("CREATE INDEX IF NOT EXISTS publication_access_daily_resource ON publication_access_daily_stats (source_id, resource_path, date_utc)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS publication_access_daily_expiry ON publication_access_daily_stats (date_utc)");
    });
  }

  private assertTarget(request: SqliteServiceIdentity & { show_id: string }): void {
    const identity = this.queue.identity();
    if (request.service_id !== identity.service_id || request.service_config_sha256 !== identity.service_config_sha256 ||
      request.show_id !== this.showId) throw new SqliteAccessStatsConflict();
  }
  private common(now: number) {
    return { ...this.queue.identity(), protocol: sqlitePublicationProtocol, format: ACCESS_STATS_FORMAT,
      show_id: this.showId, retention_days: SQLITE_ACCESS_STATS_RETENTION_DAYS, current_date_utc: dateUtc(now),
      retained_from_date_utc: dateUtc(Date.parse(`${dateUtc(now)}T00:00:00Z`) - (SQLITE_ACCESS_STATS_RETENTION_DAYS - 1) * DAY_MS) };
  }
  private sourceRow(sourceId: string): SourceRow | null {
    return this.storage.sql.exec<SourceRow>("SELECT source_json, version, updated_at_ms FROM publication_access_stats_sources WHERE source_id = ?", sourceId).toArray()[0] ?? null;
  }
  private sourceRecord(row: SourceRow): SqliteAccessStatsSourceRecord {
    return sqliteAccessStatsSourceRecordSchema.parse({ source: JSON.parse(row.source_json), version: row.version, updated_at_ms: row.updated_at_ms });
  }
  private storedDaily(row: DailyRow): SqliteAccessStatsStoredDaily {
    return sqliteAccessStatsStoredDailySchema.parse({ daily: { format: ACCESS_STATS_FORMAT, source_id: row.source_id,
      show_id: this.showId, date_utc: row.date_utc, resource_path: row.resource_path, resource_kind: row.resource_kind,
      episode_id: row.episode_id, audio_revision_id: row.audio_revision_id, counters: JSON.parse(row.counters_json) },
    version: row.version, input_sha256: row.input_sha256, read_at_ms: row.read_at_ms,
    input_min_at_ms: row.input_min_at_ms, input_max_at_ms: row.input_max_at_ms, applied_at_ms: row.applied_at_ms });
  }
  private resource(path: string): AccessStatsResource {
    const asset = parsePublicAssetPath(path);
    if (!asset || asset.kind === "feed" || asset.showId !== this.showId) throw new SqliteAccessStatsConflict();
    if (asset.kind === "audio") {
      if (!this.storage.sql.exec("SELECT audio_revision_id FROM publication_media WHERE show_id = ? AND episode_id = ? AND audio_revision_id = ?",
        this.showId, asset.episodeId, asset.revisionId).toArray().length) throw new SqliteAccessStatsConflict();
      return { show_id: this.showId, resource_path: path, resource_kind: "audio", episode_id: asset.episodeId, audio_revision_id: asset.revisionId };
    }
    const cover = this.storage.sql.exec<{ cover_extension: string }>("SELECT cover_extension FROM publication_show_content WHERE show_id = ?", this.showId).toArray()[0];
    if (!cover || path !== `/podcasts/${this.showId}/cover.${cover.cover_extension}`) throw new SqliteAccessStatsConflict();
    return { show_id: this.showId, resource_path: path, resource_kind: "cover", episode_id: null, audio_revision_id: null };
  }
  private admitSource(source: SqliteAccessStatsSource): void {
    if (source.host === new URL(this.config.public_base_url).hostname && this.config.public_base_url !== this.config.workers_dev_base_url) return;
    const saved = this.storage.sql.exec(`SELECT operation_id FROM publication_domain_changes WHERE state = 'completed'
      AND json_extract(request_json, '$.hostname') = ? AND json_extract(request_json, '$.zone_id') = ? LIMIT 1`,
    source.host, source.zone_id).toArray();
    if (!saved.length) throw new SqliteAccessStatsConflict();
  }
  private cursorContext(route: string, query: object, retainedFrom: string): string {
    const identity = this.queue.identity();
    return JSON.stringify({ service_id: identity.service_id, service_config_sha256: identity.service_config_sha256,
      show_id: this.showId, retained_from_date_utc: retainedFrom, route, ...query });
  }
  private after(cursor: string | undefined, context: string): string {
    if (cursor === undefined) return "";
    let decoded: z.infer<typeof cursorSchema>;
    try { decoded = cursorSchema.parse(JSON.parse(atob(cursor))); }
    catch { throw new SqliteAccessStatsInputError(); }
    if (decoded.context !== context) throw new SqliteAccessStatsConflict();
    return decoded.after;
  }
  private cursor(after: string, context: string): string { return btoa(JSON.stringify({ context, after })); }

  async replace(request: SqliteAccessStatsReplaceRequest): Promise<SqliteAccessStatsReplaceResponse> {
    const result = this.storage.transactionSync(() => {
      this.assertTarget(request);
      const now = this.now(), common = this.common(now), daily = request.daily;
      if (daily.date_utc < common.retained_from_date_utc || daily.date_utc > common.current_date_utc) throw new SqliteAccessStatsConflict();
      this.resource(daily.resource_path);
      const dayStart = Date.parse(`${daily.date_utc}T00:00:00Z`);
      if (dayStart + DAY_MS <= request.source.collection_started_at_ms ||
        request.source.collection_ended_at_ms !== null && dayStart >= request.source.collection_ended_at_ms) throw new SqliteAccessStatsConflict();
      const oldSource = this.sourceRow(request.source.source_id), sourceJson = JSON.stringify(request.source);
      const sourceChanged = oldSource?.source_json !== sourceJson;
      if (!oldSource) this.admitSource(request.source);
      else {
        const previous = sqliteAccessStatsSourceSchema.parse(JSON.parse(oldSource.source_json));
        if (previous.collection_started_at_ms !== request.source.collection_started_at_ms) throw new SqliteAccessStatsConflict();
      }
      if (sourceChanged && request.expected_source_version !== (oldSource?.version ?? 0)) throw new SqliteAccessStatsConflict();
      const old = this.storage.sql.exec<DailyRow>(`SELECT * FROM publication_access_daily_stats
        WHERE source_id = ? AND date_utc = ? AND resource_path = ?`, daily.source_id, daily.date_utc, daily.resource_path).toArray()[0];
      const counters = countersJson(daily.counters);
      const dailyChanged = !old || old.input_sha256 !== request.input_sha256 || old.counters_json !== counters ||
        old.input_min_at_ms !== request.input_min_at_ms || old.input_max_at_ms !== request.input_max_at_ms;
      if (dailyChanged && request.expected_version !== (old?.version ?? 0)) throw new SqliteAccessStatsConflict();
      const source = { source: request.source, version: (oldSource?.version ?? 0) + (sourceChanged ? 1 : 0),
        updated_at_ms: sourceChanged ? now : oldSource!.updated_at_ms };
      if (sourceChanged) this.storage.sql.exec(`INSERT INTO publication_access_stats_sources (source_id, source_json, version, updated_at_ms)
        VALUES (?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET source_json = excluded.source_json,
        version = excluded.version, updated_at_ms = excluded.updated_at_ms`, request.source.source_id, sourceJson, source.version, now);
      const readAt = Math.max(old?.read_at_ms ?? 0, request.read_at_ms);
      const record: SqliteAccessStatsStoredDaily = { daily: { ...daily, counters: JSON.parse(counters) },
        version: (old?.version ?? 0) + (dailyChanged ? 1 : 0), input_sha256: request.input_sha256, read_at_ms: readAt,
        input_min_at_ms: request.input_min_at_ms, input_max_at_ms: request.input_max_at_ms,
        applied_at_ms: dailyChanged || readAt !== old!.read_at_ms ? now : old!.applied_at_ms };
      if (dailyChanged || readAt !== old!.read_at_ms) this.storage.sql.exec(`INSERT INTO publication_access_daily_stats
        (source_id, date_utc, resource_path, resource_kind, episode_id, audio_revision_id, counters_json, version,
         input_sha256, read_at_ms, input_min_at_ms, input_max_at_ms, applied_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, date_utc, resource_path) DO UPDATE SET
        counters_json = excluded.counters_json, version = excluded.version, input_sha256 = excluded.input_sha256,
        read_at_ms = excluded.read_at_ms, input_min_at_ms = excluded.input_min_at_ms,
        input_max_at_ms = excluded.input_max_at_ms, applied_at_ms = excluded.applied_at_ms`,
      daily.source_id, daily.date_utc, daily.resource_path, daily.resource_kind, daily.episode_id, daily.audio_revision_id,
      counters, record.version, request.input_sha256, readAt, request.input_min_at_ms, request.input_max_at_ms, record.applied_at_ms);
      this.storage.sql.exec(`DELETE FROM publication_access_daily_stats WHERE (source_id, date_utc, resource_path) IN
        (SELECT source_id, date_utc, resource_path FROM publication_access_daily_stats
         WHERE date_utc < ? ORDER BY date_utc LIMIT ?)`, common.retained_from_date_utc, PRUNE_BATCH_ROWS);
      return { ...common, result: sourceChanged || dailyChanged ? "changed" as const : "unchanged" as const, source, record };
    });
    await this.storage.sync();
    return result;
  }

  sources(request: SqliteAccessStatsSourcesRequest): SqliteAccessStatsSourcesResponse {
    this.assertTarget(request);
    const common = this.common(this.now()), context = this.cursorContext("sources", {}, common.retained_from_date_utc);
    const after = this.after(request.cursor, context);
    const rows = this.storage.sql.exec<SourceRow>(`SELECT source_json, version, updated_at_ms FROM publication_access_stats_sources
      WHERE source_id > ? ORDER BY source_id LIMIT ?`, after, SQLITE_ACCESS_STATS_PAGE_SIZE + 1).toArray();
    const sources = rows.slice(0, SQLITE_ACCESS_STATS_PAGE_SIZE).map((row) => this.sourceRecord(row));
    const count = pageCount(sources, { ...common, sources: [] });
    return { ...common, sources: sources.slice(0, count),
      next_cursor: rows.length > count ? this.cursor(sources[count - 1]!.source.source_id, context) : null };
  }

  resources(request: SqliteAccessStatsResourcesRequest): SqliteAccessStatsResourcesResponse {
    this.assertTarget(request);
    const common = this.common(this.now()), context = this.cursorContext("resources", {}, common.retained_from_date_utc), after = this.after(request.cursor, context);
    const rows = this.storage.sql.exec<{ resource_path: string }>(`SELECT resource_path FROM (
      SELECT '/podcasts/' || show_id || '/episodes/' || episode_id || '/' || audio_revision_id || '.mp3' AS resource_path
        FROM publication_media WHERE show_id = ?
      UNION ALL SELECT '/podcasts/' || show_id || '/cover.' || cover_extension AS resource_path
        FROM publication_show_content WHERE show_id = ?)
      WHERE resource_path > ? ORDER BY resource_path LIMIT ?`, this.showId, this.showId, after, SQLITE_ACCESS_STATS_PAGE_SIZE + 1).toArray();
    const resources = rows.slice(0, SQLITE_ACCESS_STATS_PAGE_SIZE).map((row) => this.resource(row.resource_path));
    return { ...common, resources, next_cursor: rows.length > resources.length ? this.cursor(resources.at(-1)!.resource_path, context) : null };
  }

  private coverage(date: string, source: SqliteAccessStatsSource, record: SqliteAccessStatsStoredDaily | undefined,
    retainedFrom: string, now: number): SqliteAccessStatsCoverage {
    if (date < retainedFrom) return "pruned";
    if (!record) return "unmeasured";
    const start = Date.parse(`${date}T00:00:00Z`), end = start + DAY_MS;
    if (source.collection_started_at_ms > start || (source.collection_ended_at_ms ?? Infinity) < end ||
      Math.min(now, record.read_at_ms) < end || source.interruptions.some((entry) =>
        entry.started_at_ms < end && (entry.ended_at_ms ?? Infinity) > start)) return "partial";
    return "observed";
  }

  daily(request: SqliteAccessStatsDailyRequest): SqliteAccessStatsDailyResponse {
    this.assertTarget(request);
    const now = this.now(), common = this.common(now);
    if (request.to_date_utc > common.current_date_utc) throw new SqliteAccessStatsInputError();
    const row = this.sourceRow(request.source_id);
    if (!row) throw new SqliteAccessStatsConflict();
    const source = this.sourceRecord(row), resource = this.resource(request.resource_path);
    const context = this.cursorContext("daily", { source_id: request.source_id, source_version: source.version,
      resource_path: request.resource_path, from_date_utc: request.from_date_utc, to_date_utc: request.to_date_utc }, common.retained_from_date_utc);
    const after = this.after(request.cursor, context);
    if (after && (after < request.from_date_utc || after >= request.to_date_utc || !z.iso.date().safeParse(after).success)) throw new SqliteAccessStatsInputError();
    const rows = this.storage.sql.exec<DailyRow>(`SELECT * FROM publication_access_daily_stats WHERE source_id = ? AND resource_path = ?
      AND date_utc >= ? AND date_utc <= ? ORDER BY date_utc`, request.source_id, request.resource_path,
    request.from_date_utc < common.retained_from_date_utc ? common.retained_from_date_utc : request.from_date_utc, request.to_date_utc).toArray();
    const records = new Map(rows.map((entry) => [entry.date_utc, this.storedDaily(entry)]));
    const allDays: SqliteAccessStatsDay[] = [];
    for (let at = Date.parse(`${request.from_date_utc}T00:00:00Z`); at <= Date.parse(`${request.to_date_utc}T00:00:00Z`); at += DAY_MS) {
      const date = dateUtc(at), record = records.get(date);
      allDays.push({ date_utc: date, coverage: this.coverage(date, source.source, record, common.retained_from_date_utc, now), record: record ?? null });
    }
    const total: AccessStatsCounters = { get_200_requests: 0, get_206_requests: 0, head_requests: 0,
      not_modified_requests: 0, response_bytes: 0, cache_status_requests: {} };
    const cache = new Map<string, number>();
    for (const record of records.values()) {
      const value = record.daily.counters;
      total.get_200_requests += value.get_200_requests; total.get_206_requests += value.get_206_requests;
      total.head_requests += value.head_requests; total.not_modified_requests += value.not_modified_requests;
      total.response_bytes += value.response_bytes;
      for (const [key, count] of Object.entries(value.cache_status_requests)) cache.set(key, (cache.get(key) ?? 0) + count);
    }
    total.cache_status_requests = Object.fromEntries([...cache].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const coverage: SqliteAccessStatsCoverage = allDays.every((day) => day.coverage === "pruned") ? "pruned" :
      !records.size ? "unmeasured" : allDays.every((day) => day.coverage === "observed") ? "observed" : "partial";
    const base = { ...common, source, resource, from_date_utc: request.from_date_utc, to_date_utc: request.to_date_utc,
      coverage, period: records.size ? accessStatsCountersSchema.parse(total) : null };
    const candidates = allDays.filter((day) => day.date_utc > after).slice(0, SQLITE_ACCESS_STATS_DAILY_PAGE_SIZE);
    const count = pageCount(candidates, { ...base, days: [] });
    const days = candidates.slice(0, count), last = days.at(-1)!.date_utc;
    return { ...base, days, next_cursor: last < request.to_date_utc ? this.cursor(last, context) : null };
  }
}
