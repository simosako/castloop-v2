import { z } from "zod";
import { sqlitePublicationProtocol, sqlitePublicationRuntimeSchema } from "./sqlite-publication";
import { sqliteUpdateSummarySchema } from "./sqlite-runtime-update";
import { sqliteAvailabilityStateSchema, sqliteAvailabilityRecordSchema } from "./sqlite-availability";
import { sqliteStatsRetentionRecordSchema } from "./sqlite-stats";

export const sqliteRuntimeRequestSchema = sqlitePublicationRuntimeSchema.extend({ operation_id: z.uuid() }).strict();
export const sqliteResumeRequestSchema = sqliteRuntimeRequestSchema.extend({ admission_window_id: z.uuid() }).strict();
export const sqliteRegistrationSchema = sqliteRuntimeRequestSchema.extend({ show_id: z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  reservation_id: z.uuid() }).strict();
export const sqliteRegistryStatusSchema = z.object({ show_id: sqliteRegistrationSchema.shape.show_id,
  reservation_id: z.uuid().nullable(), state: z.enum(["missing", "requested", "registered"]) }).strict();
export const sqliteHealthSchema = sqlitePublicationRuntimeSchema.extend({ protocol: z.literal(sqlitePublicationProtocol),
  feed_storage: z.literal("immutable-generation-v1"),
  cover_storage: z.literal("immutable-generation-v1"),
  publication_read_boundary: z.literal("show-episode-v1"),
  feed_generation_allocator: z.literal("reservation-v1"),
  domain_changes: z.literal("sqlite-domain-change-v1"),
  availability_controls: z.literal("show-admission-delivery-v1"),
  revision_history: z.literal("sqlite-revisions-v1"),
  website: z.literal("static-show-v2"),
  delivery_statistics: z.literal("episode-daily-v1"),
  availability_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  admission_state: z.enum(["open", "closed"]).nullable(), delivery_policy: z.enum(["enabled", "stopped"]).nullable(),
  scope: z.enum(["service", "show"]).optional(), show_id: sqliteRegistrationSchema.shape.show_id.optional(),
  show_count: z.number().int().nonnegative().optional(), paused_shows: z.number().int().nonnegative().optional(),
  open_shows: z.number().int().nonnegative().optional(), admission_paused_shows: z.number().int().nonnegative().optional(),
  maintenance_operation_id: z.uuid().nullable().optional(),
  maintenance: z.object({ operation_id: z.uuid(), phase: z.enum(["preparing", "prepared", "activating", "probing", "releasing"]) }).strict().nullable().optional(),
  invocation_id: z.uuid(), publication_ready: z.boolean(), state: sqliteAvailabilityStateSchema, admission_window_id: z.uuid().nullable(),
  queued: z.number().int().nonnegative(), active: z.enum(["running", "blocked"]).nullable(), drained: z.boolean(),
  setup: z.object({ operation_id: z.uuid(), state: z.enum(["scheduled", "running", "ready", "blocked"]) }).strict().nullable(),
  runtime_update: sqliteUpdateSummarySchema.nullable().optional(),
}).strict();
export const sqliteInspectionSchema = sqlitePublicationRuntimeSchema.extend({ protocol: z.literal(sqlitePublicationProtocol),
  revision_history: z.literal("sqlite-revisions-v1"),
  website: z.literal("static-show-v2"),
  state: sqliteAvailabilityStateSchema, admission_window_id: z.uuid().nullable(), publication_ready: z.literal(true),
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
export const sqliteAvailabilityResponseSchema = sqliteHealthSchema.extend({ control: sqliteAvailabilityRecordSchema }).strict().superRefine((value, context) => {
  if (value.scope !== "show" || value.show_id !== value.control.request.show_id || value.service_id !== value.control.request.service_id ||
    value.availability_version === null || value.availability_version < value.control.result.availability_version ||
    value.admission_state !== (value.state === "open" ? "open" : "closed") || value.delivery_policy !== (value.state === "paused" ? "stopped" : "enabled")) {
    context.addIssue({ code: "custom", message: "Current Show status differs from its control observation" });
  }
});
export type SqliteAvailabilityResponse = z.infer<typeof sqliteAvailabilityResponseSchema>;
export const sqliteStatsRetentionResponseSchema = sqliteHealthSchema.extend({
  retention: sqliteStatsRetentionRecordSchema,
}).strict().superRefine((value, context) => {
  if (value.scope !== "show" || value.show_id !== value.retention.request.show_id ||
    value.service_id !== value.retention.request.service_id) {
    context.addIssue({ code: "custom", message: "Delivery stats retention scope differs from its record" });
  }
});
export type SqliteStatsRetentionResponse = z.infer<typeof sqliteStatsRetentionResponseSchema>;
