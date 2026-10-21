import { z } from "zod";
import { sqlitePublicationProtocol, sqlitePublicationRuntimeSchema } from "./sqlite-publication";
import { sqliteUpdateSummarySchema } from "./sqlite-runtime-update";

export const sqliteRuntimeRequestSchema = sqlitePublicationRuntimeSchema.extend({ operation_id: z.uuid() }).strict();
export const sqliteResumeRequestSchema = sqliteRuntimeRequestSchema.extend({ admission_window_id: z.uuid() }).strict();
export const sqliteRegistrationSchema = sqliteRuntimeRequestSchema.extend({ show_id: z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  reservation_id: z.uuid() }).strict();
export const sqliteRegistryStatusSchema = z.object({ show_id: sqliteRegistrationSchema.shape.show_id,
  reservation_id: z.uuid().nullable(), state: z.enum(["missing", "requested", "registered"]) }).strict();
export const sqliteHealthSchema = sqlitePublicationRuntimeSchema.extend({ protocol: z.literal(sqlitePublicationProtocol),
  scope: z.enum(["service", "show"]).optional(), show_id: sqliteRegistrationSchema.shape.show_id.optional(),
  show_count: z.number().int().nonnegative().optional(), paused_shows: z.number().int().nonnegative().optional(),
  maintenance_operation_id: z.uuid().nullable().optional(),
  maintenance: z.object({ operation_id: z.uuid(), phase: z.enum(["preparing", "prepared", "activating", "probing", "releasing"]) }).strict().nullable().optional(),
  invocation_id: z.uuid(), publication_ready: z.boolean(), state: z.enum(["open", "paused"]), admission_window_id: z.uuid().nullable(),
  queued: z.number().int().nonnegative(), active: z.enum(["running", "blocked"]).nullable(), drained: z.boolean(),
  setup: z.object({ operation_id: z.uuid(), state: z.enum(["scheduled", "running", "ready", "blocked"]) }).strict().nullable(),
  runtime_update: sqliteUpdateSummarySchema.nullable().optional(),
}).strict();
export const sqliteInspectionSchema = sqlitePublicationRuntimeSchema.extend({ protocol: z.literal(sqlitePublicationProtocol),
  state: z.enum(["open", "paused"]), admission_window_id: z.uuid().nullable(), publication_ready: z.literal(true),
  show_id: sqliteRegistrationSchema.shape.show_id, episode_id: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  show_lifecycle: z.enum(["missing", "draft", "published", "unpublished", "deleted"]),
  reservation_id: z.uuid().nullable(), expected_show_state_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
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
