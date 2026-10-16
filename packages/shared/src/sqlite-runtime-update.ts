import { z } from "zod";
import { sqlitePublicationRuntimeSchema } from "./sqlite-publication";

export const sqliteUpdatePrepareSchema = sqlitePublicationRuntimeSchema.extend({ operation_id: z.uuid(), worker_source_sha256: sqlitePublicationRuntimeSchema.shape.service_config_sha256,
  worker_metadata_sha256: sqlitePublicationRuntimeSchema.shape.service_config_sha256, namespace_id: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
export const sqliteUpdateActivateSchema = sqliteUpdatePrepareSchema.extend({ new_worker_version_id: z.uuid(), deployment_id: z.uuid(),
  script_etag: z.string().min(1).max(256) }).strict();
export const sqliteUpdateSummarySchema = z.object({ operation_id: z.uuid(), state: z.enum(["prepared", "activated", "completed", "blocked"]),
  previous_worker_version_id: z.uuid(), new_worker_version_id: z.uuid().nullable() }).strict();
export const sqliteUpdateResultSchema = sqlitePublicationRuntimeSchema.extend({ protocol: z.literal("sqlite-sequential-v1"),
  request: sqliteUpdatePrepareSchema, update: sqliteUpdateSummarySchema, paused: z.literal(true), drained: z.literal(true) }).strict();
export type SqliteUpdatePrepare = z.infer<typeof sqliteUpdatePrepareSchema>;
export type SqliteUpdateActivate = z.infer<typeof sqliteUpdateActivateSchema>;
export type SqliteUpdateSummary = z.infer<typeof sqliteUpdateSummarySchema>;
export type SqliteUpdateResult = z.infer<typeof sqliteUpdateResultSchema>;
