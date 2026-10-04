import { z } from "zod";
import { hostnameSchema } from "./hostname";

const uuid = z.uuid();
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const m6RuntimeTargetSchema = z.object({ operation_id: uuid, deployment_id: uuid, worker_version_id: uuid,
  service_config_sha256: checksum }).strict();
export const m6RuntimeReadinessSchema = m6RuntimeTargetSchema.extend({ default_cache_disabled: z.literal(true),
  cached_entrypoint: z.literal("CachedPublicAssets"), cutover_verified: z.literal(true), publication_routes_verified: z.literal(true) }).strict();
export const m6ServiceUpdateRequestSchema = z.object({ operation_id: uuid,
  service_id: z.string().max(20).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  expected_service_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), pause_id: uuid,
  previous_worker_version_id: uuid, service_config_sha256: checksum, worker_source_sha256: checksum, worker_metadata_sha256: checksum }).strict();
export const serviceUrlChangeRequestSchema = m6ServiceUpdateRequestSchema.pick({ operation_id: true, service_id: true,
  expected_service_generation: true, pause_id: true, service_config_sha256: true }).extend({ worker_version_id: uuid,
  public_base_url: z.url(), workers_dev_base_url: z.url(), target_service_config_sha256: checksum,
  domain_change: z.object({ action: z.enum(["add", "remove"]), hostname: hostnameSchema }).strict().optional() }).strict();
export const domainConnectionReceiptSchema = z.object({ action: z.enum(["add", "remove"]), execution_id: uuid,
  domain_id: z.string().min(1).max(128) }).strict();
export const serviceUrlChangeProgressSchema = z.object({ schema_version: z.literal(1), request: serviceUrlChangeRequestSchema,
  phase: z.enum(["feeds", "configured", "complete"]), after_show_id: z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  connection_receipt: domainConnectionReceiptSchema.optional() }).strict().superRefine((value, context) => {
    if (value.connection_receipt && (value.connection_receipt.action !== value.request.domain_change?.action ||
      value.connection_receipt.action === "remove" && value.phase === "feeds")) {
      context.addIssue({ code: "custom", message: "Connection receipt must match its frozen domain action and phase" });
    }
  });
export const migrationDeliveryCandidateSchema = z.object({ bootstrap_id: uuid, worker_version_id: uuid,
  deployment_id: uuid, plan_sha256: checksum }).strict();
export const serviceInvocationKindSchema = z.enum(["legacy_admin", "legacy_consumer", "legacy_recovery", "m6_admin", "m6_consumer", "m6_recovery"]);
export const serviceAdmissionSchema = z.object({
  schema_version: z.literal(1),
  service_id: z.string().max(20).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(["legacy", "m6"]),
  state: z.enum(["open", "paused", "migrating", "initializing", "updating"]),
  invocations: z.array(z.object({ token: uuid, kind: serviceInvocationKindSchema }).strict()).max(32),
  pause_id: uuid.optional(),
  last_resumed_pause_id: uuid.optional(),
  migration: z.object({ migration_id: uuid, request_sha256: checksum, execution_id: uuid.optional(),
    delivery_candidate: migrationDeliveryCandidateSchema.optional() }).strict().optional(),
  initialization: m6RuntimeTargetSchema.optional(),
  update: z.object({ request: m6ServiceUpdateRequestSchema, target: m6RuntimeTargetSchema.optional() }).strict().optional(),
  url_change: z.object({ operation_id: uuid, request_sha256: checksum, execution_id: uuid.optional(),
    execution_kind: z.enum(["worker", "connection"]).optional() }).strict().optional(),
  runtime_readiness: m6RuntimeReadinessSchema.optional(),
  readiness: z.object({ migration_id: uuid, plan_sha256: checksum, deployment_id: uuid, worker_version_id: uuid,
    completed_execution_id: uuid, default_cache_disabled: z.literal(true), cached_entrypoint: z.literal("CachedPublicAssets"),
    old_cache_purged: z.literal(true), cutover_verified: z.literal(true), old_io_quiesced: z.literal(true),
    publication_routes_verified: z.literal(true) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (["paused", "migrating", "updating"].includes(value.state) !== (value.pause_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only paused, migrating or updating services have a pause owner" });
  }
  if ((value.state === "migrating") !== (value.migration !== undefined)) {
    context.addIssue({ code: "custom", message: "Migration admission must have its frozen request owner" });
  }
  if (value.state === "migrating" && value.invocations.length) {
    context.addIssue({ code: "custom", message: "Migration cannot coexist with mutating invocations" });
  }
  const initializing = value.state === "initializing";
  const ready = value.readiness !== undefined || value.runtime_readiness !== undefined;
  if (initializing !== (value.initialization !== undefined) || initializing &&
    (value.mode !== "m6" || ready || value.invocations.length)) {
    context.addIssue({ code: "custom", message: "Fresh M6 initialization requires its frozen target without readiness or live invocations" });
  }
  if ((value.mode === "m6" && !initializing) !== ready) {
    context.addIssue({ code: "custom", message: "M6 mode requires durable runtime readiness evidence" });
  }
  if ((value.state === "updating") !== (value.update !== undefined) || value.update &&
    (value.mode !== "m6" || value.invocations.length || value.update.request.service_id !== value.service_id ||
      value.update.request.pause_id !== value.pause_id ||
      value.update.request.previous_worker_version_id !== (value.runtime_readiness ?? value.readiness)?.worker_version_id ||
      value.update.target && (value.update.target.operation_id !== value.update.request.operation_id ||
        value.update.target.service_config_sha256 !== value.update.request.service_config_sha256 ||
        value.update.target.worker_version_id === value.update.request.previous_worker_version_id))) {
    context.addIssue({ code: "custom", message: "Compatible M6 updates require their paused owner, previous readiness and exact new target without live invocations" });
  }
  if (new Set(value.invocations.map((invocation) => invocation.token)).size !== value.invocations.length) {
    context.addIssue({ code: "custom", message: "Service invocation tokens must be unique" });
  }
  if (value.url_change && (value.mode !== "m6" || value.state !== "paused" || value.invocations.length)) {
    context.addIssue({ code: "custom", message: "URL changes require a paused M6 owner without live invocations" });
  }
  if (value.url_change?.execution_kind && !value.url_change.execution_id) {
    context.addIssue({ code: "custom", message: "URL execution kind requires its retained token" });
  }
});

export type ServiceAdmission = z.infer<typeof serviceAdmissionSchema>;
export type ServiceInvocationKind = z.infer<typeof serviceInvocationKindSchema>;
export type M6RuntimeTarget = z.infer<typeof m6RuntimeTargetSchema>;
export type M6RuntimeReadiness = z.infer<typeof m6RuntimeReadinessSchema>;
export type M6ServiceUpdateRequest = z.infer<typeof m6ServiceUpdateRequestSchema>;
export type ServiceUrlChangeRequest = z.infer<typeof serviceUrlChangeRequestSchema>;
export type ServiceUrlChangeProgress = z.infer<typeof serviceUrlChangeProgressSchema>;
export type M6ServiceReadiness = NonNullable<ServiceAdmission["runtime_readiness"] | ServiceAdmission["readiness"]>;

export const serviceMigrationRequestSchema = z.object({
  schema_version: z.literal(1), migration_id: uuid, service_id: serviceAdmissionSchema.shape.service_id,
  expected_service_generation: serviceAdmissionSchema.shape.generation,
  pause_id: uuid, created_at: z.iso.datetime({ offset: true, precision: 0 }),
}).strict();
export type ServiceMigrationRequest = z.infer<typeof serviceMigrationRequestSchema>;
