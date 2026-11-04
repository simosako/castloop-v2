import { z } from "zod";
import { ACCESS_STATS_FORMAT, HTTP_LOGPUSH_CACHE_STATUSES, accessStatsCountersSchema, accessStatsDailySchema, accessStatsResourceSchema } from "./access-stats";
import { sqliteDomainHostnameSchema } from "./sqlite-domain";
import { sqlitePublicationProtocol, sqlitePublicationRuntimeSchema, sqlitePublicationTargetSchema, sqliteServiceIdentitySchema } from "./sqlite-publication";

export const SQLITE_ACCESS_STATS_RETENTION_DAYS = 400 as const;
export const SQLITE_ACCESS_STATS_PAGE_SIZE = 20;
export const SQLITE_ACCESS_STATS_DAILY_PAGE_SIZE = 31;
export const MAX_SQLITE_ACCESS_STATS_REQUEST_BYTES = 12288;
export const MAX_SQLITE_ACCESS_STATS_RESPONSE_BYTES = 16384;

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const showId = sqlitePublicationTargetSchema.shape.show_id;
const sourceId = z.string().min(1).max(320);
const hash = sqliteServiceIdentitySchema.shape.service_config_sha256;
const cursor = z.string().min(1).max(2048);
const DAY_MS = 86_400_000;

const interruptionSchema = z.object({ started_at_ms: counter, ended_at_ms: counter.nullable(),
  reason_code: z.enum(["job_disabled", "delivery_error"]) }).strict().refine(
  (value) => value.ended_at_ms === null || value.ended_at_ms > value.started_at_ms,
  "Collection interruption must end after it starts");

export const sqliteAccessStatsSourceSchema = z.object({
  source_id: sourceId,
  collector: z.literal("http_logpush"),
  zone_id: z.string().regex(/^[a-f0-9]{32}$/),
  host: sqliteDomainHostnameSchema,
  metric_definition: z.literal(ACCESS_STATS_FORMAT),
  byte_measurement: z.literal("edge_body"),
  collection_mode: z.literal("best_effort"),
  collection_started_at_ms: counter,
  collection_ended_at_ms: counter.nullable(),
  last_complete_at_ms: counter.nullable(),
  interruptions: z.array(interruptionSchema),
}).strict().refine((value) => value.source_id === `http_logpush:${value.zone_id}:${value.host}`,
  "Collection source ID differs from its zone and host").refine((value) =>
  (value.collection_ended_at_ms === null || value.collection_ended_at_ms >= value.collection_started_at_ms) &&
  value.interruptions.every((entry) => entry.started_at_ms >= value.collection_started_at_ms &&
    (entry.ended_at_ms ?? Infinity) <= (value.collection_ended_at_ms ?? Infinity)),
  "Collection intervals differ from the source lifetime");
export type SqliteAccessStatsSource = z.infer<typeof sqliteAccessStatsSourceSchema>;

export const sqliteAccessStatsSourceRecordSchema = z.object({ source: sqliteAccessStatsSourceSchema,
  version: counter.min(1), updated_at_ms: counter }).strict();
export type SqliteAccessStatsSourceRecord = z.infer<typeof sqliteAccessStatsSourceRecordSchema>;

const readFields = { input_sha256: hash, read_at_ms: counter,
  input_min_at_ms: counter.nullable(), input_max_at_ms: counter.nullable() };

export const sqliteAccessStatsStoredDailySchema = z.object({ daily: accessStatsDailySchema,
  ...readFields, version: counter.min(1), applied_at_ms: counter }).strict();
export type SqliteAccessStatsStoredDaily = z.infer<typeof sqliteAccessStatsStoredDailySchema>;

export const sqliteAccessStatsReplaceRequestSchema = sqliteServiceIdentitySchema.extend({
  show_id: showId, source: sqliteAccessStatsSourceSchema, expected_source_version: counter,
  daily: accessStatsDailySchema, expected_version: counter, ...readFields,
}).strict().refine((value) => value.show_id === value.daily.show_id && value.source.source_id === value.daily.source_id,
  "Access statistics source or Show differs from its daily value").refine((value) =>
  Object.keys(value.daily.counters.cache_status_requests).every((key) => HTTP_LOGPUSH_CACHE_STATUSES.some((status) => status === key)),
  "HTTP Logpush cache counters contain an unsupported status").refine((value) => {
  const count = value.daily.counters.get_200_requests + value.daily.counters.get_206_requests +
    value.daily.counters.head_requests + value.daily.counters.not_modified_requests;
  if (count === 0) return value.input_min_at_ms === null && value.input_max_at_ms === null;
  const start = Date.parse(`${value.daily.date_utc}T00:00:00Z`);
  return value.input_min_at_ms !== null && value.input_max_at_ms !== null &&
    value.input_min_at_ms >= start && value.input_max_at_ms >= value.input_min_at_ms && value.input_max_at_ms < start + DAY_MS;
}, "Observed input timestamps differ from the daily value").refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_SQLITE_ACCESS_STATS_REQUEST_BYTES,
  "Access statistics update exceeds its size limit");
export type SqliteAccessStatsReplaceRequest = z.infer<typeof sqliteAccessStatsReplaceRequestSchema>;

const request = sqliteServiceIdentitySchema.extend({ show_id: showId, cursor: cursor.optional() }).strict();
export const sqliteAccessStatsSourcesRequestSchema = request;
export type SqliteAccessStatsSourcesRequest = z.infer<typeof sqliteAccessStatsSourcesRequestSchema>;
export const sqliteAccessStatsResourcesRequestSchema = request;
export type SqliteAccessStatsResourcesRequest = z.infer<typeof sqliteAccessStatsResourcesRequestSchema>;
export const sqliteAccessStatsDailyRequestSchema = request.extend({ source_id: sourceId,
  resource_path: z.string().min(1).max(200), from_date_utc: z.iso.date(), to_date_utc: z.iso.date(),
}).strict().refine((value) => {
  const days = (Date.parse(value.to_date_utc) - Date.parse(value.from_date_utc)) / DAY_MS + 1;
  return days >= 1 && days <= 366;
}, "Access statistics window must span 1 to 366 UTC days");
export type SqliteAccessStatsDailyRequest = z.infer<typeof sqliteAccessStatsDailyRequestSchema>;

const response = sqlitePublicationRuntimeSchema.extend({ protocol: z.literal(sqlitePublicationProtocol),
  format: z.literal(ACCESS_STATS_FORMAT), show_id: showId, retention_days: z.literal(SQLITE_ACCESS_STATS_RETENTION_DAYS),
  current_date_utc: z.iso.date(), retained_from_date_utc: z.iso.date() }).strict();
export const sqliteAccessStatsSourcesResponseSchema = response.extend({
  sources: z.array(sqliteAccessStatsSourceRecordSchema).max(SQLITE_ACCESS_STATS_PAGE_SIZE), next_cursor: cursor.nullable(),
}).strict();
export type SqliteAccessStatsSourcesResponse = z.infer<typeof sqliteAccessStatsSourcesResponseSchema>;
export const sqliteAccessStatsResourcesResponseSchema = response.extend({
  resources: z.array(accessStatsResourceSchema).max(SQLITE_ACCESS_STATS_PAGE_SIZE), next_cursor: cursor.nullable(),
}).strict();
export type SqliteAccessStatsResourcesResponse = z.infer<typeof sqliteAccessStatsResourcesResponseSchema>;

export const sqliteAccessStatsCoverageSchema = z.enum(["observed", "partial", "unmeasured", "pruned"]);
export type SqliteAccessStatsCoverage = z.infer<typeof sqliteAccessStatsCoverageSchema>;
export const sqliteAccessStatsDaySchema = z.object({ date_utc: z.iso.date(), coverage: sqliteAccessStatsCoverageSchema,
  record: sqliteAccessStatsStoredDailySchema.nullable() }).strict();
export type SqliteAccessStatsDay = z.infer<typeof sqliteAccessStatsDaySchema>;
export const sqliteAccessStatsDailyResponseSchema = response.extend({ source: sqliteAccessStatsSourceRecordSchema,
  resource: accessStatsResourceSchema, from_date_utc: z.iso.date(), to_date_utc: z.iso.date(),
  coverage: sqliteAccessStatsCoverageSchema, period: accessStatsCountersSchema.nullable(),
  days: z.array(sqliteAccessStatsDaySchema).max(SQLITE_ACCESS_STATS_DAILY_PAGE_SIZE), next_cursor: cursor.nullable(),
}).strict();
export type SqliteAccessStatsDailyResponse = z.infer<typeof sqliteAccessStatsDailyResponseSchema>;
export const sqliteAccessStatsReplaceResponseSchema = response.extend({ result: z.enum(["changed", "unchanged"]),
  source: sqliteAccessStatsSourceRecordSchema, record: sqliteAccessStatsStoredDailySchema }).strict();
export type SqliteAccessStatsReplaceResponse = z.infer<typeof sqliteAccessStatsReplaceResponseSchema>;
