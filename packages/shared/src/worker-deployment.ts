import { z } from "zod";
import { serviceAdmissionSchema } from "./service-admission";

const bindingSchema = z.object({
  name: z.string().min(1).max(128), type: z.string().min(1).max(128),
  bucket_name: z.string().optional(), queue_name: z.string().optional(), text: z.string().optional(),
});
const workerExportSchema = z.object({ type: z.literal("worker"), cache: z.object({ enabled: z.boolean() }),
  state: z.literal("created").optional() });
const exportsSchema = z.record(z.string(), workerExportSchema);
const sampling = z.number().min(0).max(1);
const telemetrySchema = z.object({ enabled: z.boolean().optional(), head_sampling_rate: sampling.optional() }).passthrough();
const observabilitySchema = z.object({ enabled: z.boolean().optional(), head_sampling_rate: sampling.optional(),
  logs: telemetrySchema.optional(), traces: telemetrySchema.optional() }).passthrough();

export const workerSettingsSnapshotSchema = z.object({
  bindings: z.array(bindingSchema).max(100),
  cache_options: z.object({ enabled: z.boolean(), cross_version_cache: z.boolean().optional() }).optional(),
  exports: exportsSchema.optional(),
  compatibility_date: z.string().optional(), compatibility_flags: z.array(z.string()).max(100).optional(),
  observability: observabilitySchema.optional(),
  logpush: z.boolean().optional(), placement: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).optional(), tail_consumers: z.array(z.record(z.string(), z.unknown())).optional(),
}).superRefine((value, context) => {
  if (new Set(value.bindings.map((binding) => binding.name)).size !== value.bindings.length) {
    context.addIssue({ code: "custom", message: "Worker bindings must have unique names" });
  }
});
export type WorkerSettingsSnapshot = z.infer<typeof workerSettingsSnapshotSchema>;

export const workerDeploymentsSnapshotSchema = z.object({ deployments: z.array(z.object({
  id: z.uuid(), strategy: z.literal("percentage"),
  versions: z.array(z.object({ version_id: z.uuid(), percentage: z.number().min(0).max(100) })).min(1).max(100),
})).min(1).max(1000) });
export const workerVersionSnapshotSchema = z.object({ id: z.uuid(), resources: z.object({
  bindings: z.array(bindingSchema).max(100),
  script: z.object({ handlers: z.array(z.string()), named_handlers: z.array(z.object({ name: z.string(), handlers: z.array(z.string()) })) }),
  script_runtime: z.object({ compatibility_date: z.string(), compatibility_flags: z.array(z.string()), exports: exportsSchema }),
}) });
export const workerSubdomainSnapshotSchema = z.object({ enabled: z.boolean(), previews_enabled: z.boolean() });

export const m6WorkerDeploymentEvidenceSchema = z.object({
  schema_version: z.literal(1), service_id: serviceAdmissionSchema.shape.service_id, account_id: z.string().regex(/^[a-f0-9]{32}$/i),
  worker_name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/), deployment_id: z.uuid(), worker_version_id: z.uuid(),
  compatibility_date: z.iso.date(), traffic_percentage: z.literal(100),
  default_cache_disabled: z.literal(true), cached_entrypoint: z.literal("CachedPublicAssets"),
  cached_entrypoint_enabled: z.literal(true), cross_version_cache_disabled: z.literal(true),
  version_metadata_binding_verified: z.literal(true), service_bindings_verified: z.literal(true),
  observability_enabled: z.literal(true), workers_dev_previews_disabled: z.literal(true),
}).strict();
export type M6WorkerDeploymentEvidence = z.infer<typeof m6WorkerDeploymentEvidenceSchema>;
