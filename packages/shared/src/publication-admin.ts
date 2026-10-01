import { z } from "zod";
import { controlRequestSchema } from "./lifecycle";
import { publicationRequestSchema } from "./publication-request";
import { serviceAdmissionSchema } from "./service-admission";

export const publicationOperationSchema = z.object({ show_id: controlRequestSchema.shape.show_id,
  job_id: controlRequestSchema.shape.job_id, show_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const identity = { schema_version: z.literal(1), service_id: serviceAdmissionSchema.shape.service_id };

export const publicationAdminRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...identity, action: z.literal("claim"), publication: publicationRequestSchema }).strict(),
  z.object({ ...identity, action: z.literal("commit"), operation: publicationOperationSchema }).strict(),
]);

const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
const uuid = "[a-fA-F0-9-]{36}";
const commitKey = new RegExp(`^staging/(?:shows/${slug}/${uuid}|episodes/${slug}/${slug}/${uuid})/commit\\.json$`);
export const publicationAdminResponseSchema = z.discriminatedUnion("result", [
  z.object({ ...identity, result: z.literal("claimed"), operation: publicationOperationSchema }).strict(),
  z.object({ ...identity, result: z.literal("committed"), operation: publicationOperationSchema,
    key: z.string().max(256).regex(commitKey), created: z.boolean() }).strict().superRefine((value, context) => {
      const parts = value.key.split("/");
      if (parts[2] !== value.operation.show_id || parts.at(-2) !== value.operation.job_id) {
        context.addIssue({ code: "custom", message: "Publication commit key does not match its operation" });
      }
    }),
]);

export type PublicationOperationIdentity = z.infer<typeof publicationOperationSchema>;
export type PublicationAdminRequest = z.infer<typeof publicationAdminRequestSchema>;
export type PublicationAdminResponse = z.infer<typeof publicationAdminResponseSchema>;
