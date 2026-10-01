import { z } from "zod";
import { serviceAdmissionSchema } from "./service-admission";

export const migrationServiceIdentitySchema = z.object({ schema_version: z.literal(1),
  service_id: serviceAdmissionSchema.shape.service_id }).strict();
export const migrationOperationIdentitySchema = migrationServiceIdentitySchema.extend({ migration_id: z.uuid() });
export const migrationPauseRequestSchema = migrationServiceIdentitySchema.extend({ pause_id: z.uuid() });
export const migrationInitializationRequestSchema = migrationOperationIdentitySchema.extend({
  maximum_targets: z.number().int().min(1).max(100).optional(),
});
export const migrationInitializationResultSchema = z.object({ state: z.literal("pending"),
  phase: z.enum(["applying", "verifying", "runtime"]) }).strict();
export type MigrationInitializationResult = z.infer<typeof migrationInitializationResultSchema>;
export const migrationActionResponseSchema = z.object({
  result: z.enum(["initialized", "paused", "resumed", "claimed", "confirmed"]),
}).strict();
