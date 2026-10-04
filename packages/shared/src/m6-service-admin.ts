import { z } from "zod";
import { serviceAdmissionSchema } from "./service-admission";

const base = z.object({ service_id: serviceAdmissionSchema.shape.service_id }).strict();
export const m6ServiceAdminRequestSchema = z.discriminatedUnion("action", [
  base.extend({ action: z.literal("status") }),
  base.extend({ action: z.literal("pause"), pause_id: z.uuid() }),
  base.extend({ action: z.literal("resume"), pause_id: z.uuid() }),
]);
export const m6ServiceAdminResponseSchema = z.object({ result: z.literal("service"), request: m6ServiceAdminRequestSchema,
  worker_version_id: z.uuid(), admission: serviceAdmissionSchema }).strict().superRefine((value, context) => {
  if (value.admission.service_id !== value.request.service_id || value.admission.mode !== "m6") {
    context.addIssue({ code: "custom", message: "Service response has another service or admission mode" });
  }
});
export type M6ServiceAdminRequest = z.infer<typeof m6ServiceAdminRequestSchema>;
export type M6ServiceAdminResponse = z.infer<typeof m6ServiceAdminResponseSchema>;
