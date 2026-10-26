import { z } from "zod";
import { episodeDraftSchema, episodeDraftFromRevision, episodeRevisionSchema, showMetadataSchema } from "./index";
import type { EpisodeDraft, ShowMetadata } from "./index";
import { sqliteAvailabilityStateSchema } from "./sqlite-availability";
import { sqlitePublicationProtocol, sqlitePublicationRequestSchema, sqlitePublicationRuntimeSchema } from "./sqlite-publication";

export const SQLITE_REVISION_PAGE_SIZE = 20;
const slug = (maximum: number) => z.string().max(maximum).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCounter = counter.refine((value) => value > 0, "Expected a positive integer");

export const sqliteCoverSnapshotSchema = z.object({
  extension: z.enum(["jpg", "png"]),
  generation: positiveCounter,
  sha256: hash,
  length_bytes: z.number().int().positive().max(5_000_000),
  public_url: z.url(),
}).strict();

export const sqliteAudioSnapshotSchema = z.object({
  audio_revision_id: z.uuid(),
  sha256: hash,
  length_bytes: z.number().int().positive().max(300_000_000),
  duration_seconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  enclosure_url: z.url(),
}).strict();

export const sqliteShowRevisionRecordSchema = z.object({
  show_id: slug(32),
  revision_sequence: positiveCounter,
  state_version: positiveCounter,
  revision_id: z.uuid(),
  metadata: showMetadataSchema,
  metadata_sha256: hash,
  cover: sqliteCoverSnapshotSchema,
  restored_from_revision_id: z.uuid().nullable(),
  updated_at: z.string().min(1).max(64),
}).strict().superRefine((value, context) => {
  if (value.metadata.show_id !== value.show_id) {
    context.addIssue({ code: "custom", message: "Show revision metadata differs from its Show ID" });
  }
});

export const sqliteShowRevisionSummarySchema = z.object({
  show_id: slug(32),
  revision_sequence: positiveCounter,
  state_version: positiveCounter,
  revision_id: z.uuid(),
  title: z.string().min(1).max(200),
  metadata_sha256: hash,
  cover: sqliteCoverSnapshotSchema,
  restored_from_revision_id: z.uuid().nullable(),
  updated_at: z.string().min(1).max(64),
  is_current: z.boolean(),
}).strict();

export const sqliteEpisodeRevisionRecordSchema = z.object({
  show_id: slug(32),
  episode_id: slug(80),
  revision_sequence: positiveCounter,
  revision_id: z.uuid(),
  metadata: episodeDraftSchema,
  metadata_sha256: hash,
  revision: episodeRevisionSchema,
  audio: sqliteAudioSnapshotSchema,
  restored_from_revision_id: z.uuid().nullable(),
  updated_at: z.string().min(1).max(64),
}).strict().superRefine((value, context) => {
  if (value.metadata.episode_id !== value.episode_id || value.revision.episode_id !== value.episode_id ||
    value.revision.revision_id !== value.revision_id || value.revision.sha256 !== value.audio.sha256 ||
    value.revision.length_bytes !== value.audio.length_bytes || value.revision.duration_seconds !== value.audio.duration_seconds ||
    JSON.stringify(episodeDraftFromRevision(value.revision)) !== JSON.stringify(value.metadata) ||
    value.revision.enclosure_url !== value.audio.enclosure_url || value.revision.updated_at !== value.updated_at) {
    context.addIssue({ code: "custom", message: "Episode revision record has inconsistent identity or media" });
  }
});

export const sqliteEpisodeRevisionSummarySchema = z.object({
  show_id: slug(32),
  episode_id: slug(80),
  revision_sequence: positiveCounter,
  revision_id: z.uuid(),
  title: z.string().min(1).max(200),
  published_at: z.string().min(1).max(64),
  metadata_sha256: hash,
  audio: sqliteAudioSnapshotSchema,
  restored_from_revision_id: z.uuid().nullable(),
  updated_at: z.string().min(1).max(64),
  is_current: z.boolean(),
}).strict();

export const sqliteContentSnapshotSchema = sqlitePublicationRuntimeSchema.extend({
  protocol: z.literal(sqlitePublicationProtocol),
  publication_ready: z.literal(true),
  state: sqliteAvailabilityStateSchema,
  admission_window_id: z.uuid().nullable(),
  show_id: slug(32),
  episode_id: slug(80).optional(),
  show_lifecycle: z.enum(["missing", "draft", "published", "unpublished", "deleted"]),
  reservation_id: z.uuid().nullable(),
  expected_show_state_version: counter.nullable(),
  feed_generation: counter.nullable(),
  published_episode_count: counter,
  published_inventory_chars: counter,
  show_content: sqliteShowRevisionRecordSchema.nullable(),
  episode_lifecycle: z.enum(["missing", "published", "unpublished", "deleted"]).optional(),
  expected_episode_lifecycle_version: counter.optional(),
  episode_content: sqliteEpisodeRevisionRecordSchema.nullable().optional(),
  snapshot_only: z.literal(true),
  authorizes_recovery: z.literal(false),
}).strict().superRefine((value, context) => {
  const hasShowContent = ["published", "unpublished"].includes(value.show_lifecycle);
  const hasEpisode = value.episode_id !== undefined;
  const hasEpisodeContent = hasEpisode && ["published", "unpublished"].includes(value.episode_lifecycle ?? "missing");
  if (hasShowContent !== (value.show_content !== null) ||
    value.show_content && value.show_content.show_id !== value.show_id ||
    value.show_content && (value.expected_show_state_version === null || value.show_content.state_version > value.expected_show_state_version) ||
    hasEpisode !== (value.episode_lifecycle !== undefined && value.expected_episode_lifecycle_version !== undefined && value.episode_content !== undefined) ||
    hasEpisode && hasEpisodeContent !== (value.episode_content !== null) ||
    value.episode_content && (value.episode_content.show_id !== value.show_id || value.episode_content.episode_id !== value.episode_id)) {
    context.addIssue({ code: "custom", message: "Content snapshot has inconsistent Show or Episode evidence" });
  }
});

export const sqliteRevisionListResponseSchema = sqlitePublicationRuntimeSchema.extend({
  protocol: z.literal(sqlitePublicationProtocol),
  publication_ready: z.literal(true),
  state: sqliteAvailabilityStateSchema,
  kind: z.enum(["show", "episode"]),
  show_id: slug(32),
  episode_id: slug(80).optional(),
  show_lifecycle: z.enum(["missing", "draft", "published", "unpublished", "deleted"]),
  expected_show_state_version: counter.nullable(),
  current_show_revision_id: z.uuid().nullable(),
  episode_lifecycle: z.enum(["missing", "published", "unpublished", "deleted"]).optional(),
  expected_episode_lifecycle_version: counter.optional(),
  current_episode_revision_id: z.uuid().nullable().optional(),
  next_cursor: positiveCounter.nullable(),
  show_revisions: z.array(sqliteShowRevisionSummarySchema).max(SQLITE_REVISION_PAGE_SIZE).optional(),
  episode_revisions: z.array(sqliteEpisodeRevisionSummarySchema).max(SQLITE_REVISION_PAGE_SIZE).optional(),
  snapshot_only: z.literal(true),
  authorizes_recovery: z.literal(false),
}).strict().superRefine((value, context) => {
  const isEpisode = value.kind === "episode";
  const sequences = isEpisode ? value.episode_revisions?.map((item) => item.revision_sequence) : value.show_revisions?.map((item) => item.revision_sequence);
  if (isEpisode !== (value.episode_id !== undefined && value.episode_lifecycle !== undefined && value.expected_episode_lifecycle_version !== undefined &&
    value.current_episode_revision_id !== undefined && value.episode_revisions !== undefined && value.show_revisions === undefined) ||
    !isEpisode && (value.show_revisions === undefined || value.episode_revisions !== undefined) ||
    !sequences || sequences.some((seq, index) => index > 0 && seq >= sequences[index - 1]!) ||
    value.next_cursor !== null && (sequences.length !== SQLITE_REVISION_PAGE_SIZE || value.next_cursor !== sequences[sequences.length - 1])) {
    context.addIssue({ code: "custom", message: "Revision history page differs from its target or ordering" });
  }
});

export const sqliteRevisionDetailResponseSchema = sqlitePublicationRuntimeSchema.extend({
  protocol: z.literal(sqlitePublicationProtocol),
  publication_ready: z.literal(true),
  state: sqliteAvailabilityStateSchema,
  admission_window_id: z.uuid().nullable(),
  kind: z.enum(["show", "episode"]),
  show_id: slug(32),
  episode_id: slug(80).optional(),
  show_lifecycle: z.enum(["published", "unpublished"]),
  expected_show_state_version: positiveCounter,
  current_show: sqliteShowRevisionRecordSchema,
  target_show_revision: sqliteShowRevisionRecordSchema.optional(),
  episode_lifecycle: z.enum(["published", "unpublished"]).optional(),
  expected_episode_lifecycle_version: counter.optional(),
  current_episode: sqliteEpisodeRevisionRecordSchema.optional(),
  target_episode_revision: sqliteEpisodeRevisionRecordSchema.optional(),
  snapshot_only: z.literal(true),
  authorizes_recovery: z.literal(false),
}).strict().superRefine((value, context) => {
  const isEpisode = value.kind === "episode";
  if (value.current_show.show_id !== value.show_id ||
    value.current_show.state_version > value.expected_show_state_version ||
    isEpisode !== (value.episode_id !== undefined && value.episode_lifecycle !== undefined && value.expected_episode_lifecycle_version !== undefined &&
      value.current_episode !== undefined && value.target_episode_revision !== undefined && value.target_show_revision === undefined) ||
    !isEpisode && value.target_show_revision === undefined ||
    value.target_show_revision && value.target_show_revision.show_id !== value.show_id ||
    value.current_episode && (value.current_episode.show_id !== value.show_id || value.current_episode.episode_id !== value.episode_id) ||
    value.target_episode_revision && (value.target_episode_revision.show_id !== value.show_id || value.target_episode_revision.episode_id !== value.episode_id)) {
    context.addIssue({ code: "custom", message: "Revision detail response differs from its target" });
  }
});

export const sqliteMetadataFieldDiffSchema = z.object({
  field: z.string().min(1).max(64),
  changed: z.boolean(),
  published: z.unknown(),
  candidate: z.unknown(),
}).strict();

export type SqliteCoverSnapshot = z.infer<typeof sqliteCoverSnapshotSchema>;
export type SqliteAudioSnapshot = z.infer<typeof sqliteAudioSnapshotSchema>;
export type SqliteShowRevisionRecord = z.infer<typeof sqliteShowRevisionRecordSchema>;
export type SqliteShowRevisionSummary = z.infer<typeof sqliteShowRevisionSummarySchema>;
export type SqliteEpisodeRevisionRecord = z.infer<typeof sqliteEpisodeRevisionRecordSchema>;
export type SqliteEpisodeRevisionSummary = z.infer<typeof sqliteEpisodeRevisionSummarySchema>;
export type SqliteContentSnapshot = z.infer<typeof sqliteContentSnapshotSchema>;
export type SqliteRevisionListResponse = z.infer<typeof sqliteRevisionListResponseSchema>;
export type SqliteRevisionDetailResponse = z.infer<typeof sqliteRevisionDetailResponseSchema>;
export type SqliteMetadataFieldDiff = z.infer<typeof sqliteMetadataFieldDiffSchema>;

const SHOW_DIFF_FIELDS = ["title", "description", "language", "author", "owner_name", "owner_email",
  "categories", "explicit", "site_mode", "site_url", "site_css_path", "site_css", "image_path", "copyright", "show_type"] as const;
const EPISODE_DIFF_FIELDS = ["episode_id", "guid", "guid_is_permalink", "title", "description",
  "published_at", "explicit", "episode_type", "season_number", "episode_number"] as const;

export function diffShowMetadataFields(published: ShowMetadata | null, candidate: ShowMetadata): SqliteMetadataFieldDiff[] {
  return SHOW_DIFF_FIELDS.map((field) => {
    const before = published ? (published[field] ?? null) : null;
    const after = candidate[field] ?? null;
    return { field, changed: published === null || JSON.stringify(before) !== JSON.stringify(after), published: before, candidate: after };
  });
}

export function diffEpisodeDraftFields(published: EpisodeDraft | null, candidate: EpisodeDraft): SqliteMetadataFieldDiff[] {
  return EPISODE_DIFF_FIELDS.map((field) => {
    const before = published ? (field === "guid_is_permalink" ? (published.guid_is_permalink ?? false) : (published[field] ?? null)) : null;
    const after = field === "guid_is_permalink" ? (candidate.guid_is_permalink ?? false) : (candidate[field] ?? null);
    return { field, changed: published === null || JSON.stringify(before) !== JSON.stringify(after), published: before, candidate: after };
  });
}

const revisionRequestSchema = sqlitePublicationRequestSchema.refine((value) => value.action === "restore_revision",
  "Revision restoration plans require restore_revision action");
export const sqliteRevisionPlanSchema = z.object({
  request: revisionRequestSchema,
  request_sha256: sqlitePublicationRequestSchema.shape.service_config_sha256,
}).strict();
export type SqliteRevisionPlan = z.infer<typeof sqliteRevisionPlanSchema>;

export const sqlitePreviewInventorySchema = sqlitePublicationRuntimeSchema.extend({
  show_id: slug(32), feed_generation: counter, after: slug(80).nullable(),
  episodes: z.array(episodeRevisionSchema).max(20), next_cursor: slug(80).nullable(),
}).strict();
