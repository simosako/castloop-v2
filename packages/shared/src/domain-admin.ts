import { z } from "zod";
import { domainConnectionReceiptSchema, serviceAdmissionSchema, serviceUrlChangeProgressSchema, serviceUrlChangeRequestSchema } from "./service-admission";

export const domainOperationRequestSchema = serviceUrlChangeRequestSchema.extend({
  domain_change: serviceUrlChangeRequestSchema.shape.domain_change.unwrap(),
});
const operation = z.object({ request: domainOperationRequestSchema }).strict();
export const domainAdminRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("inspect"), service_id: serviceAdmissionSchema.shape.service_id }).strict(),
  operation.extend({ action: z.enum(["status", "begin", "step", "complete"]) }),
  operation.extend({ action: z.literal("claim-connection"), execution_id: z.uuid() }),
  operation.extend({ action: z.literal("return-connection"), receipt: domainConnectionReceiptSchema }),
]);
export const domainAdminResponseSchema = z.object({ result: z.literal("domain"), request: domainAdminRequestSchema,
  worker_version_id: z.uuid(), admission: serviceAdmissionSchema, service_config_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  public_base_url: z.url(), workers_dev_base_url: z.url(), progress: serviceUrlChangeProgressSchema.nullable() }).strict();
export const domainRuntimeProbeSchema = z.object({ schema_version: z.literal(1), service_id: serviceAdmissionSchema.shape.service_id,
  worker_name: z.string().min(1).max(63), worker_version_id: z.uuid(), nonce: z.uuid() }).strict();
export type DomainOperationRequest = z.infer<typeof domainOperationRequestSchema>;
export type DomainAdminRequest = z.infer<typeof domainAdminRequestSchema>;
export type DomainAdminResponse = z.infer<typeof domainAdminResponseSchema>;
export type DomainConnectionReceipt = z.infer<typeof domainConnectionReceiptSchema>;
