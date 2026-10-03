import { z } from "zod";

const uuid = z.uuid();
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const m6RuntimeTargetSchema = z.object({ operation_id: uuid, deployment_id: uuid, worker_version_id: uuid,
  service_config_sha256: checksum }).strict();
export const m6RuntimeReadinessSchema = m6RuntimeTargetSchema.extend({ default_cache_disabled: z.literal(true),
  cached_entrypoint: z.literal("CachedPublicAssets"), cutover_verified: z.literal(true), publication_routes_verified: z.literal(true) }).strict();
export const migrationDeliveryCandidateSchema = z.object({ bootstrap_id: uuid, worker_version_id: uuid,
  deployment_id: uuid, plan_sha256: checksum }).strict();
export const serviceInvocationKindSchema = z.enum(["legacy_admin", "legacy_consumer", "legacy_recovery", "m6_admin", "m6_consumer", "m6_recovery"]);
export const serviceAdmissionSchema = z.object({
  schema_version: z.literal(1),
  service_id: z.string().max(20).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mode: z.enum(["legacy", "m6"]),
  state: z.enum(["open", "paused", "migrating", "initializing"]),
  invocations: z.array(z.object({ token: uuid, kind: serviceInvocationKindSchema }).strict()).max(32),
  pause_id: uuid.optional(),
  last_resumed_pause_id: uuid.optional(),
  migration: z.object({ migration_id: uuid, request_sha256: checksum, execution_id: uuid.optional(),
    delivery_candidate: migrationDeliveryCandidateSchema.optional() }).strict().optional(),
  initialization: m6RuntimeTargetSchema.optional(),
  runtime_readiness: m6RuntimeReadinessSchema.optional(),
  readiness: z.object({ migration_id: uuid, plan_sha256: checksum, deployment_id: uuid, worker_version_id: uuid,
    completed_execution_id: uuid, default_cache_disabled: z.literal(true), cached_entrypoint: z.literal("CachedPublicAssets"),
    old_cache_purged: z.literal(true), cutover_verified: z.literal(true), old_io_quiesced: z.literal(true),
    publication_routes_verified: z.literal(true) }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (["paused", "migrating"].includes(value.state) !== (value.pause_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only paused or migrating services have a pause owner" });
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
  if (new Set(value.invocations.map((invocation) => invocation.token)).size !== value.invocations.length) {
    context.addIssue({ code: "custom", message: "Service invocation tokens must be unique" });
  }
});

export type ServiceAdmission = z.infer<typeof serviceAdmissionSchema>;
export type ServiceInvocationKind = z.infer<typeof serviceInvocationKindSchema>;
export type M6RuntimeTarget = z.infer<typeof m6RuntimeTargetSchema>;
export type M6RuntimeReadiness = z.infer<typeof m6RuntimeReadinessSchema>;
export type M6ServiceReadiness = NonNullable<ServiceAdmission["runtime_readiness"] | ServiceAdmission["readiness"]>;

export const serviceMigrationRequestSchema = z.object({
  schema_version: z.literal(1), migration_id: uuid, service_id: serviceAdmissionSchema.shape.service_id,
  expected_service_generation: serviceAdmissionSchema.shape.generation,
  pause_id: uuid, created_at: z.iso.datetime({ offset: true, precision: 0 }),
}).strict();
export type ServiceMigrationRequest = z.infer<typeof serviceMigrationRequestSchema>;
