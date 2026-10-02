import { z } from "zod";
import { lifecycleStateSchema, showControlSchema } from "./lifecycle";
import { serviceAdmissionSchema } from "./service-admission";

export const showReservationSchema = z.object({ show_id: showControlSchema.shape.show_id, reservation_id: z.uuid() }).strict();
export type ShowReservation = z.infer<typeof showReservationSchema>;
const identity = { schema_version: z.literal(1), service_id: serviceAdmissionSchema.shape.service_id,
  ...showReservationSchema.shape };
export const showRegistrationRequestSchema = z.object({ ...identity, action: z.enum(["reserve", "status"]) }).strict();
export type ShowRegistrationRequest = z.infer<typeof showRegistrationRequestSchema>;
export const showRegistrationResponseSchema = z.discriminatedUnion("result", [
  z.object({ ...identity, result: z.literal("reserved"), control_ready: z.literal(true) }).strict(),
  z.object({ ...identity, result: z.literal("status"), state: z.enum(["missing", "initializing", "reserved", "occupied"]),
    lifecycle: lifecycleStateSchema.nullable(), generation: showControlSchema.shape.generation.nullable(),
    authorizes_registration: z.literal(false) }).strict().superRefine((value, context) => {
      if ((value.lifecycle === null) !== (value.generation === null) || value.state === "missing" && value.lifecycle !== null ||
        value.state === "reserved" && value.lifecycle === null || value.state === "initializing" && (value.lifecycle !== "draft" || value.generation !== 0)) {
        context.addIssue({ code: "custom", message: "Show registration status has inconsistent control evidence" });
      }
    }),
]);
export type ShowRegistrationResponse = z.infer<typeof showRegistrationResponseSchema>;
