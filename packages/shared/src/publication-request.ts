import { z } from "zod";
import { controlRequestSchema } from "./lifecycle";
import { publishedTimestampSchema } from "./metadata-time";

export const showCommitSchema = z.object({
  schema_version: z.literal(1), kind: z.literal("show"), show_id: controlRequestSchema.shape.show_id, job_id: z.uuid(),
  metadata_sha256: z.string().regex(/^[a-f0-9]{64}$/), cover_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  cover_extension: z.enum(["jpg", "png"]),
}).strict();

export const episodeCommitSchema = z.object({
  schema_version: z.literal(1), kind: z.literal("episode"), show_id: controlRequestSchema.shape.show_id,
  episode_id: controlRequestSchema.shape.episode_id.unwrap(), job_id: z.uuid(), base_revision_id: z.uuid().optional(),
  metadata_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), audio_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  audio_length_bytes: z.number().int().positive().max(300_000_000).optional(), duration_seconds: z.number().int().positive().optional(),
  committed_at: publishedTimestampSchema,
}).strict().superRefine((value, context) => {
  const hasAudio = value.audio_sha256 !== undefined;
  if (hasAudio !== (value.audio_length_bytes !== undefined) || hasAudio !== (value.duration_seconds !== undefined)) {
    context.addIssue({ code: "custom", message: "Audio checksum, length and duration must be provided together" });
  }
  if (!value.base_revision_id && (!value.metadata_sha256 || !hasAudio)) {
    context.addIssue({ code: "custom", message: "Initial publication requires both metadata and audio" });
  }
  if (value.base_revision_id && !value.metadata_sha256 && !hasAudio) {
    context.addIssue({ code: "custom", message: "An update must change metadata or audio" });
  }
});

export const publicationRequestSchema = z.object({
  schema_version: z.literal(1), request: controlRequestSchema, commit: z.union([showCommitSchema, episodeCommitSchema]),
  staged_uploads: z.array(z.uuid()).min(1).max(2),
}).strict().superRefine((value, context) => {
  const episodeId = value.commit.kind === "episode" ? value.commit.episode_id : undefined;
  if (value.request.action !== "publish" || value.request.kind !== value.commit.kind ||
    value.request.job_id !== value.commit.job_id || value.request.show_id !== value.commit.show_id || value.request.episode_id !== episodeId) {
    context.addIssue({ code: "custom", message: "Publication commit must match its frozen control request" });
  }
  const count = value.commit.kind === "show" ? 1 : Number(value.commit.metadata_sha256 !== undefined) + Number(value.commit.audio_sha256 !== undefined);
  if (value.staged_uploads.length !== count || new Set(value.staged_uploads).size !== count || value.staged_uploads.includes(value.commit.job_id)) {
    context.addIssue({ code: "custom", message: "Publication requires distinct staging operations for its changed payloads" });
  }
});

export type PublicationRequest = z.infer<typeof publicationRequestSchema>;
