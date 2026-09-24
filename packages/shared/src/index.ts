import * as TOML from "@iarna/toml";
import { z } from "zod";
export { validateId } from "./ids";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = (max: number) => z.string().max(max).regex(SLUG);
const webUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname &&
    !url.username && !url.password && !url.hash;
}, "Expected an HTTP(S) URL without credentials or fragment");

export const serviceConfigSchema = z.object({
  schema_version: z.literal(1),
  service_id: ID(20),
  account_id: z.string().regex(/^[a-f0-9]{32}$/i),
  bucket_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  worker_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  queue_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  dlq_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  public_base_url: webUrl.refine((value) => value.startsWith("https://"),
    "The public Worker URL must use HTTPS"),
}).strict();

export const showMetadataSchema = z.object({
  schema_version: z.literal(1),
  show_id: ID(32),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  author: z.string().trim().min(1),
  owner_name: z.string().trim().min(1),
  owner_email: z.email(),
  categories: z.array(z.string().trim().min(1)).min(1),
  explicit: z.boolean(),
  site_url: webUrl,
  image_path: z.string().regex(/^[^/\\.][^/\\]*\.(?:jpg|jpeg|png)$/i),
  copyright: z.string().min(1).optional(),
  show_type: z.enum(["episodic", "serial"]).optional(),
}).strict();

const publishedAt = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/,
).refine((value) => {
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const offset = value.slice(19);
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return false;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return local.getUTCFullYear() === year && local.getUTCMonth() === month - 1 &&
    local.getUTCDate() === day && local.getUTCHours() === hour &&
    local.getUTCMinutes() === minute && local.getUTCSeconds() === second;
}, "Expected a valid RFC 3339 timestamp");

export const episodeDraftSchema = z.object({
  schema_version: z.literal(1),
  episode_id: ID(80),
  guid: z.uuid(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  published_at: publishedAt,
  explicit: z.boolean().optional(),
  episode_type: z.enum(["full", "trailer", "bonus"]).optional(),
  season_number: z.number().int().positive().optional(),
  episode_number: z.number().int().positive().optional(),
}).strict();

export const showCommitSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("show"),
  show_id: ID(32),
  job_id: z.uuid(),
  metadata_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  cover_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  cover_extension: z.enum(["jpg", "png"]),
}).strict();

export const episodeCommitSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("episode"),
  show_id: ID(32),
  episode_id: ID(80),
  job_id: z.uuid(),
  metadata_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  audio_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  audio_length_bytes: z.number().int().positive().max(300_000_000),
  duration_seconds: z.number().int().positive(),
  committed_at: publishedAt,
}).strict();

export const episodeRevisionSchema = episodeDraftSchema.extend({
  revision_id: z.uuid(),
  enclosure_url: webUrl,
  content_type: z.literal("audio/mpeg"),
  length_bytes: z.number().int().positive().max(300_000_000),
  duration_seconds: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  updated_at: publishedAt,
}).strict();

export const jobStatusSchema = z.object({
  schema_version: z.literal(1),
  job_id: z.uuid(),
  show_id: ID(32),
  kind: z.enum(["show", "episode"]),
  episode_id: ID(80).optional(),
  state: z.enum(["processing", "retrying", "failed", "published"]),
  reason: z.string().optional(),
}).strict();

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;
export type ShowMetadata = z.infer<typeof showMetadataSchema>;
export type EpisodeDraft = z.infer<typeof episodeDraftSchema>;
export type ShowCommit = z.infer<typeof showCommitSchema>;
export type EpisodeCommit = z.infer<typeof episodeCommitSchema>;
export type EpisodeRevision = z.infer<typeof episodeRevisionSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;

function parseToml(source: string): unknown {
  return TOML.parse(source);
}

export function parseServiceConfig(source: string): ServiceConfig {
  return serviceConfigSchema.parse(parseToml(source));
}

export function parseShowMetadata(source: string): ShowMetadata {
  return showMetadataSchema.parse(parseToml(source));
}

export function parseEpisodeDraft(source: string): EpisodeDraft {
  return episodeDraftSchema.parse(parseToml(source));
}

export function parseJobStatus(source: string): JobStatus {
  return jobStatusSchema.parse(parseToml(source));
}

export function parseEpisodeRevision(source: string): EpisodeRevision {
  return episodeRevisionSchema.parse(parseToml(source));
}

export function stringifyToml(value: ServiceConfig | ShowMetadata | EpisodeDraft | EpisodeRevision | JobStatus): string {
  return TOML.stringify(value as TOML.JsonMap);
}
