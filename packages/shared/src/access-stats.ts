import { z } from "zod";
import { parsePublicAssetPath } from "./public-assets";
import { sqlitePublicationTargetSchema } from "./sqlite-publication";

export const ACCESS_STATS_FORMAT = "access-daily-v1" as const;

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const resource = z.object({
  show_id: sqlitePublicationTargetSchema.shape.show_id,
  resource_path: z.string(),
  resource_kind: z.enum(["audio", "cover"]),
  episode_id: sqlitePublicationTargetSchema.shape.episode_id.unwrap().nullable(),
  audio_revision_id: z.uuid().nullable(),
}).strict();

function matchesResourcePath(value: z.infer<typeof resource>): boolean {
  const asset = parsePublicAssetPath(value.resource_path);
  if (!asset || asset.kind !== value.resource_kind || asset.showId !== value.show_id) return false;
  return asset.kind === "audio"
    ? asset.episodeId === value.episode_id && asset.revisionId === value.audio_revision_id
    : value.episode_id === null && value.audio_revision_id === null;
}

export const accessStatsResourceSchema = resource.refine(matchesResourcePath, {
  path: ["resource_path"], message: "Access statistics resource differs from its public path",
});
export type AccessStatsResource = z.infer<typeof accessStatsResourceSchema>;

export const accessStatsEventSchema = resource.extend({
  source_id: z.string().min(1),
  event_id: z.string().min(1),
  occurred_at_ms: counter,
  host: z.string().min(1),
  method: z.enum(["GET", "HEAD"]),
  status: z.union([z.literal(200), z.literal(206), z.literal(304)]),
  response_bytes: counter,
  cache_status: z.string().min(1).nullable(),
}).strict().refine(matchesResourcePath, {
  path: ["resource_path"], message: "Access statistics resource differs from its public path",
}).refine((value) => (value.method !== "HEAD" && value.status !== 304) || value.response_bytes === 0, {
  path: ["response_bytes"], message: "HEAD and 304 access records have no response body",
});
export type AccessStatsEvent = z.infer<typeof accessStatsEventSchema>;

export const accessStatsCountersSchema = z.object({
  get_200_requests: counter,
  get_206_requests: counter,
  head_requests: counter,
  not_modified_requests: counter,
  response_bytes: counter,
  cache_status_requests: z.record(z.string().min(1), counter),
}).strict().refine((value) => Object.values(value.cache_status_requests).reduce((total, count) => total + count, 0) ===
  value.get_200_requests + value.get_206_requests + value.head_requests + value.not_modified_requests, {
  path: ["cache_status_requests"], message: "Cache counters differ from the observed response count",
});
export type AccessStatsCounters = z.infer<typeof accessStatsCountersSchema>;

export const accessStatsDailySchema = resource.extend({
  format: z.literal(ACCESS_STATS_FORMAT),
  source_id: z.string().min(1),
  date_utc: z.iso.date(),
  counters: accessStatsCountersSchema,
}).strict().refine(matchesResourcePath, {
  path: ["resource_path"], message: "Access statistics resource differs from its public path",
});
export type AccessStatsDaily = z.infer<typeof accessStatsDailySchema>;
