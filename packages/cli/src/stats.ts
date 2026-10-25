import { z } from "zod";
import { validateId } from "@castloop/shared";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteStatsRetentionRequestSchema } from "../../shared/src/sqlite-stats";
import { sqliteStatsRetentionResponseSchema } from "../../shared/src/sqlite-service-api";
import type { SqliteStatsEpisodeDailyResponse, SqliteStatsEpisodesResponse } from "../../shared/src/sqlite-stats";
import { administratorKey } from "./administrator-key";
import { createLocalJournalStorage } from "./local-journal-storage";
import { SqliteServiceClient } from "./sqlite-service-client";
import type { R2RestTransport } from "./verified-r2-put";

const dateUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export type SqliteStatsOptions = { episodeId?: string; from?: string; to?: string; cursor?: string; transport?: R2RestTransport };

export async function readSqliteStats(root: string, config: SqliteServiceConfig, showId: string, options: SqliteStatsOptions = {}): Promise<unknown> {
  const client = new SqliteServiceClient(config, administratorKey(root), options.transport);
  const query = {
    ...(options.from !== undefined ? { from_date_utc: dateUtc.parse(options.from) } : {}),
    ...(options.to !== undefined ? { to_date_utc: dateUtc.parse(options.to) } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  };
  if (options.episodeId === undefined) return client.statsEpisodes(validateId(showId, "show"), query);
  return client.statsEpisodeDaily(validateId(showId, "show"), validateId(options.episodeId, "episode"), query);
}

const retentionJournalSchema = z.object({
  schema_version: z.literal(1),
  request: sqliteStatsRetentionRequestSchema,
  phase: z.enum(["prepared", "requested", "confirmed"]),
  result: sqliteStatsRetentionResponseSchema.optional(),
}).strict();

export async function setSqliteStatsRetention(root: string, config: SqliteServiceConfig, showId: string,
  days: number, operationId: string, transport?: R2RestTransport): Promise<unknown> {
  if (!Number.isSafeInteger(days)) throw new Error("Retention days must be an integer");
  const client = new SqliteServiceClient(config, administratorKey(root), transport);
  const journal = createLocalJournalStorage(root, "sqlite-stats-controls", config.service_id, `${operationId}.json`);
  let prior: z.infer<typeof retentionJournalSchema> | null = null;
  try { prior = retentionJournalSchema.parse(journal.read()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (prior) {
    if (prior.request.show_id !== showId || prior.request.retention_days !== days ||
      prior.request.service_config_sha256 !== await sqliteServiceConfigHash(config)) throw new Error("Retained retention control differs");
    if (prior.phase !== "prepared") return journal.exclusively(async () => {
      const state = retentionJournalSchema.parse(journal.read());
      const result = await client.statsRetentionStatus(showId, operationId);
      if (JSON.stringify(result.retention.request) !== JSON.stringify(state.request)) throw new Error("Retention control outcome is unknown or differs");
      journal.replace({ ...state, phase: "confirmed", result });
      return result;
    });
  }
  const health = await client.health(showId);
  const request = prior?.request ?? sqliteStatsRetentionRequestSchema.parse({
    service_id: config.service_id, service_config_sha256: health.service_config_sha256,
    worker_version_id: health.worker_version_id, operation_id: operationId, show_id: showId, retention_days: days });
  journal.initialize({ schema_version: 1, request, phase: "prepared" });
  return journal.exclusively(async () => {
    const state = retentionJournalSchema.parse(journal.read());
    if (state.phase !== "prepared" || JSON.stringify(state.request) !== JSON.stringify(request)) throw new Error("Retention control is uncertain or changed; do not replay it");
    journal.replace({ ...state, phase: "requested" });
    const result = await client.statsRetention(request);
    journal.replace({ ...state, phase: "confirmed", result });
    return result;
  });
}

function instant(ms: number): string {
  return new Date(ms).toISOString();
}
function count(value: number | null | undefined, width: number): string {
  if (value === null || value === undefined) return "-".padStart(width);
  return value.toLocaleString("en-US").padStart(width);
}
function decimal(value: number | null | undefined, width: number): string {
  if (value === null || value === undefined) return "-".padStart(width);
  return value.toFixed(2).padStart(width);
}
function label(value: string | undefined, width: number): string {
  return (value ?? "").padStart(width);
}

function headerLine(response: SqliteStatsEpisodesResponse | SqliteStatsEpisodeDailyResponse): string[] {
  return [
    `Measurement started: ${instant(response.measurement_started_at_ms)} (measurement date: ${response.measurement_started_date_utc})`,
    `Retention days: ${response.retention_days} (daily details retained from ${response.retained_from_date_utc})`,
    `Collection mode: ${response.collection_mode} (recording errors: ${response.recording_error_count})`,
  ];
}

export function formatSqliteStatsEpisodes(response: SqliteStatsEpisodesResponse): string {
  const lines = [`Delivery statistics for Show ${response.show_id} (UTC: ${response.from_date_utc} .. ${response.to_date_utc})`, ...headerLine(response), ""];
  lines.push(`${label("EPISODE", 24)} ${label("STATE", 11)} ${label("INITIAL_DL", 11)} ${label("FULL_EQUIV", 11)} ${label("GET_200", 8)} ${label("GET_206", 8)} ${label("RESPONSE_BYTES", 15)} ${label("HEAD", 6)} ${label("304", 5)} ${label("BOT_GET", 8)}`);
  for (const episode of response.episodes) {
    const counters = episode.period;
    lines.push(`${episode.episode_id.padEnd(24)} ${episode.lifecycle.padEnd(11)} ${counters ? count(counters.initial_downloads, 11) : label("unmeasured", 11)} ${counters ? decimal(counters.equivalent_full_downloads, 11) : label("unmeasured", 11)} ${count(counters?.get_200_requests, 8)} ${count(counters?.get_206_requests, 8)} ${count(counters?.response_bytes, 15)} ${count(counters?.head_requests, 6)} ${count(counters?.not_modified_requests, 5)} ${count(counters?.bot_get_requests, 8)}`);
  }
  if (response.next_cursor) lines.push("", `Next page: --cursor ${response.next_cursor}`);
  return lines.join("\n");
}

export function formatSqliteStatsDaily(response: SqliteStatsEpisodeDailyResponse, byRevision: boolean): string {
  const lines = [`Daily delivery statistics for ${response.show_id}/${response.episode_id} (UTC: ${response.from_date_utc} .. ${response.to_date_utc})`, ...headerLine(response)];
  lines.push(`Coverage: ${response.coverage}`);
  if (byRevision && response.revisions.length) {
    lines.push("", "Audio revisions:");
    for (const revision of response.revisions) {
      lines.push(`  ${revision.audio_revision_id}  ${count(revision.length_bytes, 15)} bytes  current_enclosure=${revision.is_current_enclosure ? "yes" : "no"}` +
        `  period(initial=${revision.period?.initial_downloads ?? "-"}, bytes=${revision.period?.response_bytes ?? "-"})` +
        `  lifetime(initial=${revision.lifetime?.initial_downloads ?? "-"}, bytes=${revision.lifetime?.response_bytes ?? "-"})`);
    }
  }
  lines.push("", `${label("DATE_UTC", 12)} ${label("STATUS", 11)} ${label("INITIAL_DL", 11)} ${label("FULL_EQUIV", 11)} ${label("GET_200", 8)} ${label("GET_206", 8)} ${label("RESPONSE_BYTES", 15)} ${label("PROBE", 6)} ${label("HEAD", 6)} ${label("304", 5)} ${label("BOT_GET", 8)}`);
  for (const day of response.days) {
    const counters = day.counters;
    const unknown = "-";
    lines.push(`${day.date_utc.padEnd(12)} ${day.coverage.padEnd(11)} ${counters ? count(counters.initial_downloads, 11) : label(unknown, 11)} ${counters ? decimal(counters.equivalent_full_downloads, 11) : label(unknown, 11)} ${count(counters?.get_200_requests, 8)} ${count(counters?.get_206_requests, 8)} ${count(counters?.response_bytes, 15)} ${count(counters?.probe_range_requests, 6)} ${count(counters?.head_requests, 6)} ${count(counters?.not_modified_requests, 5)} ${count(counters?.bot_get_requests, 8)}`);
  }
  if (response.next_cursor) lines.push("", `Next page: --cursor ${response.next_cursor}`);
  return lines.join("\n");
}
