import { z } from "zod";
import { sqlitePublicationProtocol, sqlitePublicationRuntimeSchema, sqliteServiceIdentitySchema } from "./sqlite-publication";
import { sqliteStatsRetentionRecordSchema } from "./sqlite-stats";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const sqliteRuntimeRequestSchema = sqliteServiceIdentitySchema.extend({ operation_id: z.uuid() }).strict();
export const sqliteRegistrationSchema = sqliteRuntimeRequestSchema.extend({ show_id: z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  reservation_id: z.uuid() }).strict();
export const sqliteRegistryStatusSchema = z.object({ show_id: sqliteRegistrationSchema.shape.show_id,
  reservation_id: z.uuid().nullable(), state: z.enum(["missing", "requested", "registered"]) }).strict();
export const sqliteHealthSchema = sqlitePublicationRuntimeSchema.extend({ protocol: z.literal(sqlitePublicationProtocol),
  revision_history: z.literal("sqlite-revisions-v1"),
  website: z.literal("static-show-v2"),
  delivery_statistics: z.literal("episode-daily-v1"),
  domain_changes: z.literal("sqlite-domain-change-v1"),
  scope: z.enum(["service", "show"]).optional(), show_id: sqliteRegistrationSchema.shape.show_id.optional(),
  show_count: counter.optional(),
  invocation_id: z.uuid(), publication_ready: z.boolean(),
  schedules: z.object({ scheduled: counter, needs_approval: counter, dispatched: counter,
    next_scheduled_at_ms: counter.nullable() }).strict().optional(),
}).strict();
export const sqliteInspectionSchema = sqlitePublicationRuntimeSchema.extend({ protocol: z.literal(sqlitePublicationProtocol),
  revision_history: z.literal("sqlite-revisions-v1"),
  website: z.literal("static-show-v2"),
  publication_ready: z.literal(true),
  show_id: sqliteRegistrationSchema.shape.show_id, episode_id: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  show_lifecycle: z.enum(["missing", "draft", "published", "unpublished", "deleted"]),
  reservation_id: z.uuid().nullable(), expected_show_state_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  base_show_revision_id: z.uuid().optional(),
  base_show_metadata_sha256: sqlitePublicationRuntimeSchema.shape.service_config_sha256.optional(),
  base_cover_sha256: sqlitePublicationRuntimeSchema.shape.service_config_sha256.optional(),
  base_cover_extension: z.enum(["jpg", "png"]).optional(),
  base_cover_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  episode_lifecycle: z.enum(["missing", "published", "unpublished", "deleted"]).optional(),
  expected_episode_lifecycle_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  base_revision_id: z.uuid().optional(), base_metadata_sha256: sqlitePublicationRuntimeSchema.shape.service_config_sha256.optional(),
}).strict().superRefine((value, context) => {
  if ((value.episode_id !== undefined) !== (value.episode_lifecycle !== undefined) ||
    (value.episode_id !== undefined) !== (value.expected_episode_lifecycle_version !== undefined) ||
    (value.base_revision_id !== undefined) !== (value.base_metadata_sha256 !== undefined)) {
    context.addIssue({ code: "custom", message: "Target inspection has inconsistent Episode evidence" });
  }
});
export type SqliteRuntimeRequest = z.infer<typeof sqliteRuntimeRequestSchema>;
export type SqliteHealth = z.infer<typeof sqliteHealthSchema>;
export type SqliteInspection = z.infer<typeof sqliteInspectionSchema>;
export const sqliteStatsRetentionResponseSchema = sqliteHealthSchema.extend({
  retention: sqliteStatsRetentionRecordSchema,
}).strict().superRefine((value, context) => {
  if (value.scope !== "show" || value.show_id !== value.retention.request.show_id ||
    value.service_id !== value.retention.request.service_id) {
    context.addIssue({ code: "custom", message: "Delivery stats retention scope differs from its record" });
  }
});
export type SqliteStatsRetentionResponse = z.infer<typeof sqliteStatsRetentionResponseSchema>;
