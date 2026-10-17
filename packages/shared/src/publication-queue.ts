import { z } from "zod";
import { controlRequestSchema } from "./lifecycle";
import { hmacSha256Hex, verifyHmacSha256Hex } from "./hmac";
import { sha256Hex, utf8Bytes } from "./sha256";
import { serviceAdmissionSchema } from "./service-admission";

export const publicationCommitProtocol = "queue-commit-v1" as const;
export const MAX_PUBLICATION_INTENT_BYTES = 4096;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const publicationQueueIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const operation = z.object({ show_id: controlRequestSchema.shape.show_id, job_id: z.uuid(),
  show_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const publicationCommitIntentPayloadSchema = z.object({ schema_version: z.literal(1),
  family: z.literal("publication_commit"), commit_protocol: z.literal(publicationCommitProtocol), action: z.literal("commit"),
  service_id: serviceAdmissionSchema.shape.service_id, submission_id: z.uuid(), operation,
  manifest_sha256: hash, request_sha256: hash, worker_version_id: z.uuid(), service_config_sha256: hash }).strict();
export const publicationCommitIntentSchema = publicationCommitIntentPayloadSchema.extend({ mac: hash }).strict();
export type PublicationCommitIntent = z.infer<typeof publicationCommitIntentSchema>;
export type PublicationCommitIntentPayload = z.infer<typeof publicationCommitIntentPayloadSchema>;

export const publicationQueuedReceiptSchema = z.object({ schema_version: z.literal(1), result: z.literal("queued"),
  commit_protocol: z.literal(publicationCommitProtocol), service_id: serviceAdmissionSchema.shape.service_id,
  submission_id: z.uuid(), operation, manifest_sha256: hash, intent_sha256: hash, queue_id: publicationQueueIdSchema }).strict();
export type PublicationQueuedReceipt = z.infer<typeof publicationQueuedReceiptSchema>;
export const publicationQueueSubmissionSchema = z.object({ queue_id: publicationQueueIdSchema,
  intent: publicationCommitIntentSchema, intent_sha256: hash }).strict();
export type PublicationQueueSubmission = z.infer<typeof publicationQueueSubmissionSchema>;

export const publicationSubmissionSummarySchema = z.object({ submission_id: z.uuid(), intent_sha256: hash,
  state: z.enum(["pending", "committed", "completed", "failed", "rejected"]),
  reason_code: z.enum(["validation_failed", "stale_claim", "intent_mismatch"]).optional() }).strict().superRefine((value, context) => {
  if ((value.state === "failed") !== (value.reason_code === "validation_failed") ||
    (value.state === "rejected") !== (value.reason_code === "stale_claim" || value.reason_code === "intent_mismatch")) {
    context.addIssue({ code: "custom", message: "Submission state differs from its allowlisted reason" });
  }
});
export const publicationSubmissionRecordSchema = z.object({ schema_version: z.literal(1), intent: publicationCommitIntentSchema,
  result: publicationSubmissionSummarySchema }).strict().superRefine((value, context) => {
  if (value.intent.submission_id !== value.result.submission_id) {
    context.addIssue({ code: "custom", message: "Submission result belongs to another intent" });
  }
});
export type PublicationSubmissionRecord = z.infer<typeof publicationSubmissionRecordSchema>;

function requireKey(secret: string): string {
  if (!secret) throw new Error("Publication intent requires an administrator key");
  return secret;
}
function signedMessage(input: PublicationCommitIntentPayload): string {
  return `castloop/publication-commit/queue-commit-v1\n${JSON.stringify(publicationCommitIntentPayloadSchema.parse(input))}`;
}
export async function signPublicationCommitIntent(input: PublicationCommitIntentPayload, secret: string): Promise<PublicationCommitIntent> {
  const payload = publicationCommitIntentPayloadSchema.parse(input);
  return publicationCommitIntentSchema.parse({ ...payload, mac: await hmacSha256Hex(signedMessage(payload), requireKey(secret)) });
}
export function parsePublicationCommitIntent(input: unknown): PublicationCommitIntent {
  const intent = publicationCommitIntentSchema.parse(input);
  if (utf8Bytes(JSON.stringify(intent)).length > MAX_PUBLICATION_INTENT_BYTES) throw new Error("Publication intent exceeds its size limit");
  return intent;
}
export async function verifyPublicationCommitIntent(input: unknown, secret: string): Promise<PublicationCommitIntent | null> {
  let intent: PublicationCommitIntent;
  try { intent = parsePublicationCommitIntent(input); } catch { return null; }
  const { mac, ...payload } = intent;
  return await verifyHmacSha256Hex(signedMessage(payload), mac, requireKey(secret)) ? intent : null;
}
export async function publicationIntentHash(input: PublicationCommitIntent): Promise<string> {
  return sha256Hex(JSON.stringify(parsePublicationCommitIntent(input)));
}
