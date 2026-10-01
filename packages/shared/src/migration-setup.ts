import { z } from "zod";
import { migrationQuiescenceSchema } from "./migration-bootstrap";
import { serviceMigrationRequestSchema } from "./service-admission";
import { migrationBridgeDeploymentEvidenceSchema } from "./worker-deployment";

export const migrationSetupRequestSchema = z.object({ schema_version: z.literal(1),
  bridge: migrationBridgeDeploymentEvidenceSchema, pause_id: z.uuid(), migration_id: z.uuid(),
  created_at: z.iso.datetime({ offset: true, precision: 0 }), administrator_writes_stopped: z.literal(true),
  other_deployers_stopped: z.literal(true) }).strict();
export type MigrationSetupRequest = z.infer<typeof migrationSetupRequestSchema>;

export const migrationSetupClientStateSchema = z.object({ schema_version: z.literal(1), request: migrationSetupRequestSchema,
  phase: z.enum(["prepared", "admission_requested", "admission_ready", "pause_requested", "paused", "claim_requested", "claimed",
    "quiescence_requested", "quiesced"]), claim: serviceMigrationRequestSchema.optional(), quiescence: migrationQuiescenceSchema.optional(),
}).strict().superRefine((value, context) => {
  const request = value.request;
  const hasClaim = ["claim_requested", "claimed", "quiescence_requested", "quiesced"].includes(value.phase);
  const hasQuiescence = ["quiescence_requested", "quiesced"].includes(value.phase);
  if (hasClaim !== (value.claim !== undefined) || hasQuiescence !== (value.quiescence !== undefined) ||
    value.claim && (value.claim.service_id !== request.bridge.service_id || value.claim.migration_id !== request.migration_id ||
      value.claim.pause_id !== request.pause_id || value.claim.created_at !== request.created_at) ||
    value.quiescence && (value.quiescence.service_id !== request.bridge.service_id || value.quiescence.migration_id !== request.migration_id ||
      value.quiescence.bridge_worker_version_id !== request.bridge.worker_version_id)) {
    context.addIssue({ code: "custom", message: "Migration setup evidence is inconsistent with its frozen request/phase" });
  }
});
export type MigrationSetupClientState = z.infer<typeof migrationSetupClientStateSchema>;
