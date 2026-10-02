import { z } from "zod";
import { controlRequestSchema } from "./lifecycle";
import { lifecycleJobStatusSchema, lifecycleProgressSchema } from "./lifecycle-job";
import { publicationRequestSchema } from "./publication-request";
import { serviceAdmissionSchema } from "./service-admission";

export const publicationOperationSchema = z.object({ show_id: controlRequestSchema.shape.show_id,
  job_id: controlRequestSchema.shape.job_id, show_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const identity = { schema_version: z.literal(1), service_id: serviceAdmissionSchema.shape.service_id };
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const publicationAdminRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...identity, action: z.literal("claim"), publication: publicationRequestSchema }).strict(),
  z.object({ ...identity, action: z.literal("commit"), operation: publicationOperationSchema, manifest_sha256: hash }).strict(),
  z.object({ ...identity, action: z.literal("retry"), operation: publicationOperationSchema, manifest_sha256: hash }).strict(),
  z.object({ ...identity, action: z.literal("status"), publication: publicationRequestSchema }).strict(),
]);

const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
const uuid = "[a-fA-F0-9-]{36}";
const commitKey = new RegExp(`^staging/(?:shows/${slug}/${uuid}|episodes/${slug}/${slug}/${uuid})/commit\\.json$`);
export const publicationAdminResponseSchema = z.discriminatedUnion("result", [
  z.object({ ...identity, result: z.literal("claimed"), operation: publicationOperationSchema, manifest_sha256: hash }).strict(),
  z.object({ ...identity, result: z.literal("committed"), operation: publicationOperationSchema,
    manifest_sha256: hash, key: z.string().max(256).regex(commitKey), created: z.boolean() }).strict().superRefine((value, context) => {
      const parts = value.key.split("/");
      if (parts[2] !== value.operation.show_id || parts.at(-2) !== value.operation.job_id) {
        context.addIssue({ code: "custom", message: "Publication commit key does not match its operation" });
      }
    }),
  z.object({ ...identity, result: z.literal("requeued"), operation: publicationOperationSchema,
    manifest_sha256: hash, key: z.string().max(256).regex(commitKey) }).strict().superRefine((value, context) => {
      const parts = value.key.split("/");
      if (parts[2] !== value.operation.show_id || parts.at(-2) !== value.operation.job_id) {
        context.addIssue({ code: "custom", message: "Publication retry key does not match its operation" });
      }
    }),
  z.object({ ...identity, result: z.literal("status"), publication: publicationRequestSchema, operation: publicationOperationSchema,
    manifest_sha256: hash, request_sha256: hash, status: lifecycleJobStatusSchema.nullable(), progress: lifecycleProgressSchema.nullable(),
    ownership: z.enum(["unclaimed", "held", "released", "superseded"]), execution_active: z.boolean(), marker_present: z.boolean(),
    staging_verified: z.literal(false), authorizes_recovery: z.literal(false) }).strict().superRefine((value, context) => {
      const request = value.publication.request;
      if (value.operation.show_id !== request.show_id || value.operation.job_id !== request.job_id ||
        value.operation.show_generation !== request.expected_show_generation + 1 || value.execution_active && value.ownership !== "held") {
        context.addIssue({ code: "custom", message: "Publication inspection identity or execution ownership is inconsistent" });
      }
      for (const record of [value.status, value.progress]) {
        if (record && (record.job_id !== request.job_id || record.show_id !== request.show_id || record.kind !== request.kind ||
          record.episode_id !== request.episode_id || record.action !== "publish" || record.show_generation !== value.operation.show_generation ||
          record.request_sha256 !== value.request_sha256)) context.addIssue({ code: "custom", message: "Publication inspection records differ from their frozen target" });
      }
      if (value.status && !["processing", "retrying", "failed", "published", "abandoned"].includes(value.status.state) ||
        value.status?.state === "published" && (value.progress?.phase !== "finished" || !value.progress.purge_confirmed) ||
        value.ownership === "released" && value.status?.state !== "published") {
        context.addIssue({ code: "custom", message: "Publication inspection has inconsistent completion evidence" });
      }
    }),
]);

export type PublicationOperationIdentity = z.infer<typeof publicationOperationSchema>;
export type PublicationAdminRequest = z.infer<typeof publicationAdminRequestSchema>;
export type PublicationAdminResponse = z.infer<typeof publicationAdminResponseSchema>;
