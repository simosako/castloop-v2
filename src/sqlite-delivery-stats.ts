import { sqliteDeliveryObservationSchema, sqliteStatsCoverageSchema, sqliteStatsDailyCursorSchema,
  sqliteStatsEpisodesCursorSchema, sqliteStatsRetentionRecordSchema, sqliteStatsRetentionRequestSchema,
  SQLITE_STATS_DAILY_PAGE_SIZE, SQLITE_STATS_DEFAULT_WINDOW_DAYS, SQLITE_STATS_EPISODE_PAGE_SIZE,
  SQLITE_STATS_INITIAL_RANGE_BYTES, SQLITE_STATS_MAX_WINDOW_DAYS, SQLITE_STATS_RETENTION_DEFAULT_DAYS } from "../packages/shared/src/sqlite-stats";
import type { SqliteDeliveryObservation, SqliteStatsCoverage, SqliteStatsCounters,
  SqliteStatsDailyEntry, SqliteStatsEpisodeSummary, SqliteStatsRetentionRecord } from "../packages/shared/src/sqlite-stats";
import { sha256Hex } from "../packages/shared/src/sha256";
import { sqlitePublicationTargetSchema } from "../packages/shared/src/sqlite-publication";
import type { SqliteServiceIdentity } from "../packages/shared/src/sqlite-publication";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";

export const SQLITE_DELIVERY_STATS_SCHEMA_VERSION = 1;
const SQLITE_STATS_PRUNE_BATCH_ROWS = 200;

type MetaRow = {
  measurement_started_at_ms: number;
  measurement_started_date_utc: string;
  retained_from_date_utc: string;
  retention_days: number;
  last_pruned_date_utc: string | null;
  recording_error_count: number;
  last_recording_error_at_ms: number | null;
};
type RawCounterRow = {
  episode_id: string;
  audio_revision_id: string;
  get_200_requests: number;
  get_206_requests: number;
  initial_downloads: number;
  response_bytes: number;
  probe_range_requests: number;
  head_requests: number;
  not_modified_requests: number;
  bot_get_requests: number;
  bot_response_bytes: number;
};
type TotalCounterRow = Omit<RawCounterRow, "episode_id">;

export type SqliteDeliveryCounterDelta = {
  get_200_requests: number; get_206_requests: number; initial_downloads: number; response_bytes: number;
  probe_range_requests: number; head_requests: number; not_modified_requests: number;
  bot_get_requests: number; bot_response_bytes: number;
};

// Classifies one finalized public audio response into deterministic counter deltas.
// No listener identity is involved; audioLengthBytes comes from the approved media index.
export function sqliteDeliveryCounterDelta(observation: SqliteDeliveryObservation, audioLengthBytes: number): SqliteDeliveryCounterDelta {
  const zero: SqliteDeliveryCounterDelta = { get_200_requests: 0, get_206_requests: 0, initial_downloads: 0, response_bytes: 0,
    probe_range_requests: 0, head_requests: 0, not_modified_requests: 0, bot_get_requests: 0, bot_response_bytes: 0 };
  if (observation.method === "HEAD") return { ...zero, head_requests: 1 };
  if (observation.status === 304) return { ...zero, not_modified_requests: 1 };
  if (observation.bot) return { ...zero, bot_get_requests: 1, bot_response_bytes: observation.content_length };
  if (observation.status === 200) {
    return { ...zero, get_200_requests: 1, initial_downloads: 1, response_bytes: observation.content_length };
  }
  const threshold = Math.min(SQLITE_STATS_INITIAL_RANGE_BYTES, audioLengthBytes);
  const startsAtBeginning = observation.range_offset === 0;
  return { ...zero, get_206_requests: 1, initial_downloads: startsAtBeginning && observation.content_length >= threshold ? 1 : 0,
    response_bytes: observation.content_length,
    probe_range_requests: startsAtBeginning && observation.content_length < threshold ? 1 : 0 };
}

function utcDateFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function shiftUtcDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}
function diffUtcDays(from: string, to: string): number {
  const [yearA, monthA, dayA] = from.split("-").map(Number);
  const [yearB, monthB, dayB] = to.split("-").map(Number);
  return Math.round((Date.UTC(yearB!, monthB! - 1, dayB!) - Date.UTC(yearA!, monthA! - 1, dayA!)) / 86_400_000);
}
function startOfDayMs(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!);
}
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class SqliteDeliveryStats {
  constructor(private readonly storage: PublicationQueueStorage, private readonly showId: string,
    private readonly identity: SqliteServiceIdentity, private readonly now: () => number = Date.now) {
    sqlitePublicationTargetSchema.shape.show_id.parse(showId);
    storage.transactionSync(() => {
      const queue = storage.sql.exec<{ version: number }>("SELECT version FROM publication_queue_schema WHERE id = 1").toArray()[0];
      const content = storage.sql.exec<{ version: number }>("SELECT version FROM publication_content_schema WHERE id = 1").toArray()[0];
      if (!queue || !content) throw new Error("Initialize the publication schemas before delivery statistics");
      storage.sql.exec("CREATE TABLE IF NOT EXISTS publication_delivery_stats_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)");
      const schema = storage.sql.exec<{ version: number }>("SELECT version FROM publication_delivery_stats_schema WHERE id = 1").toArray()[0];
      if (schema && schema.version !== SQLITE_DELIVERY_STATS_SCHEMA_VERSION) throw new Error("Unsupported delivery statistics schema; do not reset stored statistics");
      storage.sql.exec("INSERT OR IGNORE INTO publication_delivery_stats_schema (id, version) VALUES (1, ?)", SQLITE_DELIVERY_STATS_SCHEMA_VERSION);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_delivery_stats_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        measurement_started_at_ms INTEGER NOT NULL CHECK (measurement_started_at_ms >= 0),
        measurement_started_date_utc TEXT NOT NULL CHECK (length(measurement_started_date_utc) = 10),
        retained_from_date_utc TEXT NOT NULL CHECK (length(retained_from_date_utc) = 10),
        last_pruned_date_utc TEXT CHECK (last_pruned_date_utc IS NULL OR length(last_pruned_date_utc) = 10),
        retention_days INTEGER NOT NULL DEFAULT ${SQLITE_STATS_RETENTION_DEFAULT_DAYS} CHECK (retention_days BETWEEN 30 AND 3650),
        recording_error_count INTEGER NOT NULL DEFAULT 0 CHECK (recording_error_count >= 0),
        last_recording_error_at_ms INTEGER CHECK (last_recording_error_at_ms IS NULL OR last_recording_error_at_ms >= 0)
      )`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_episode_daily_stats (
        episode_id TEXT NOT NULL,
        date_utc TEXT NOT NULL CHECK (length(date_utc) = 10),
        audio_revision_id TEXT NOT NULL,
        get_200_requests INTEGER NOT NULL DEFAULT 0 CHECK (get_200_requests >= 0),
        get_206_requests INTEGER NOT NULL DEFAULT 0 CHECK (get_206_requests >= 0),
        initial_downloads INTEGER NOT NULL DEFAULT 0 CHECK (initial_downloads >= 0),
        response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
        probe_range_requests INTEGER NOT NULL DEFAULT 0 CHECK (probe_range_requests >= 0),
        head_requests INTEGER NOT NULL DEFAULT 0 CHECK (head_requests >= 0),
        not_modified_requests INTEGER NOT NULL DEFAULT 0 CHECK (not_modified_requests >= 0),
        bot_get_requests INTEGER NOT NULL DEFAULT 0 CHECK (bot_get_requests >= 0),
        bot_response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (bot_response_bytes >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (episode_id, date_utc, audio_revision_id)
      ) WITHOUT ROWID`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_episode_pruned_totals (
        episode_id TEXT NOT NULL,
        audio_revision_id TEXT NOT NULL,
        get_200_requests INTEGER NOT NULL DEFAULT 0 CHECK (get_200_requests >= 0),
        get_206_requests INTEGER NOT NULL DEFAULT 0 CHECK (get_206_requests >= 0),
        initial_downloads INTEGER NOT NULL DEFAULT 0 CHECK (initial_downloads >= 0),
        response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
        probe_range_requests INTEGER NOT NULL DEFAULT 0 CHECK (probe_range_requests >= 0),
        head_requests INTEGER NOT NULL DEFAULT 0 CHECK (head_requests >= 0),
        not_modified_requests INTEGER NOT NULL DEFAULT 0 CHECK (not_modified_requests >= 0),
        bot_get_requests INTEGER NOT NULL DEFAULT 0 CHECK (bot_get_requests >= 0),
        bot_response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (bot_response_bytes >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
        PRIMARY KEY (episode_id, audio_revision_id)
      ) WITHOUT ROWID`);
      const started = this.now();
      storage.sql.exec(`INSERT OR IGNORE INTO publication_delivery_stats_meta
        (id, measurement_started_at_ms, measurement_started_date_utc, retained_from_date_utc, retention_days)
        VALUES (1, ?, ?, ?, ${SQLITE_STATS_RETENTION_DEFAULT_DAYS})`,
      started, utcDateFromMs(started), utcDateFromMs(started));
    });
  }

  meta(): MetaRow {
    const row = this.storage.sql.exec<MetaRow>("SELECT measurement_started_at_ms, measurement_started_date_utc, retained_from_date_utc, retention_days, last_pruned_date_utc, recording_error_count, last_recording_error_at_ms FROM publication_delivery_stats_meta WHERE id = 1").toArray()[0];
    if (!row) throw new Error("Delivery statistics metadata is missing");
    return row;
  }

  episodeExists(episodeId: string): boolean {
    return this.storage.sql.exec<{ episode_id: string }>(
      "SELECT episode_id FROM publication_episodes WHERE show_id = ? AND episode_id = ?", this.showId,
      sqlitePublicationTargetSchema.shape.episode_id.unwrap().parse(episodeId)).toArray().length > 0;
  }

  record(observations: readonly unknown[]): void {
    const now = this.now();
    try {
      const inputs = observations.map((entry) => sqliteDeliveryObservationSchema.parse(entry));
      this.storage.transactionSync(() => {
        for (const observation of inputs) {
          const media = this.storage.sql.exec<{ length_bytes: number }>(
            "SELECT length_bytes FROM publication_media WHERE show_id = ? AND episode_id = ? AND audio_revision_id = ?",
            this.showId, observation.episode_id, observation.audio_revision_id).toArray()[0];
          // Only approved immutable media is counted; the delivery gate already rejects the rest.
          if (!media) continue;
          const delta = sqliteDeliveryCounterDelta(observation, media.length_bytes);
          const date = utcDateFromMs(now), stamp = now;
          this.storage.sql.exec(`INSERT INTO publication_episode_daily_stats
            (episode_id, date_utc, audio_revision_id, get_200_requests, get_206_requests, initial_downloads, response_bytes,
             probe_range_requests, head_requests, not_modified_requests, bot_get_requests, bot_response_bytes, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (episode_id, date_utc, audio_revision_id) DO UPDATE SET
              get_200_requests = get_200_requests + excluded.get_200_requests,
              get_206_requests = get_206_requests + excluded.get_206_requests,
              initial_downloads = initial_downloads + excluded.initial_downloads,
              response_bytes = response_bytes + excluded.response_bytes,
              probe_range_requests = probe_range_requests + excluded.probe_range_requests,
              head_requests = head_requests + excluded.head_requests,
              not_modified_requests = not_modified_requests + excluded.not_modified_requests,
              bot_get_requests = bot_get_requests + excluded.bot_get_requests,
              bot_response_bytes = bot_response_bytes + excluded.bot_response_bytes,
              updated_at_ms = excluded.updated_at_ms`,
          observation.episode_id, date, observation.audio_revision_id, delta.get_200_requests, delta.get_206_requests,
          delta.initial_downloads, delta.response_bytes, delta.probe_range_requests, delta.head_requests,
          delta.not_modified_requests, delta.bot_get_requests, delta.bot_response_bytes, stamp);
        }
        this.pruneExpiredRows(now);
      });
      this.storage.sync();
    } catch (error) {
      this.noteRecordingError(now);
      throw error;
    }
  }

  private noteRecordingError(at: number): void {
    try {
      this.storage.transactionSync(() => {
        this.storage.sql.exec("UPDATE publication_delivery_stats_meta SET recording_error_count = recording_error_count + 1, last_recording_error_at_ms = ? WHERE id = 1", at);
      });
      void this.storage.sync();
    } catch {
      // The statistics store itself is unavailable; delivery stays unaffected and the miss stays visible via the next successful meta read.
    }
  }

  // Advances the retention declaration first, then removes at most one bounded batch of
  // expired daily rows per UTC day, merging their counters into the lifetime totals
  // inside the same transaction. Failures roll back and retry on a later day.
  private pruneExpiredRows(now: number): void {
    const meta = this.meta(), today = utcDateFromMs(now);
    const cutoff = shiftUtcDate(today, -(meta.retention_days - 1));
    let boundary = meta.retained_from_date_utc;
    if (boundary < cutoff) {
      this.storage.sql.exec("UPDATE publication_delivery_stats_meta SET retained_from_date_utc = ? WHERE id = 1", cutoff);
      boundary = cutoff;
    }
    if (meta.last_pruned_date_utc === today) return;
    const rows = this.storage.sql.exec<RawCounterRow & { date_utc: string }>(
      `SELECT episode_id, date_utc, audio_revision_id, get_200_requests, get_206_requests, initial_downloads, response_bytes,
        probe_range_requests, head_requests, not_modified_requests, bot_get_requests, bot_response_bytes
       FROM publication_episode_daily_stats WHERE date_utc < ? ORDER BY date_utc, episode_id, audio_revision_id LIMIT ?`,
      boundary, SQLITE_STATS_PRUNE_BATCH_ROWS).toArray();
    for (const row of rows) {
      this.storage.sql.exec(`INSERT INTO publication_episode_pruned_totals
        (episode_id, audio_revision_id, get_200_requests, get_206_requests, initial_downloads, response_bytes,
         probe_range_requests, head_requests, not_modified_requests, bot_get_requests, bot_response_bytes, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (episode_id, audio_revision_id) DO UPDATE SET
          get_200_requests = get_200_requests + excluded.get_200_requests,
          get_206_requests = get_206_requests + excluded.get_206_requests,
          initial_downloads = initial_downloads + excluded.initial_downloads,
          response_bytes = response_bytes + excluded.response_bytes,
          probe_range_requests = probe_range_requests + excluded.probe_range_requests,
          head_requests = head_requests + excluded.head_requests,
          not_modified_requests = not_modified_requests + excluded.not_modified_requests,
          bot_get_requests = bot_get_requests + excluded.bot_get_requests,
          bot_response_bytes = bot_response_bytes + excluded.bot_response_bytes,
          updated_at_ms = excluded.updated_at_ms`,
      row.episode_id, row.audio_revision_id, row.get_200_requests, row.get_206_requests, row.initial_downloads,
      row.response_bytes, row.probe_range_requests, row.head_requests, row.not_modified_requests,
      row.bot_get_requests, row.bot_response_bytes, now);
      this.storage.sql.exec("DELETE FROM publication_episode_daily_stats WHERE episode_id = ? AND date_utc = ? AND audio_revision_id = ?",
        row.episode_id, row.date_utc, row.audio_revision_id);
    }
    this.storage.sql.exec("UPDATE publication_delivery_stats_meta SET last_pruned_date_utc = ? WHERE id = 1", today);
  }

  async applyRetention(input: unknown, actual: SqliteServiceIdentity): Promise<SqliteStatsRetentionRecord> {
    const request = sqliteStatsRetentionRequestSchema.parse(input), source = JSON.stringify(request);
    const hash = await sha256Hex(source);
    const record = this.storage.transactionSync(() => {
      if (request.service_id !== actual.service_id ||
        request.service_config_sha256 !== actual.service_config_sha256 || request.show_id !== this.showId) {
        throw new Error("Delivery stats retention target differs");
      }
      const result = sqliteStatsRetentionRecordSchema.parse({ request, request_sha256: hash,
        retention_days: request.retention_days, applied_at_ms: this.now() });
      this.storage.sql.exec("UPDATE publication_delivery_stats_meta SET retention_days = ? WHERE id = 1", result.retention_days);
      return result;
    });
    await this.storage.sync();
    return record;
  }

  private episodeRows(episodeIds: string[], fromDate?: string, toDate?: string): (RawCounterRow & { date_utc: string })[] {
    if (!episodeIds.length) return [];
    const placeholders = episodeIds.map(() => "?").join(", ");
    return this.storage.sql.exec<RawCounterRow & { date_utc: string }>(`SELECT episode_id, date_utc, audio_revision_id,
      get_200_requests, get_206_requests, initial_downloads, response_bytes, probe_range_requests, head_requests,
      not_modified_requests, bot_get_requests, bot_response_bytes
      FROM publication_episode_daily_stats WHERE episode_id IN (${placeholders})
      ${fromDate !== undefined ? "AND date_utc >= ?" : ""} ${toDate !== undefined ? "AND date_utc <= ?" : ""}`,
    ...episodeIds, ...(fromDate !== undefined ? [fromDate] : []), ...(toDate !== undefined ? [toDate] : [])).toArray();
  }

  private prunedRows(episodeIds: string[]): (TotalCounterRow & { episode_id: string })[] {
    if (!episodeIds.length) return [];
    const placeholders = episodeIds.map(() => "?").join(", ");
    return this.storage.sql.exec<TotalCounterRow & { episode_id: string }>(`SELECT episode_id, audio_revision_id,
      get_200_requests, get_206_requests, initial_downloads, response_bytes, probe_range_requests, head_requests,
      not_modified_requests, bot_get_requests, bot_response_bytes FROM publication_episode_pruned_totals
      WHERE episode_id IN (${placeholders})`, ...episodeIds).toArray();
  }

  private mediaLengths(episodeIds: string[]): Map<string, number> {
    const lengths = new Map<string, number>();
    if (!episodeIds.length) return lengths;
    const placeholders = episodeIds.map(() => "?").join(", ");
    for (const row of this.storage.sql.exec<{ episode_id: string; audio_revision_id: string; length_bytes: number }>(
      `SELECT episode_id, audio_revision_id, length_bytes FROM publication_media WHERE show_id = ? AND episode_id IN (${placeholders})`,
      this.showId, ...episodeIds).toArray()) {
      lengths.set(`${row.episode_id}\0${row.audio_revision_id}`, row.length_bytes);
    }
    return lengths;
  }

  private emptyCounters(): SqliteStatsCounters {
    return { get_200_requests: 0, get_206_requests: 0, audio_get_requests: 0, initial_downloads: 0, response_bytes: 0,
      probe_range_requests: 0, head_requests: 0, not_modified_requests: 0, bot_get_requests: 0, bot_response_bytes: 0,
      equivalent_full_downloads: 0 };
  }

  private addCounters(total: SqliteStatsCounters, row: Omit<RawCounterRow, "episode_id">, lengthBytes: number): void {
    total.get_200_requests += row.get_200_requests;
    total.get_206_requests += row.get_206_requests;
    total.initial_downloads += row.initial_downloads;
    total.response_bytes += row.response_bytes;
    total.probe_range_requests += row.probe_range_requests;
    total.head_requests += row.head_requests;
    total.not_modified_requests += row.not_modified_requests;
    total.bot_get_requests += row.bot_get_requests;
    total.bot_response_bytes += row.bot_response_bytes;
    if (lengthBytes > 0) total.equivalent_full_downloads += row.response_bytes / lengthBytes;
  }

  private finishCounters(total: SqliteStatsCounters): SqliteStatsCounters {
    total.audio_get_requests = total.get_200_requests + total.get_206_requests;
    total.equivalent_full_downloads = round2(total.equivalent_full_downloads);
    return total;
  }

  private dayCoverage(date: string, meta: MetaRow, today: string): SqliteStatsCoverage {
    if (date < meta.measurement_started_date_utc || date > today) return "unmeasured";
    if (date < meta.retained_from_date_utc) return "pruned";
    const firstDayStartsAtMidnight = meta.measurement_started_at_ms === startOfDayMs(meta.measurement_started_date_utc);
    if (date === meta.measurement_started_date_utc && !firstDayStartsAtMidnight) return "partial";
    if (date === today) return "partial";
    return "measured";
  }

  private periodCoverage(from: string, to: string, meta: MetaRow, today: string): SqliteStatsCoverage {
    let sawMeasured = false, sawUnknown = false, sawPruned = false, sawPartial = false;
    for (let offset = 0; offset <= diffUtcDays(from, to); offset += 1) {
      const coverage = this.dayCoverage(shiftUtcDate(from, offset), meta, today);
      if (coverage === "measured") sawMeasured = true;
      else if (coverage === "partial") sawPartial = true;
      else if (coverage === "pruned") sawPruned = true;
      else sawUnknown = true;
    }
    if (sawMeasured || sawPartial) return sawPartial || sawUnknown || sawPruned ? "partial" : "measured";
    if (sawPruned) return sawUnknown ? "partial" : "pruned";
    return "unmeasured";
  }

  // Days inside [from, to] whose counters may be summed for period totals.
  private measurableRange(from: string, meta: MetaRow): string {
    return from < meta.retained_from_date_utc ? meta.retained_from_date_utc : from;
  }

  episodePage(input: { from_date_utc?: string; to_date_utc?: string; cursor?: string }): {
    episodes: SqliteStatsEpisodeSummary[]; nextCursor: string | null; fromDate: string; toDate: string } {
    const now = this.now(), meta = this.meta(), today = utcDateFromMs(now);
    const to = input.to_date_utc ?? today;
    const from = input.from_date_utc ?? shiftUtcDate(to, -(SQLITE_STATS_DEFAULT_WINDOW_DAYS - 1));
    if (from > to || to > today || diffUtcDays(from, to) + 1 > SQLITE_STATS_MAX_WINDOW_DAYS) {
      throw new Error("Delivery statistics window differs from its supported range");
    }
    let after = "";
    if (input.cursor) {
      const decoded = sqliteStatsEpisodesCursorSchema.parse(JSON.parse(atob(input.cursor)));
      const { last_episode_id, ...bound } = decoded;
      if (JSON.stringify(bound) !== JSON.stringify(sqliteStatsEpisodesCursorSchema.omit({ last_episode_id: true }).parse(
        { ...this.identity, show_id: this.showId, from_date_utc: from, to_date_utc: to }))) {
        throw new Error("Delivery statistics cursor belongs to another query or runtime");
      }
      after = last_episode_id;
    }
    return this.storage.transactionSync(() => {
      const episodes = this.storage.sql.exec<{ episode_id: string; lifecycle: "published" | "unpublished" | "deleted" }>(
        `SELECT episode_id, lifecycle FROM publication_episodes WHERE show_id = ? AND episode_id > ?
          ORDER BY episode_id LIMIT ?`, this.showId, after, SQLITE_STATS_EPISODE_PAGE_SIZE + 1).toArray();
      const page = episodes.slice(0, SQLITE_STATS_EPISODE_PAGE_SIZE);
      const ids = page.map((row) => row.episode_id);
      const measure = this.measurableRange(from, meta);
      const lengths = this.mediaLengths(ids);
      const periodRows = this.episodeRows(ids, measure, to);
      const lifetimeRows = this.episodeRows(ids);
      const pruned = this.prunedRows(ids);
      const coverage = this.periodCoverage(from, to, meta, today);
      const summaries = page.map((episode) => {
        const period = this.emptyCounters();
        for (const row of periodRows.filter((entry) => entry.episode_id === episode.episode_id)) {
          this.addCounters(period, row, lengths.get(`${episode.episode_id}\0${row.audio_revision_id}`) ?? 0);
        }
        const lifetime = this.emptyCounters();
        for (const row of [...lifetimeRows, ...pruned].filter((entry) => entry.episode_id === episode.episode_id)) {
          this.addCounters(lifetime, row, lengths.get(`${episode.episode_id}\0${row.audio_revision_id}`) ?? 0);
        }
        return { episode_id: episode.episode_id, lifecycle: episode.lifecycle, coverage,
          period: coverage === "unmeasured" || coverage === "pruned" ? null : this.finishCounters(period),
          lifetime: this.finishCounters(lifetime) };
      });
      const nextCursor = episodes.length > SQLITE_STATS_EPISODE_PAGE_SIZE ?
        btoa(JSON.stringify({ ...this.identity, show_id: this.showId, from_date_utc: from, to_date_utc: to,
          last_episode_id: ids[ids.length - 1] })) : null;
      return { episodes: summaries, nextCursor, fromDate: from, toDate: to };
    });
  }

  dailyPage(input: { episode_id: string; from_date_utc?: string; to_date_utc?: string; cursor?: string }): {
    episodeId: string; lifecycle: "published" | "unpublished" | "deleted" | "missing"; fromDate: string; toDate: string;
    coverage: SqliteStatsCoverage; period: SqliteStatsCounters | null; lifetime: SqliteStatsCounters | null;
    revisions: { audio_revision_id: string; length_bytes: number; is_current_enclosure: boolean;
      period: SqliteStatsCounters | null; lifetime: SqliteStatsCounters | null }[];
    days: SqliteStatsDailyEntry[]; nextCursor: string | null } {
    const now = this.now(), meta = this.meta(), today = utcDateFromMs(now);
    const to = input.to_date_utc ?? today;
    const from = input.from_date_utc ?? shiftUtcDate(to, -(SQLITE_STATS_DEFAULT_WINDOW_DAYS - 1));
    if (from > to || to > today || diffUtcDays(from, to) + 1 > SQLITE_STATS_MAX_WINDOW_DAYS) {
      throw new Error("Delivery statistics window differs from its supported range");
    }
    let afterDate: string | null = null;
    if (input.cursor) {
      const decoded = sqliteStatsDailyCursorSchema.parse(JSON.parse(atob(input.cursor)));
      const { after_date_utc, ...bound } = decoded;
      if (JSON.stringify(bound) !== JSON.stringify(sqliteStatsDailyCursorSchema.omit({ after_date_utc: true }).parse(
        { ...this.identity, show_id: this.showId, episode_id: input.episode_id, from_date_utc: from, to_date_utc: to }))) {
        throw new Error("Delivery statistics cursor belongs to another query or runtime");
      }
      afterDate = after_date_utc;
    }
    return this.storage.transactionSync(() => {
      const episode = this.storage.sql.exec<{ lifecycle: "published" | "unpublished" | "deleted" }>(
        "SELECT lifecycle FROM publication_episodes WHERE show_id = ? AND episode_id = ?", this.showId, input.episode_id).toArray()[0];
      const lengths = this.mediaLengths([input.episode_id]);
      const measure = this.measurableRange(from, meta);
      const periodRows = this.episodeRows([input.episode_id], measure, to);
      const lifetimeRows = this.episodeRows([input.episode_id]);
      const pruned = this.prunedRows([input.episode_id]);
      const currentEnclosure = this.storage.sql.exec<{ audio_revision_id: string }>(
        `SELECT r.audio_revision_id FROM publication_episode_revisions r
          WHERE r.show_id = ? AND r.episode_id = ? AND r.revision_id =
            (SELECT e.revision_id FROM publication_episodes e WHERE e.show_id = ? AND e.episode_id = ?)`,
        this.showId, input.episode_id, this.showId, input.episode_id).toArray()[0]?.audio_revision_id ?? null;
      const revisionIds = new Set<string>([...periodRows, ...lifetimeRows, ...pruned].map((row) => row.audio_revision_id));
      const revisions = [...revisionIds].sort().map((audioRevisionId) => {
        const revisionPeriod = this.emptyCounters(), revisionLifetime = this.emptyCounters();
        for (const row of periodRows.filter((entry) => entry.audio_revision_id === audioRevisionId)) {
          this.addCounters(revisionPeriod, row, lengths.get(`${input.episode_id}\0${audioRevisionId}`) ?? 0);
        }
        for (const row of [...lifetimeRows, ...pruned].filter((entry) => entry.audio_revision_id === audioRevisionId)) {
          this.addCounters(revisionLifetime, row, lengths.get(`${input.episode_id}\0${audioRevisionId}`) ?? 0);
        }
        return { audio_revision_id: audioRevisionId, length_bytes: lengths.get(`${input.episode_id}\0${audioRevisionId}`) ?? 0,
          is_current_enclosure: currentEnclosure === audioRevisionId,
          period: this.finishCounters(revisionPeriod), lifetime: this.finishCounters(revisionLifetime) };
      });
      const period = this.emptyCounters(), lifetime = this.emptyCounters();
      for (const row of periodRows) this.addCounters(period, row, lengths.get(`${input.episode_id}\0${row.audio_revision_id}`) ?? 0);
      for (const row of [...lifetimeRows, ...pruned]) this.addCounters(lifetime, row, lengths.get(`${input.episode_id}\0${row.audio_revision_id}`) ?? 0);
      const coverage = this.periodCoverage(from, to, meta, today);
      const start = afterDate === null ? from : shiftUtcDate(afterDate, 1);
      const pageEnd = (() => {
        const last = shiftUtcDate(start, SQLITE_STATS_DAILY_PAGE_SIZE - 1);
        return last < to ? last : to;
      })();
      const pageRows = this.storage.sql.exec<RawCounterRow & { date_utc: string }>(`SELECT episode_id, date_utc, audio_revision_id,
        get_200_requests, get_206_requests, initial_downloads, response_bytes, probe_range_requests, head_requests,
        not_modified_requests, bot_get_requests, bot_response_bytes
        FROM publication_episode_daily_stats WHERE episode_id = ? AND date_utc BETWEEN ? AND ?`,
      input.episode_id, start, pageEnd).toArray();
      const days: SqliteStatsDailyEntry[] = [];
      for (let date = start; date <= pageEnd; date = shiftUtcDate(date, 1)) {
        const dayCoverage = this.dayCoverage(date, meta, today);
        if (dayCoverage === "unmeasured" || dayCoverage === "pruned") {
          days.push({ date_utc: date, coverage: dayCoverage, counters: null });
          continue;
        }
        const dayCounters = this.emptyCounters();
        for (const row of pageRows.filter((entry) => entry.date_utc === date)) {
          this.addCounters(dayCounters, row, lengths.get(`${input.episode_id}\0${row.audio_revision_id}`) ?? 0);
        }
        days.push({ date_utc: date, coverage: dayCoverage, counters: this.finishCounters(dayCounters) });
      }
      const nextCursor = pageEnd < to ?
        btoa(JSON.stringify({ ...this.identity, show_id: this.showId, episode_id: input.episode_id,
          from_date_utc: from, to_date_utc: to, after_date_utc: pageEnd })) : null;
      return { episodeId: input.episode_id, lifecycle: episode?.lifecycle ?? "missing", fromDate: from, toDate: to,
        coverage, period: coverage === "unmeasured" || coverage === "pruned" ? null : this.finishCounters(period),
        lifetime: this.finishCounters(lifetime), revisions, days, nextCursor };
    });
  }
}
