import { z } from "zod";
import { controlRequestSchema, lifecycleStateSchema, showControlSchema } from "./lifecycle";
import { lifecycleCommitSchema } from "./lifecycle-commit";
import { lifecycleJobStatusSchema, lifecycleProgressSchema } from "./lifecycle-job";
import { serviceAdmissionSchema } from "./service-admission";

export const lifecycleOperationRequestSchema = controlRequestSchema.safeExtend({ action: lifecycleCommitSchema.shape.action });
const identity = { schema_version: z.literal(1), service_id: serviceAdmissionSchema.shape.service_id };
const confirmationSchema = z.object({ operator_confirmed: z.literal(true), request_sha256: lifecycleCommitSchema.shape.request_sha256,
  irreversible_delete_acknowledged: z.literal(true).optional(), retained_records_acknowledged: z.literal(true).optional() }).strict();

export const lifecycleAdminRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...identity, action: z.literal("dry-run"), request: lifecycleOperationRequestSchema,
    scope_index: z.number().int().min(0).max(4).optional(), cursor: z.string().min(1).max(4096).optional(),
    maximum_objects: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ ...identity, action: z.literal("claim"), request: lifecycleOperationRequestSchema, confirmation: confirmationSchema }).strict(),
  z.object({ ...identity, action: z.literal("commit"), request: lifecycleOperationRequestSchema, confirmation: confirmationSchema }).strict(),
  z.object({ ...identity, action: z.literal("status"), request: lifecycleOperationRequestSchema }).strict(),
  z.object({ ...identity, action: z.literal("retry"), request: lifecycleOperationRequestSchema, confirmation: confirmationSchema }).strict(),
]).superRefine((value, context) => {
  if (value.action === "status") return;
  if (value.action === "dry-run") {
    if (value.request.action !== "delete" && (value.scope_index !== undefined || value.cursor !== undefined || value.maximum_objects !== undefined)) {
      context.addIssue({ code: "custom", message: "Only deletion previews accept inventory paging" });
    }
    if (value.request.action === "delete" && (value.request.kind === "episode" && (value.scope_index ?? 0) > 2 ||
      value.request.kind === "show" && (value.scope_index ?? 0) === 0 && value.cursor !== undefined)) {
      context.addIssue({ code: "custom", message: "Deletion preview paging does not match its target scope" });
    }
    return;
  }
  const deletion = value.request.action === "delete";
  if (deletion !== (value.confirmation.irreversible_delete_acknowledged !== undefined) ||
    deletion !== (value.confirmation.retained_records_acknowledged !== undefined)) {
    context.addIssue({ code: "custom", message: "Only deletion requires irreversible deletion and retained-record acknowledgements" });
  }
});

const targetSnapshot = z.object({ lifecycle: lifecycleStateSchema,
  generation: showControlSchema.shape.generation }).strict();
const previewSchema = z.object({ ...identity, result: z.literal("preview"), request: lifecycleOperationRequestSchema,
  request_sha256: lifecycleCommitSchema.shape.request_sha256, snapshot_only: z.literal(true), authorizes_operation: z.literal(false),
  payloads_verified: z.literal(false), eligible: z.boolean(), admission_state: z.enum(["open", "paused"]),
  show: targetSnapshot.nullable(), episode: targetSnapshot.nullable(),
  blockers: z.array(z.enum(["service_paused", "service_registry_full", "target_missing", "unfinished_show_operation", "target_not_eligible",
    "job_id_used", "unknown_payload_key"])).max(7),
  deletion_page: z.object({ scope_index: z.number().int().min(0).max(4), payload_objects: z.number().int().nonnegative().max(100),
    payload_bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), retained_marker_objects: z.number().int().nonnegative().max(100),
    unknown_objects: z.number().int().nonnegative().max(100), scope_complete: z.boolean(), next_cursor: z.string().min(1).max(4096).optional(),
    authorizes_deletion: z.literal(false), retains_operational_records: z.literal(true) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.eligible !== (value.blockers.length === 0) || new Set(value.blockers).size !== value.blockers.length ||
    value.request.kind === "show" && value.episode !== null || value.request.action !== "delete" && value.deletion_page ||
    value.deletion_page && value.deletion_page.scope_complete === (value.deletion_page.next_cursor !== undefined)) {
    context.addIssue({ code: "custom", message: "Lifecycle preview evidence is inconsistent" });
  }
});

const markerReceiptSchema = z.object({ ...identity, operation: lifecycleCommitSchema, key: z.string().max(256) }).strict()
  .superRefine((value, context) => {
    const operation = value.operation;
    const expected = operation.kind === "show" ? `staging/lifecycle/shows/${operation.show_id}/${operation.job_id}/commit.json` :
      `staging/lifecycle/episodes/${operation.show_id}/${operation.episode_id}/${operation.job_id}/commit.json`;
    if (value.key !== expected) context.addIssue({ code: "custom", message: "Lifecycle commit/continuation receipt differs from its operation" });
  });

export const lifecycleAdminResponseSchema = z.discriminatedUnion("result", [
  previewSchema,
  z.object({ ...identity, result: z.literal("claimed"), operation: lifecycleCommitSchema }).strict(),
  markerReceiptSchema.safeExtend({ result: z.literal("committed"), created: z.boolean() }),
  markerReceiptSchema.safeExtend({ result: z.literal("requeued") }),
  z.object({ ...identity, result: z.literal("status"), operation: lifecycleCommitSchema,
    status: lifecycleJobStatusSchema.nullable(), progress: lifecycleProgressSchema.nullable(),
    ownership: z.enum(["unclaimed", "held", "released", "superseded"]), execution_active: z.boolean(), marker_present: z.boolean(),
    authorizes_retry: z.literal(false) }).strict().superRefine((value, context) => {
      for (const record of [value.status, value.progress]) {
        if (record && (record.job_id !== value.operation.job_id || record.show_id !== value.operation.show_id ||
          record.kind !== value.operation.kind || record.episode_id !== value.operation.episode_id || record.action !== value.operation.action ||
          record.show_generation !== value.operation.show_generation || record.request_sha256 !== value.operation.request_sha256)) {
          context.addIssue({ code: "custom", message: "Lifecycle inspection record differs from its operation" });
        }
      }
      if (value.execution_active && value.ownership !== "held" || value.status?.state === "completed" &&
        (value.progress?.phase !== "finished" || !value.progress.purge_confirmed)) {
        context.addIssue({ code: "custom", message: "Lifecycle inspection has inconsistent execution/completion evidence" });
      }
    }),
]);

export type LifecycleOperationRequest = z.infer<typeof lifecycleOperationRequestSchema>;
export type LifecycleAdminRequest = z.infer<typeof lifecycleAdminRequestSchema>;
export type LifecycleAdminResponse = z.infer<typeof lifecycleAdminResponseSchema>;
