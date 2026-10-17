import { z } from "zod";
import { publicationRequestSchema } from "./publication-request";
import { publicationQueueIdSchema } from "./publication-queue";
import { serviceAdmissionSchema } from "./service-admission";
import { stageSettlementSchema, stageUploadRequestSchema } from "./staging";

export const asyncManagementProtocol = "queue-management-v1" as const;
export const MAX_MANAGEMENT_BYTES = 16384;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const managementCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("stage-start"), upload: stageUploadRequestSchema }).strict(),
  z.object({ action: z.literal("upload-complete"), upload: stageUploadRequestSchema, grant_request_id: z.uuid(),
    settlement: stageSettlementSchema, outcome: z.enum(["staged", "aborted"]) }).strict(),
  z.object({ action: z.literal("publish"), publication: publicationRequestSchema }).strict(),
]);
export const managementIntentPayloadSchema = z.object({ schema_version: z.literal(1), family: z.literal("management"),
  protocol: z.literal(asyncManagementProtocol), service_id: serviceAdmissionSchema.shape.service_id, request_id: z.uuid(),
  worker_version_id: z.uuid(), service_config_sha256: hash, admission_window_id: z.uuid(), command: managementCommandSchema }).strict();
export const managementIntentSchema = managementIntentPayloadSchema.extend({ mac: hash }).strict();
export const managementSubmissionSchema = z.object({ queue_id: publicationQueueIdSchema, intent: managementIntentSchema,
  intent_sha256: hash }).strict();
const target = z.object({ key: z.string().min(1).max(256), length: z.number().int().positive().max(300_000_000), sha256: hash }).strict();
export const managementResultPayloadSchema = z.object({ schema_version: z.literal(1), protocol: z.literal(asyncManagementProtocol),
  service_id: serviceAdmissionSchema.shape.service_id, request_id: z.uuid(), intent_sha256: hash,
  action: z.enum(["stage-start", "upload-complete", "publish"]),
  state: z.enum(["pending", "granted", "staged", "aborted", "published", "failed", "rejected", "blocked"]),
  payloads: z.array(target).min(1).max(2).optional(),
  reason_code: z.enum(["stale_window", "runtime_mismatch", "target_conflict", "request_conflict", "validation_failed", "retries_exhausted"]).optional(),
}).strict().superRefine((value, context) => {
  if ((value.state === "granted") !== (value.payloads !== undefined) ||
    value.state === "granted" && value.action !== "stage-start" ||
    ["staged", "aborted"].includes(value.state) && value.action !== "upload-complete" ||
    ["published", "failed"].includes(value.state) && value.action !== "publish" ||
    value.state === "failed" && value.reason_code !== "validation_failed" ||
    value.state === "blocked" && value.reason_code !== "retries_exhausted" ||
    value.state === "rejected" && !["stale_window", "runtime_mismatch", "target_conflict", "request_conflict"].includes(value.reason_code ?? "") ||
    !["failed", "rejected", "blocked"].includes(value.state) && value.reason_code !== undefined) {
    context.addIssue({ code: "custom", message: "Management result state, action and evidence differ" });
  }
});
export const managementResultSchema = managementResultPayloadSchema.safeExtend({ mac: hash }).strict();
export const managementStatusSchema = z.object({ result: z.literal("management-status"), protocol: z.literal(asyncManagementProtocol),
  request_id: z.uuid(), response: managementResultSchema.nullable(), snapshot_only: z.literal(true), authorizes_recovery: z.literal(false) }).strict();
export type ManagementCommand = z.infer<typeof managementCommandSchema>;
export type ManagementIntentPayload = z.infer<typeof managementIntentPayloadSchema>;
export type ManagementIntent = z.infer<typeof managementIntentSchema>;
export type ManagementSubmission = z.infer<typeof managementSubmissionSchema>;
export type ManagementResultPayload = z.infer<typeof managementResultPayloadSchema>;
export type ManagementResult = z.infer<typeof managementResultSchema>;
export type ManagementStatus = z.infer<typeof managementStatusSchema>;

function bytes(source: string): Uint8Array<ArrayBuffer> { return new Uint8Array(new TextEncoder().encode(source)); }
function hex(value: ArrayBuffer): string { return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function key(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("Management authentication requires an administrator key");
  return crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function sign(value: object, secret: string, domain: "intent" | "result"): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await key(secret), bytes(`castloop/${asyncManagementProtocol}/${domain}\n${JSON.stringify(value)}`)));
}
async function verify(value: object, mac: string, secret: string, domain: "intent" | "result"): Promise<boolean> {
  const signature = Uint8Array.from(mac.match(/../g)!, (part) => Number.parseInt(part, 16));
  return crypto.subtle.verify("HMAC", await key(secret), signature, bytes(`castloop/${asyncManagementProtocol}/${domain}\n${JSON.stringify(value)}`));
}
export function parseManagementIntent(input: unknown): ManagementIntent {
  const value = managementIntentSchema.parse(input);
  if (bytes(JSON.stringify(value)).length > MAX_MANAGEMENT_BYTES) throw new Error("Management intent exceeds its size limit");
  return value;
}
export async function signManagementIntent(input: ManagementIntentPayload, secret: string): Promise<ManagementIntent> {
  const value = managementIntentPayloadSchema.parse(input);
  return parseManagementIntent({ ...value, mac: await sign(value, secret, "intent") });
}
export async function verifyManagementIntent(input: unknown, secret: string): Promise<ManagementIntent | null> {
  let value: ManagementIntent;
  try { value = parseManagementIntent(input); } catch { return null; }
  const { mac, ...payload } = value;
  return await verify(payload, mac, secret, "intent") ? value : null;
}
export async function managementIntentHash(input: ManagementIntent): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes(JSON.stringify(parseManagementIntent(input)))));
}
export async function signManagementResult(input: ManagementResultPayload, secret: string): Promise<ManagementResult> {
  const value = managementResultPayloadSchema.parse(input);
  return managementResultSchema.parse({ ...value, mac: await sign(value, secret, "result") });
}
export async function verifyManagementResult(input: unknown, intent: ManagementIntent, secret: string): Promise<ManagementResult> {
  const value = managementResultSchema.parse(input);
  const { mac, ...payload } = value;
  if (value.service_id !== intent.service_id || value.request_id !== intent.request_id || value.action !== intent.command.action ||
    value.intent_sha256 !== await managementIntentHash(intent) || !await verify(payload, mac, secret, "result")) {
    throw new Error("Management result differs from its authenticated frozen request");
  }
  return value;
}
export function managementRequestPrefix(requestId: string): string {
  return `system/management-requests/${managementIntentSchema.shape.request_id.parse(requestId)}`;
}
export function managementOperationId(command: ManagementCommand): string {
  return command.action === "publish" ? command.publication.request.job_id : command.upload.operation_id;
}
