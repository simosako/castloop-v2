import { z } from "zod";
import { serviceAdmissionSchema } from "./service-admission";
import { m6WorkerDeploymentEvidenceSchema } from "./worker-deployment";
import { migrationApplyProgressSchema } from "./migration-plan";

const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const identity = { schema_version: z.literal(1), service_id: serviceAdmissionSchema.shape.service_id, migration_id: z.uuid(), request_sha256: checksum };
export const migrationQuiescenceSchema = z.object({ ...identity, bridge_worker_version_id: z.uuid(), confirmed_at: z.iso.datetime({ offset: true, precision: 0 }),
  old_admin_clients_stopped: z.literal(true), old_worker_invocations_settled: z.literal(true),
  old_rest_puts_settled: z.literal(true), no_more_legacy_writes: z.literal(true) }).strict();
export type MigrationQuiescence = z.infer<typeof migrationQuiescenceSchema>;

export const migrationBootstrapRequestSchema = z.object({ ...identity, bootstrap_id: z.uuid(), plan_sha256: checksum,
  bridge_worker_version_id: z.uuid(), worker_source_sha256: checksum, worker_metadata_sha256: checksum }).strict();
export type MigrationBootstrapRequest = z.infer<typeof migrationBootstrapRequestSchema>;

export const migrationDeploymentSettlementSchema = z.object({ bootstrap_id: z.uuid(), rest_requests_settled: z.literal(true),
  no_more_deploys: z.literal(true), deployment: m6WorkerDeploymentEvidenceSchema }).strict();

export const migrationBootstrapSchema = z.object({ schema_version: z.literal(1), request: migrationBootstrapRequestSchema,
  phase: z.enum(["prepared", "deploying", "verifying", "verified"]),
  settlement: migrationDeploymentSettlementSchema.optional(),
  old_cache_purged_by_execution_id: z.uuid().optional(), next_asset: z.number().int().min(0).max(10000),
  checks_sha256: checksum, verified_by_execution_id: z.uuid().optional(),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  const settled = value.phase === "verifying" || value.phase === "verified";
  if (settled !== (value.settlement !== undefined)) fail("Only settled deployments may enter HTTP verification");
  if (!settled && value.next_asset !== 0) fail("Unsettled deployment cannot carry HTTP verification");
  if (value.phase === "prepared" && value.old_cache_purged_by_execution_id) fail("Prepared deployment cannot carry a start receipt");
  if (value.phase !== "prepared" && !value.old_cache_purged_by_execution_id) fail("Deployment start requires a bridge default-cache purge receipt");
  if ((value.phase === "verified") !== (value.verified_by_execution_id !== undefined)) fail("Verified bootstrap requires its execution receipt");
  if (value.next_asset > 0 && !value.old_cache_purged_by_execution_id || value.phase === "verified" && !value.old_cache_purged_by_execution_id) fail("HTTP verification requires a successful old-cache purge receipt");
  if (value.settlement && (value.settlement.bootstrap_id !== value.request.bootstrap_id || value.settlement.deployment.service_id !== value.request.service_id)) fail("Bootstrap deployment belongs to another request");
});
export type MigrationBootstrap = z.infer<typeof migrationBootstrapSchema>;

export const migrationAdminStatusSchema = z.object({ admission: serviceAdmissionSchema.nullable(),
  progress: migrationApplyProgressSchema.nullable(), bootstrap: migrationBootstrapSchema.nullable(),
  worker_protocol: z.enum(["legacy_fenced", "m6_candidate"]), worker_version_id: z.uuid(), m6_ready: z.literal(false),
}).strict().superRefine((value, context) => {
  const id = value.admission?.migration?.migration_id ?? value.admission?.readiness?.migration_id;
  for (const evidence of [value.progress, value.bootstrap?.request]) {
    if (evidence && (evidence.migration_id !== id || evidence.service_id !== value.admission?.service_id ||
      value.admission.migration && evidence.request_sha256 !== value.admission.migration.request_sha256)) {
      context.addIssue({ code: "custom", message: "Migration status evidence belongs to another admission" });
    }
  }
  if (value.bootstrap && value.progress?.plan_sha256 !== value.bootstrap.request.plan_sha256) {
    context.addIssue({ code: "custom", message: "Bootstrap status does not match its initialized plan" });
  }
});
export type MigrationAdminStatus = z.infer<typeof migrationAdminStatusSchema>;

export const migrationDeploymentClientStateSchema = z.object({ schema_version: z.literal(1), request: migrationBootstrapRequestSchema,
  phase: z.enum(["prepared", "start_requested", "uploading", "rest_settled", "settled"]),
  worker_version_id: z.uuid().optional(), deployment: m6WorkerDeploymentEvidenceSchema.optional(),
}).strict().superRefine((value, context) => {
  if (["rest_settled", "settled"].includes(value.phase) !== (value.worker_version_id !== undefined) ||
    value.deployment && (value.deployment.worker_version_id !== value.worker_version_id || value.deployment.service_id !== value.request.service_id) ||
    value.phase === "settled" && !value.deployment) context.addIssue({ code: "custom", message: "Client deployment evidence is inconsistent with its phase" });
});
export type MigrationDeploymentClientState = z.infer<typeof migrationDeploymentClientStateSchema>;
