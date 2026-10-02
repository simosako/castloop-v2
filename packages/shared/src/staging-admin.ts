import { z } from "zod";
import { serviceAdmissionSchema } from "./service-admission";
import { lifecycleJobStatusSchema } from "./lifecycle-job";
import { stagePayloadSchema, stageUploadProgressSchema, stageUploadRequestSchema } from "./staging";

export const stagingOperationSchema = z.object({
  show_id: stageUploadRequestSchema.shape.show_id,
  operation_id: stageUploadRequestSchema.shape.operation_id,
  show_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const identity = { schema_version: z.literal(1), service_id: serviceAdmissionSchema.shape.service_id };
const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
const uuid = "[a-fA-F0-9-]{36}";
const payloadKey = new RegExp(`^staging/(?:shows/${slug}/${uuid}/(?:show\\.toml|cover\\.(?:jpg|png))|` +
  `episodes/${slug}/${slug}/${uuid}/(?:episode\\.toml|audio\\.mp3))$`);
export const stagingAdminRequestSchema = z.discriminatedUnion("action", [
  z.object({ ...identity, action: z.literal("claim"), upload: stageUploadRequestSchema }).strict(),
  z.object({ ...identity, action: z.literal("status"), upload: stageUploadRequestSchema }).strict(),
  z.object({ ...identity, action: z.literal("begin"), operation: stagingOperationSchema }).strict(),
  z.object({ ...identity, action: z.literal("settle"), operation: stagingOperationSchema,
    put_requests_settled: z.literal(true), no_more_puts: z.literal(true) }).strict(),
  z.object({ ...identity, action: z.literal("finish"), operation: stagingOperationSchema,
    outcome: z.enum(["staged", "aborted"]) }).strict(),
]);

export const stagingAdminResponseSchema = z.discriminatedUnion("result", [
  z.object({ ...identity, result: z.literal("claimed"), operation: stagingOperationSchema }).strict(),
  z.object({ ...identity, result: z.literal("started"), operation: stagingOperationSchema,
    payloads: z.array(z.object({ key: z.string().max(256).regex(payloadKey),
      length: stagePayloadSchema.shape.length_bytes, sha256: stagePayloadSchema.shape.sha256 }).strict()).min(1).max(2) }).strict()
    .superRefine((value, context) => {
      const keys = value.payloads.map((payload) => payload.key);
      if (new Set(keys).size !== keys.length || value.payloads.some((payload) => {
        const parts = payload.key.split("/");
        const maximum = parts.at(-1) === "audio.mp3" ? 300_000_000 : parts.at(-1)?.startsWith("cover.") ? 5_000_000 : 1_000_000;
        return parts[2] !== value.operation.show_id || !z.uuid().safeParse(parts.at(-2)).success || payload.length > maximum;
      })) context.addIssue({ code: "custom", message: "Staging payload locations do not match their target or size budget" });
    }),
  z.object({ ...identity, result: z.literal("settled"), operation: stagingOperationSchema }).strict(),
  z.object({ ...identity, result: z.enum(["staged", "aborted"]), operation: stagingOperationSchema }).strict(),
  z.object({ ...identity, result: z.literal("status"), upload: stageUploadRequestSchema, operation: stagingOperationSchema,
    manifest_sha256: stagePayloadSchema.shape.sha256, request_sha256: stagePayloadSchema.shape.sha256,
    progress: stageUploadProgressSchema.nullable(), status: lifecycleJobStatusSchema.nullable(),
    ownership: z.enum(["unclaimed", "held", "released", "superseded"]), verification_active: z.boolean(), draft_committed: z.boolean(),
    authorizes_put: z.literal(false), authorizes_recovery: z.literal(false) }).strict().superRefine((value, context) => {
      const upload = value.upload;
      if (value.operation.show_id !== upload.show_id || value.operation.operation_id !== upload.operation_id ||
        value.operation.show_generation !== upload.expected_show_generation + 1 ||
        value.verification_active && value.ownership !== "held") {
        context.addIssue({ code: "custom", message: "Staging inspection identity or verification ownership is inconsistent" });
      }
      const progress = value.progress;
      if (progress && (progress.operation_id !== upload.operation_id || progress.show_id !== upload.show_id ||
        progress.show_generation !== value.operation.show_generation || progress.manifest_sha256 !== value.manifest_sha256 ||
        progress.verified_assets.some((asset) => !upload.payloads.some((payload) => payload.asset === asset.asset &&
          payload.sha256 === asset.sha256 && payload.length_bytes === asset.length_bytes)) ||
        (progress.phase === "verified" || progress.outcome === "staged") && progress.verified_assets.length !== upload.payloads.length)) {
        context.addIssue({ code: "custom", message: "Staging inspection progress differs from its frozen manifest" });
      }
      const status = value.status;
      if (status && (status.job_id !== upload.operation_id || status.show_id !== upload.show_id || status.kind !== upload.kind ||
        status.episode_id !== upload.episode_id || status.action !== "stage" || status.show_generation !== value.operation.show_generation ||
        status.request_sha256 !== value.request_sha256 || !["processing", "retrying", "completed"].includes(status.state) ||
        status.state === "completed" && progress?.phase !== "finished")) {
        context.addIssue({ code: "custom", message: "Staging inspection status differs from its frozen request/progress" });
      }
      if (value.ownership === "released" && (status?.state !== "completed" || progress?.phase !== "finished")) {
        context.addIssue({ code: "custom", message: "Released staging inspection requires retained completion evidence" });
      }
    }),
]);

export type StagingOperation = z.infer<typeof stagingOperationSchema>;
export type StagingAdminRequest = z.infer<typeof stagingAdminRequestSchema>;
export type StagingAdminResponse = z.infer<typeof stagingAdminResponseSchema>;
