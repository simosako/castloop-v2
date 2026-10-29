import { z } from "zod";
import { sqlitePublicationProtocol, sqlitePublicationTargetSchema, sqlitePublicationRuntimeSchema } from "./sqlite-publication";
import { sqliteAvailabilityStateSchema } from "./sqlite-availability";

export const SQLITE_STATS_EPISODE_PAGE_SIZE = 20;
export const SQLITE_STATS_DAILY_PAGE_SIZE = 31;
export const SQLITE_STATS_MAX_WINDOW_DAYS = 366;
export const SQLITE_STATS_DEFAULT_WINDOW_DAYS = 30;
export const SQLITE_STATS_RETENTION_MIN_DAYS = 30;
export const SQLITE_STATS_RETENTION_MAX_DAYS = 3650;
export const SQLITE_STATS_RETENTION_DEFAULT_DAYS = 400;
export const SQLITE_STATS_INITIAL_RANGE_BYTES = 65536;

const showId = sqlitePublicationTargetSchema.shape.show_id;
const episodeId = sqlitePublicationTargetSchema.shape.episode_id.unwrap();
const dateUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD UTC date");
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

// Known automatic crawler, link-preview, AI fetcher and uptime-probe identifiers.
// The match is a lowercase substring test over the first 512 characters of the User-Agent.
export const SQLITE_STATS_BOT_PATTERNS = ["bot", "crawler", "spider", "slurp", "archiver", "ia_archiver",
  "mediapartners-google", "adsbot", "facebookexternalhit", "facebot", "twitterbot", "slackbot", "discordbot",
  "whatsapp", "telegrambot", "linkedinbot", "gptbot", "chatgpt-user", "oai-searchbot", "claudebot",
  "anthropic-ai", "perplexitybot", "bytespider", "ccbot", "amazonbot", "castloop-verify", "uptimerobot",
  "pingdom", "statuscake", "better stack"];

export function isSqliteStatsBotUserAgent(userAgent: string | null): boolean {
  if (userAgent === null) return false;
  const value = userAgent.slice(0, 512).toLowerCase();
  return SQLITE_STATS_BOT_PATTERNS.some((pattern) => value.includes(pattern));
}

// One observed public audio response, sent from the Gateway to the owning Show DO
// after the response status and headers are final. Contains no listener identity.
export const sqliteDeliveryObservationSchema = z.object({
  episode_id: episodeId,
  audio_revision_id: z.uuid(),
  method: z.enum(["GET", "HEAD"]),
  status: z.union([z.literal(200), z.literal(206), z.literal(304)]),
  content_length: z.number().int().min(0).max(300_000_000),
  range_offset: z.number().int().min(0).max(300_000_000).nullable(),
  bot: z.boolean(),
}).strict().superRefine((value, context) => {
  if ((value.status === 206) !== (value.range_offset !== null)) {
    context.addIssue({ code: "custom", message: "Only a 206 response carries a range offset" });
  }
});
export type SqliteDeliveryObservation = z.infer<typeof sqliteDeliveryObservationSchema>;

export const sqliteStatsCoverageSchema = z.enum(["unmeasured", "pruned", "partial", "measured"]);
export type SqliteStatsCoverage = z.infer<typeof sqliteStatsCoverageSchema>;

export const sqliteStatsCountersSchema = z.object({
  get_200_requests: counter,
  get_206_requests: counter,
  audio_get_requests: counter,
  initial_downloads: counter,
  response_bytes: counter,
  probe_range_requests: counter,
  head_requests: counter,
  not_modified_requests: counter,
  bot_get_requests: counter,
  bot_response_bytes: counter,
  equivalent_full_downloads: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((value, context) => {
  if (value.audio_get_requests !== value.get_200_requests + value.get_206_requests) {
    context.addIssue({ code: "custom", message: "Audio GET counter differs from its parts" });
  }
});
export type SqliteStatsCounters = z.infer<typeof sqliteStatsCountersSchema>;

const statsFields = {
  measurement_started_at_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  measurement_started_date_utc: dateUtc,
  retained_from_date_utc: dateUtc,
  retention_days: z.number().int().min(SQLITE_STATS_RETENTION_MIN_DAYS).max(SQLITE_STATS_RETENTION_MAX_DAYS),
  current_date_utc: dateUtc,
  recording_error_count: counter,
  collection_mode: z.literal("best_effort_non_blocking"),
};

export const sqliteStatsEpisodeSummarySchema = z.object({
  episode_id: episodeId,
  lifecycle: z.enum(["published", "unpublished", "deleted"]),
  coverage: sqliteStatsCoverageSchema,
  period: sqliteStatsCountersSchema.nullable(),
  lifetime: sqliteStatsCountersSchema.nullable(),
}).strict();
export type SqliteStatsEpisodeSummary = z.infer<typeof sqliteStatsEpisodeSummarySchema>;

export const sqliteStatsEpisodesRequestSchema = z.object({
  show_id: showId,
  from_date_utc: dateUtc.optional(),
  to_date_utc: dateUtc.optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type SqliteStatsEpisodesRequest = z.infer<typeof sqliteStatsEpisodesRequestSchema>;

export const sqliteStatsEpisodesResponseSchema = sqlitePublicationRuntimeSchema.extend({
  protocol: z.literal(sqlitePublicationProtocol),
  show_id: showId,
  ...statsFields,
  state: sqliteAvailabilityStateSchema.nullable(),
  from_date_utc: dateUtc,
  to_date_utc: dateUtc,
  episodes: z.array(sqliteStatsEpisodeSummarySchema).max(SQLITE_STATS_EPISODE_PAGE_SIZE),
  next_cursor: z.string().min(1).max(2048).nullable(),
}).strict();
export type SqliteStatsEpisodesResponse = z.infer<typeof sqliteStatsEpisodesResponseSchema>;

export const sqliteStatsEpisodeDailyRequestSchema = z.object({
  show_id: showId,
  episode_id: episodeId,
  from_date_utc: dateUtc.optional(),
  to_date_utc: dateUtc.optional(),
  by_revision: z.boolean().optional(),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type SqliteStatsEpisodeDailyRequest = z.infer<typeof sqliteStatsEpisodeDailyRequestSchema>;

export const sqliteStatsRevisionSummarySchema = z.object({
  audio_revision_id: z.uuid(),
  length_bytes: z.number().int().positive().max(300_000_000),
  is_current_enclosure: z.boolean(),
  period: sqliteStatsCountersSchema.nullable(),
  lifetime: sqliteStatsCountersSchema.nullable(),
}).strict();
export type SqliteStatsRevisionSummary = z.infer<typeof sqliteStatsRevisionSummarySchema>;

export const sqliteStatsDailyEntrySchema = z.object({
  date_utc: dateUtc,
  coverage: sqliteStatsCoverageSchema,
  counters: sqliteStatsCountersSchema.nullable(),
}).strict();
export type SqliteStatsDailyEntry = z.infer<typeof sqliteStatsDailyEntrySchema>;

export const sqliteStatsEpisodeDailyResponseSchema = sqlitePublicationRuntimeSchema.extend({
  protocol: z.literal(sqlitePublicationProtocol),
  show_id: showId,
  episode_id: episodeId,
  episode_lifecycle: z.enum(["published", "unpublished", "deleted"]),
  ...statsFields,
  state: sqliteAvailabilityStateSchema.nullable(),
  from_date_utc: dateUtc,
  to_date_utc: dateUtc,
  coverage: sqliteStatsCoverageSchema,
  period: sqliteStatsCountersSchema.nullable(),
  lifetime: sqliteStatsCountersSchema.nullable(),
  revisions: z.array(sqliteStatsRevisionSummarySchema),
  days: z.array(sqliteStatsDailyEntrySchema).max(SQLITE_STATS_DAILY_PAGE_SIZE),
  next_cursor: z.string().min(1).max(2048).nullable(),
}).strict();
export type SqliteStatsEpisodeDailyResponse = z.infer<typeof sqliteStatsEpisodeDailyResponseSchema>;

export const sqliteStatsEpisodesCursorSchema = sqlitePublicationRuntimeSchema.extend({
  show_id: showId, from_date_utc: dateUtc, to_date_utc: dateUtc, last_episode_id: episodeId,
}).strict();

export const sqliteStatsDailyCursorSchema = sqlitePublicationRuntimeSchema.extend({
  show_id: showId, episode_id: episodeId, from_date_utc: dateUtc, to_date_utc: dateUtc,
  after_date_utc: dateUtc,
}).strict();

export const sqliteStatsRetentionRequestSchema = sqlitePublicationRuntimeSchema.extend({
  show_id: showId,
  operation_id: z.uuid(),
  retention_days: z.number().int().min(SQLITE_STATS_RETENTION_MIN_DAYS).max(SQLITE_STATS_RETENTION_MAX_DAYS),
}).strict();
export type SqliteStatsRetentionRequest = z.infer<typeof sqliteStatsRetentionRequestSchema>;

export const sqliteStatsRetentionRecordSchema = z.object({
  request: sqliteStatsRetentionRequestSchema,
  request_sha256: hash,
  retention_days: z.number().int().min(SQLITE_STATS_RETENTION_MIN_DAYS).max(SQLITE_STATS_RETENTION_MAX_DAYS),
  applied_at_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((value, context) => {
  if (value.retention_days !== value.request.retention_days) {
    context.addIssue({ code: "custom", message: "Retention result differs from its request" });
  }
});
export type SqliteStatsRetentionRecord = z.infer<typeof sqliteStatsRetentionRecordSchema>;
