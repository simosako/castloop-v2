import { z } from "zod";
import { cachedDeliveryRuntimeSchema } from "./delivery-runtime";
import { m6DeploymentSnapshotSchema } from "./m6-worker-deployment";
import { m6RuntimeReadinessSchema, m6RuntimeTargetSchema } from "./service-admission";

export const m6SetupRequestSchema = z.object({ target: m6RuntimeTargetSchema }).strict();
export const m6SetupRecordSchema = z.object({ schema_version: z.literal(1), request: m6SetupRequestSchema,
  cache_purge_verified: z.literal(true),
  queue_receipt: z.object({ worker_version_id: z.uuid() }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.queue_receipt && value.queue_receipt.worker_version_id !== value.request.target.worker_version_id) {
    context.addIssue({ code: "custom", message: "Runtime probe Queue receipt differs from its frozen request" });
  }
});
export const m6SetupQueueProbeSchema = m6SetupRequestSchema.extend({ type: z.literal("castloop-runtime-probe-v1") }).strict();
export const m6SetupProbeSchema = z.object({ result: z.literal("runtime-probe"), request: m6SetupRequestSchema,
  invocation_id: z.uuid(), cached_runtime: cachedDeliveryRuntimeSchema }).strict();
export const m6SetupStatusSchema = z.object({ result: z.literal("setup-status"), record: m6SetupRecordSchema }).strict();
export const m6SetupCompleteSchema = m6SetupRequestSchema.extend({
  snapshots: z.tuple([m6DeploymentSnapshotSchema, m6DeploymentSnapshotSchema]),
}).strict();
export const m6SetupCompletedSchema = z.object({ result: z.literal("initialized"), request: m6SetupRequestSchema,
  readiness: m6RuntimeReadinessSchema }).strict();
export const m6SetupHealthSchema = z.object({ result: z.literal("candidate"), m6_ready: z.literal(false), worker_version_id: z.uuid() }).strict();
export type M6SetupRequest = z.infer<typeof m6SetupRequestSchema>;
export type M6SetupRecord = z.infer<typeof m6SetupRecordSchema>;
export type M6SetupProbe = z.infer<typeof m6SetupProbeSchema>;
