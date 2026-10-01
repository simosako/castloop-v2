import { z } from "zod";
import { serviceAdmissionSchema } from "./service-admission";

export const serviceCapabilitiesSchema = z.object({
  schema_version: z.literal(1),
  service_id: serviceAdmissionSchema.shape.service_id,
  worker_protocol: z.enum(["legacy_fenced", "m6_candidate"]),
  features: z.object({
    service_mutation_fence: z.literal(true),
    migration_controls: z.literal(false),
    m6_staging: z.literal(false),
    m6_publication: z.literal(false),
    lifecycle_commands: z.literal(false),
    lifecycle_delivery: z.boolean(),
  }).strict(),
  admission: z.object({
    mode: serviceAdmissionSchema.shape.mode,
    state: z.enum(["uninitialized", "open", "paused", "migrating"]),
    generation: serviceAdmissionSchema.shape.generation.optional(),
    active_invocations: z.number().int().min(0).max(32),
    migration_id: z.uuid().optional(),
  }).strict(),
  legacy_mutations_admitted: z.boolean(),
  m6_ready: z.literal(false),
}).strict().superRefine((value, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  if (value.legacy_mutations_admitted !== (value.worker_protocol === "legacy_fenced" && value.admission.mode === "legacy" &&
    ["uninitialized", "open"].includes(value.admission.state))) fail("Legacy mutation capability must match admission");
  if ((value.admission.state === "uninitialized") !== (value.admission.generation === undefined)) fail("Initialized admission requires a generation");
  if (value.admission.state === "uninitialized" && (value.admission.mode !== "legacy" || value.admission.active_invocations !== 0)) fail("Uninitialized services can only use legacy mode");
  if ((value.admission.state === "migrating") !== (value.admission.migration_id !== undefined)) fail("Migration capability requires its owner ID");
  if (value.features.lifecycle_delivery !== (value.worker_protocol === "m6_candidate")) fail("Delivery capability must match the compiled Worker protocol");
});

export type ServiceCapabilities = z.infer<typeof serviceCapabilitiesSchema>;
