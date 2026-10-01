import { z } from "zod";
import { migrationQuiescenceSchema } from "./migration-bootstrap";
import { migrationInitializationResultSchema } from "./migration-admin";
import { migrationApplyProgressSchema } from "./migration-plan";
import { serviceMigrationRequestSchema } from "./service-admission";
import { migrationBridgeDeploymentEvidenceSchema } from "./worker-deployment";

export const migrationSetupRequestSchema = z.object({ schema_version: z.literal(1),
  bridge: migrationBridgeDeploymentEvidenceSchema, pause_id: z.uuid(), migration_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true, precision: 0 }), administrator_writes_stopped: z.literal(true),
  other_deployers_stopped: z.literal(true) }).strict();
export type MigrationSetupRequest = z.infer<typeof migrationSetupRequestSchema>;

const initializationStepSchema = z.object({
  step: z.number().int().min(1).max(10001), maximum_targets: z.number().int().min(1).max(100),
  before: migrationApplyProgressSchema.nullable(),
  result: migrationInitializationResultSchema.optional(), after: migrationApplyProgressSchema.optional(),
}).strict();

export const migrationSetupClientStateSchema = z.object({ schema_version: z.literal(1), request: migrationSetupRequestSchema,
  phase: z.enum(["prepared", "admission_requested", "admission_ready", "pause_requested", "paused", "claim_requested", "claimed",
    "quiescence_requested", "quiesced", "initialization_requested", "initialization_pending", "controls_initialized"]),
  claim: serviceMigrationRequestSchema.optional(), quiescence: migrationQuiescenceSchema.optional(), initialization: initializationStepSchema.optional(),
}).strict().superRefine((value, context) => {
  const request = value.request;
  const hasInitialization = ["initialization_requested", "initialization_pending", "controls_initialized"].includes(value.phase);
  const hasClaim = hasInitialization || ["claim_requested", "claimed", "quiescence_requested", "quiesced"].includes(value.phase);
  const hasQuiescence = hasInitialization || ["quiescence_requested", "quiesced"].includes(value.phase);
  if (hasClaim !== (value.claim !== undefined) || hasQuiescence !== (value.quiescence !== undefined) ||
    value.claim && (value.claim.service_id !== request.bridge.service_id || value.claim.migration_id !== request.migration_id ||
      value.claim.pause_id !== request.pause_id || value.claim.created_at !== request.created_at) ||
    value.quiescence && (value.quiescence.service_id !== request.bridge.service_id || value.quiescence.migration_id !== request.migration_id ||
      value.quiescence.bridge_worker_version_id !== request.bridge.worker_version_id)) {
    context.addIssue({ code: "custom", message: "Migration setup evidence is inconsistent with its frozen request/phase" });
  }
  const fail = () => context.addIssue({ code: "custom", message: "Migration initialization step evidence is inconsistent" });
  const step = value.initialization;
  if (hasInitialization !== (step !== undefined)) fail();
  if (!step) return;
  const acknowledged = value.phase !== "initialization_requested";
  if (acknowledged !== (step.result !== undefined && step.after !== undefined) ||
    !acknowledged && (step.result !== undefined || step.after !== undefined) ||
    (step.step === 1) !== (step.before === null)) fail();
  for (const progress of [step.before, step.after]) {
    if (progress && (progress.service_id !== request.bridge.service_id || progress.migration_id !== request.migration_id ||
      progress.request_sha256 !== value.quiescence?.request_sha256 || progress.phase === "finished" || progress.runtime || progress.completed_execution_id)) fail();
  }
  if (step.before && !["applying", "verifying"].includes(step.before.phase)) fail();
  if (!step.after || !step.result) return;
  const before = step.before;
  const after = step.after;
  if (step.result.phase !== after.phase || (value.phase === "controls_initialized") !== (after.phase === "runtime") ||
    before && before.plan_sha256 !== after.plan_sha256 || after.next_target < (before?.next_target ?? 0) ||
    after.next_target > (before?.next_target ?? 0) + step.maximum_targets ||
    before?.phase === "verifying" && (after.phase !== "runtime" || after.next_target !== before.next_target) ||
    before?.phase !== "verifying" && !["applying", "verifying"].includes(after.phase) ||
    after.phase === "applying" && after.next_target === (before?.next_target ?? 0) || after.reason_code) fail();
});
export type MigrationSetupClientState = z.infer<typeof migrationSetupClientStateSchema>;
