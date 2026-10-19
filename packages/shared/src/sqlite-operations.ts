import { z } from "zod";
import { sha256Hex } from "./sha256";
import { sqlitePublicationRuntimeSchema, sqliteVerifiedUploadSchema, sqliteUploadKey } from "./sqlite-publication";

const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const slug = (maximum: number) => z.string().max(maximum).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const operationStateSchema = z.enum(["prepared", "in_progress", "succeeded", "failed", "blocked", "cancelled"]);
export const operationPhaseSchema = z.enum(["prepared", "put_requested", "put_acknowledged", "verified", "attached",
  "queued", "running", "completed", "cancelled", "cleanup_requested", "cleanup_unknown", "command_requested", "step_completed"]);
export const operationReasonSchema = z.enum(["version_conflict", "target_conflict", "state_conflict", "asset_conflict",
  "capacity_insufficient", "execution_interrupted", "validation_unavailable", "execution_failed", "stored_request_invalid",
  "validation_failed", "base_conflict", "target_unavailable", "stale_window", "runtime_mismatch", "deletion_unverified"]);
export const operationActionSchema = z.enum(["register", "begin_upload", "report_upload", "verify_upload", "attach_asset",
  "submit_publication", "resume", "cancel", "cleanup"]);
export const operationSpecSchema = z.object({ operation_id: uuid, parent_operation_id: uuid.optional(), import_id: uuid.optional(),
  kind: z.enum(["rss_import", "show_registration", "local_install", "upload", "publication", "cleanup"]),
  target_kind: z.enum(["show", "episode"]), show_id: slug(32), episode_id: slug(80).optional(), job_id: uuid.optional(),
  worker_version_id: uuid, service_config_sha256: hash, admission_window_id: uuid.optional(),
  expected_show_state_version: counter.optional(), expected_episode_lifecycle_version: counter.optional(),
  base_revision_id: uuid.optional(), base_metadata_sha256: hash.optional(), input_sha256: hash,
}).strict().superRefine((value, context) => {
  if ((value.target_kind === "episode") !== (value.episode_id !== undefined) || value.parent_operation_id === value.operation_id ||
    value.kind === "rss_import" && value.import_id !== value.operation_id || value.kind === "publication" && value.job_id !== value.operation_id ||
    value.kind === "upload" && (!value.job_id || value.expected_show_state_version === undefined || !value.admission_window_id)) {
    context.addIssue({ code: "custom", message: "Operation identity or target is inconsistent" });
  }
});
export const operationAssetIntentSchema = z.object({ upload_id: uuid, asset: sqliteVerifiedUploadSchema.shape.asset,
  key: sqliteVerifiedUploadSchema.shape.key, length_bytes: sqliteVerifiedUploadSchema.shape.length_bytes, sha256: hash,
  duration_seconds: sqliteVerifiedUploadSchema.shape.duration_seconds,
}).strict().superRefine((value, context) => {
  if ((value.asset === "audio") !== (value.duration_seconds !== undefined) ||
    value.asset.endsWith("metadata") && value.length_bytes > 1_000_000 || value.asset.startsWith("cover_") && value.length_bytes > 5_000_000) {
    context.addIssue({ code: "custom", message: "Upload asset size or duration is invalid" });
  }
});
export const operationCommandSchema = z.object({ schema_version: z.literal(1), service_id: slug(20),
  worker_version_id: uuid, service_config_sha256: hash, operation_id: uuid, request_id: uuid, expected_version: counter,
  action: z.enum(["register", "begin_upload", "report_upload", "verify_upload", "attach_asset", "resume", "cancel", "cleanup"]),
  operation: operationSpecSchema.optional(), assets: z.array(operationAssetIntentSchema).min(1).max(2).optional(),
  upload_id: uuid.optional(), receipt: z.object({ etag: sqliteVerifiedUploadSchema.shape.etag, version: sqliteVerifiedUploadSchema.shape.version }).strict().optional(),
  phase: z.enum(["command_requested", "step_completed", "completed"]).optional(),
  cleanup: z.object({ source_operation_id: uuid, source_version: counter, plan_sha256: hash }).strict().optional(),
  estimated_operations: z.number().int().positive().max(100000).optional(),
  estimated_content_bytes: counter.optional(),
}).strict().superRefine((value, context) => {
  const assetAction = ["begin_upload", "report_upload", "verify_upload", "attach_asset"].includes(value.action);
  if ((value.action === "register") !== (value.operation !== undefined) || assetAction !== (value.upload_id !== undefined) ||
    (value.action === "report_upload") !== (value.receipt !== undefined) ||
    (value.action === "cleanup") !== (value.cleanup !== undefined) ||
    value.phase !== undefined && value.action !== "resume" ||
    value.estimated_operations !== undefined && (value.action !== "register" || value.operation?.kind !== "rss_import") ||
    value.estimated_content_bytes !== undefined && (value.action !== "register" || value.operation?.kind !== "rss_import") ||
    value.assets !== undefined && (value.action !== "register" || value.operation?.kind !== "upload") ||
    value.operation?.kind === "upload" && !value.assets || value.operation && (value.operation.operation_id !== value.operation_id ||
      value.operation.worker_version_id !== value.worker_version_id || value.operation.service_config_sha256 !== value.service_config_sha256)) {
    context.addIssue({ code: "custom", message: "Operation command fields differ from its action" });
  }
  if (value.assets && value.operation) {
    const operation = value.operation;
    if (new Set(value.assets.map((asset) => asset.upload_id)).size !== value.assets.length ||
      new Set(value.assets.map((asset) => asset.asset.startsWith("cover_") ? "cover" : asset.asset)).size !== value.assets.length ||
      value.assets.some((asset) => asset.key !== sqliteUploadKey({ show_id: operation.show_id,
        draft_job_id: operation.job_id!, upload_id: asset.upload_id, asset: asset.asset }) ||
        (operation.target_kind === "show" ? !["show_metadata", "cover_jpg", "cover_png"].includes(asset.asset) :
          !["episode_metadata", "audio"].includes(asset.asset)))) {
      context.addIssue({ code: "custom", message: "Upload assets differ from their operation" });
    }
  }
});
export const operationClientSchema = z.object({ client_id: uuid, cli_version: z.string().min(1).max(64).regex(/^[a-zA-Z0-9.+-]+$/) }).strict();
export const operationRowSchema = z.object({ ...operationSpecSchema.shape, parent_operation_id: uuid.nullable(), import_id: uuid.nullable(),
  episode_id: slug(80).nullable(), job_id: uuid.nullable(), admission_window_id: uuid.nullable(),
  expected_show_state_version: counter.nullable(), expected_episode_lifecycle_version: counter.nullable(),
  base_revision_id: uuid.nullable(), base_metadata_sha256: hash.nullable(), state: operationStateSchema, phase: operationPhaseSchema,
  version: counter, created_at_ms: counter, updated_at_ms: counter, finished_at_ms: counter.nullable(),
}).strict();
export const operationAssetRowSchema = z.object({ upload_id: uuid, operation_id: uuid,
  asset_kind: sqliteVerifiedUploadSchema.shape.asset, object_key: z.string().min(1).max(256), length_bytes: counter,
  sha256: hash, duration_seconds: z.number().positive().nullable(),
  upload_state: z.enum(["prepared", "put_requested", "put_acknowledged", "verified", "attached", "unknown", "cancelled"]),
  put_etag: z.string().nullable(), object_version: z.string().nullable(), put_acknowledged_at_ms: counter.nullable(),
  verified_at_ms: counter.nullable(), attached_at_ms: counter.nullable(), cleanup_operation_id: uuid.nullable(),
  deletion_state: z.enum(["none", "requested", "deleted", "unknown"]), deleted_at_ms: counter.nullable(),
}).strict();
export const operationRequestRowSchema = z.object({ request_id: uuid, operation_id: uuid, client_id: uuid,
  cli_version: operationClientSchema.shape.cli_version, action: operationActionSchema, request_sha256: hash,
  expected_version: counter, received_at_ms: counter, outcome: z.enum(["accepted", "applied", "rejected", "unknown"]),
  resolved_at_ms: counter.nullable(), reason_code: operationReasonSchema.nullable(),
}).strict();
export const operationEventRowSchema = z.object({ event_id: counter, operation_id: uuid, operation_version: counter,
  request_id: uuid.nullable(), upload_id: uuid.nullable(), actor_type: z.enum(["client", "worker"]), invocation_id: uuid,
  worker_version_id: uuid, state: operationStateSchema, phase: operationPhaseSchema,
  recorded_at_ms: counter, reason_code: operationReasonSchema.nullable(),
}).strict();
export const operationCapacitySchema = z.object({ database_bytes: counter.nullable(), planning_limit_bytes: z.literal(1_000_000_000),
  warning: z.enum(["normal", "half", "high", "critical", "unavailable"]), bytes_per_operation_budget: z.literal(20000),
  account_daily_usage: z.literal("unknown"),
}).strict();
export const operationListSchema = sqlitePublicationRuntimeSchema.extend({ schema_version: z.literal(1),
  operations: z.array(operationRowSchema).max(20), next_cursor: uuid.nullable(), capacity: operationCapacitySchema,
}).strict();
export const operationDetailSchema = sqlitePublicationRuntimeSchema.extend({ schema_version: z.literal(1),
  operation: operationRowSchema, assets: z.array(operationAssetRowSchema).max(2),
  requests: z.array(operationRequestRowSchema).max(50), events: z.array(operationEventRowSchema).max(50),
  next_event_version: counter.nullable(), next_request_cursor: uuid.nullable(), capacity: operationCapacitySchema,
  related_summary: z.array(z.object({ kind: operationSpecSchema.shape.kind, target_kind: operationSpecSchema.shape.target_kind,
    state: operationStateSchema, count: counter }).strict()).max(72),
  latest_operations: z.array(operationRowSchema).max(5),
}).strict();
export const operationResultSchema = sqlitePublicationRuntimeSchema.extend({ schema_version: z.literal(1),
  request: operationRequestRowSchema, operation: operationRowSchema,
}).strict();
export const operationCleanupPlanSchema = sqlitePublicationRuntimeSchema.extend({ schema_version: z.literal(1),
  source_operation_id: uuid, source_version: counter, assets: z.array(operationAssetRowSchema).max(2), plan_sha256: hash,
}).strict();
export type OperationSpec = z.infer<typeof operationSpecSchema>;
export type OperationCommand = z.infer<typeof operationCommandSchema>;
export type OperationClient = z.infer<typeof operationClientSchema>;
export type OperationRow = z.infer<typeof operationRowSchema>;
export type OperationAssetRow = z.infer<typeof operationAssetRowSchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;
export type OperationDetail = z.infer<typeof operationDetailSchema>;
export type OperationList = z.infer<typeof operationListSchema>;
export type OperationCleanupPlan = z.infer<typeof operationCleanupPlanSchema>;
export async function operationCommandHash(command: OperationCommand): Promise<string> {
  return sha256Hex(JSON.stringify(operationCommandSchema.parse(command)));
}
