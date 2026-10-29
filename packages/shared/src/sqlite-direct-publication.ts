import { z } from "zod";
import { episodeDraftInputSchema, showMetadataInputSchema } from "./metadata";
import { sqliteAudioReferenceSchema, sqliteCoverReferenceSchema } from "./sqlite-media";
import { MAX_SQLITE_PUBLICATION_BYTES, sqlitePublicationProtocol, sqlitePublicationRuntimeSchema, sqliteServiceIdentitySchema } from "./sqlite-publication";
import { diffEpisodeDraftFields, diffShowMetadataFields } from "./sqlite-revisions";
import type { SqliteContentSnapshot } from "./sqlite-revisions";
import { sha256Hex } from "./sha256";

// Retain the existing 1 MB metadata allowance plus the management envelope.
export const MAX_SQLITE_DIRECT_PUBLICATION_BYTES = 1_000_000 + MAX_SQLITE_PUBLICATION_BYTES;
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const common = sqliteServiceIdentitySchema.extend({
  schema_version: z.literal(1), protocol: z.literal(sqlitePublicationProtocol),
  show_id: z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  episode_id: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  base_revision_id: z.uuid().optional(), expected_episode_lifecycle_version: counter.optional(),
  expected_show_state_version: counter,
});

export const sqliteDirectPublishRequestSchema = z.discriminatedUnion("kind", [
  common.extend({ action: z.literal("publish"), kind: z.literal("show"), metadata: showMetadataInputSchema, cover: sqliteCoverReferenceSchema }).strict(),
  common.extend({ action: z.literal("publish"), kind: z.literal("episode"), metadata: episodeDraftInputSchema, audio: sqliteAudioReferenceSchema,
    episode_id: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    base_revision_id: z.uuid().optional(), expected_episode_lifecycle_version: counter,
  }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "show") {
    if (value.episode_id !== undefined || value.base_revision_id !== undefined || value.expected_episode_lifecycle_version !== undefined || value.metadata.show_id !== value.show_id ||
      (value.metadata.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg") !== value.cover.extension ||
      (value.metadata.site_css_path !== undefined) !== (value.metadata.site_css !== undefined)) {
      context.addIssue({ code: "custom", message: "Show metadata and cover must match their publication target" });
    }
  } else if (value.metadata.episode_id !== value.episode_id) {
    context.addIssue({ code: "custom", message: "Episode metadata must match its publication target" });
  }
});

export const sqliteContentActionRequestSchema = common.extend({ kind: z.enum(["show", "episode"]),
  action: z.enum(["unpublish", "restore", "restore_revision"]), target_revision_id: z.uuid().optional(),
}).strict().superRefine((value, context) => {
  if ((value.action === "restore_revision") !== (value.target_revision_id !== undefined) ||
    (value.kind === "show" ? value.episode_id !== undefined || value.base_revision_id !== undefined || value.expected_episode_lifecycle_version !== undefined :
      value.episode_id === undefined || value.base_revision_id === undefined || value.expected_episode_lifecycle_version === undefined)) {
    context.addIssue({ code: "custom", message: "Content action requires an exact target and base" });
  }
});
export const sqliteDirectPublicationRequestSchema = z.union([sqliteDirectPublishRequestSchema, sqliteContentActionRequestSchema]);
export type SqliteDirectPublishRequest = z.infer<typeof sqliteDirectPublishRequestSchema>;
export type SqliteDirectPublicationRequest = z.infer<typeof sqliteDirectPublicationRequestSchema>;
export type SqliteContentMutation = z.infer<typeof common> & { kind: "show" | "episode";
  action: SqliteDirectPublicationRequest["action"]; target_revision_id?: string; revision_id: string };

export function parseSqliteDirectPublicationRequest(input: unknown): SqliteDirectPublicationRequest {
  const request = sqliteDirectPublicationRequestSchema.parse(input);
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_SQLITE_DIRECT_PUBLICATION_BYTES) {
    throw new Error("SQLite publication request exceeds its size limit");
  }
  return request;
}

export async function sqliteDirectPublicationRequestHash(input: SqliteDirectPublicationRequest): Promise<string> {
  return sha256Hex(JSON.stringify(parseSqliteDirectPublicationRequest(input)));
}

export const sqliteDirectPublicationResultSchema = sqlitePublicationRuntimeSchema.extend({
  protocol: z.literal(sqlitePublicationProtocol), show_id: common.shape.show_id,
  episode_id: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  result: z.enum(["changed", "unchanged"]), revision_id: z.uuid(),
}).strict();
export type SqliteDirectPublicationResult = z.infer<typeof sqliteDirectPublicationResultSchema>;

export function sameSqlitePublicationContent(request: SqliteDirectPublishRequest, current: Pick<SqliteContentSnapshot,
  "service_id" | "show_id" | "episode_id" | "show_lifecycle" | "show_content" | "episode_content"> & { episode_lifecycle?: string }): boolean {
  if (request.service_id !== current.service_id || request.show_id !== current.show_id || current.show_lifecycle !== "published") return false;
  if (request.kind === "show") {
    const saved = current.show_content;
    return !!saved && !diffShowMetadataFields(saved.metadata, request.metadata).some((field) => field.changed) &&
      saved.cover.extension === request.cover.extension && saved.cover.sha256 === request.cover.sha256 &&
      saved.cover.length_bytes === request.cover.length_bytes;
  }
  const saved = current.episode_content;
  return request.episode_id === current.episode_id && current.episode_lifecycle === "published" && !!saved &&
    !diffEpisodeDraftFields(saved.metadata, request.metadata).some((field) => field.changed) &&
    saved.audio.sha256 === request.audio.sha256 && saved.audio.length_bytes === request.audio.length_bytes &&
    saved.audio.duration_seconds === request.audio.duration_seconds;
}
