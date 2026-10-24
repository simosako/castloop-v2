import { z } from "zod";
import { sqlitePublicationRuntimeSchema, sqlitePublicationRequestSchema } from "./sqlite-publication";

export const sqliteAvailabilityStateSchema = z.enum(["open", "admission_paused", "paused"]);
export const sqliteAvailabilityActionSchema = z.enum(["pause", "resume", "admission-pause", "delivery-resume"]);
export const sqliteAvailabilitySnapshotSchema = z.object({
  state: sqliteAvailabilityStateSchema,
  availability_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  admission_window_id: z.uuid().nullable(),
}).strict();
export const sqliteAvailabilityRequestSchema = sqlitePublicationRuntimeSchema.extend({
  show_id: sqlitePublicationRequestSchema.shape.show_id,
  operation_id: z.uuid(),
  action: sqliteAvailabilityActionSchema,
  expected_availability_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  admission_window_id: z.uuid().optional(),
}).strict().superRefine((value, context) => {
  if ((value.action === "resume") !== (value.admission_window_id !== undefined)) {
    context.addIssue({ code: "custom", message: "Only admission resume requires a new window" });
  }
});
export const sqliteAvailabilityRecordSchema = z.object({
  request: sqliteAvailabilityRequestSchema,
  request_sha256: sqlitePublicationRuntimeSchema.shape.service_config_sha256,
  result: sqliteAvailabilitySnapshotSchema,
  applied_at_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((value, context) => {
  const { request, result } = value;
  if (result.availability_version !== request.expected_availability_version + 1 ||
    request.action === "pause" && result.state !== "paused" ||
    request.action === "resume" && (result.state !== "open" || result.admission_window_id !== request.admission_window_id) ||
    request.action === "admission-pause" && result.state === "open" ||
    request.action === "delivery-resume" && result.state !== "admission_paused") {
    context.addIssue({ code: "custom", message: "Control result differs from its request" });
  }
});
export type SqliteAvailabilityState = z.infer<typeof sqliteAvailabilityStateSchema>;
export type SqliteAvailabilityRequest = z.infer<typeof sqliteAvailabilityRequestSchema>;
export type SqliteAvailabilityRecord = z.infer<typeof sqliteAvailabilityRecordSchema>;
