import { z } from "zod";
import { controlRequestSchema } from "./lifecycle";
import type { ControlRequest } from "./lifecycle";

export const stageAssetSchema = z.enum(["show_metadata", "cover_jpg", "cover_png", "episode_metadata", "audio"]);
export const stagePayloadSchema = z.object({
  asset: stageAssetSchema,
  length_bytes: z.number().int().positive().max(300_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, context) => {
  const maximum = value.asset === "audio" ? 300_000_000 : value.asset.startsWith("cover_") ? 5_000_000 : 1_000_000;
  if (value.length_bytes > maximum) context.addIssue({ code: "custom", message: "Staging payload exceeds its asset size limit" });
});

export const stageUploadRequestSchema = z.object({
  schema_version: z.literal(1),
  operation_id: z.uuid(),
  draft_job_id: z.uuid(),
  show_id: controlRequestSchema.shape.show_id,
  kind: controlRequestSchema.shape.kind,
  episode_id: controlRequestSchema.shape.episode_id,
  expected_show_generation: controlRequestSchema.shape.expected_show_generation,
  expected_episode_generation: controlRequestSchema.shape.expected_episode_generation,
  created_at: controlRequestSchema.shape.created_at,
  payloads: z.array(stagePayloadSchema).min(1).max(2),
}).strict().superRefine((value, context) => {
  const episode = value.kind === "episode";
  if (episode !== (value.episode_id !== undefined) || episode !== (value.expected_episode_generation !== undefined)) {
    context.addIssue({ code: "custom", message: "Only Episode staging requires its Episode ID and generation" });
  }
  if (value.operation_id === value.draft_job_id) context.addIssue({ code: "custom", message: "Upload operation and draft job IDs must be distinct" });
  const assets = value.payloads.map((payload) => payload.asset);
  if (new Set(assets).size !== assets.length) context.addIssue({ code: "custom", message: "Staging assets must be unique" });
  if (episode ? assets.length !== 1 || !["episode_metadata", "audio"].includes(assets[0]!) :
    assets.length !== 2 || !assets.includes("show_metadata") ||
    !(assets.includes("cover_jpg") || assets.includes("cover_png"))) {
    context.addIssue({ code: "custom", message: "Staging assets do not match their Show or Episode operation" });
  }
});

export type StageUploadRequest = z.infer<typeof stageUploadRequestSchema>;
export type StagePayload = z.infer<typeof stagePayloadSchema>;
export type StageAsset = z.infer<typeof stageAssetSchema>;

export const stageReadbackReceiptSchema = stagePayloadSchema.safeExtend({
  etag: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  version: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
});
export type StageReadbackReceipt = z.infer<typeof stageReadbackReceiptSchema>;
export const stageSettlementSchema = z.object({
  put_requests_settled: z.literal(true), no_more_puts: z.literal(true),
  readback_receipts: z.array(stageReadbackReceiptSchema).max(2),
}).strict();
export type StageSettlement = z.infer<typeof stageSettlementSchema>;

export function parseStageReadbackReceipts(input: StageUploadRequest, receipts: unknown): StageReadbackReceipt[] {
  const request = stageUploadRequestSchema.parse(input);
  const values = z.array(stageReadbackReceiptSchema).max(2).parse(receipts);
  for (const [index, receipt] of values.entries()) {
    const payload = request.payloads[index];
    if (!payload || payload.asset !== receipt.asset || payload.length_bytes !== receipt.length_bytes || payload.sha256 !== receipt.sha256) {
      throw new Error("Staging readback receipt differs from its frozen payload");
    }
  }
  return values;
}

export function stageControlRequest(input: StageUploadRequest): ControlRequest {
  const request = stageUploadRequestSchema.parse(input);
  return controlRequestSchema.parse({ schema_version: 1, job_id: request.operation_id, show_id: request.show_id, kind: request.kind,
    ...(request.episode_id !== undefined ? { episode_id: request.episode_id, expected_episode_generation: request.expected_episode_generation } : {}),
    action: "stage", expected_show_generation: request.expected_show_generation, created_at: request.created_at });
}

export function stageDraftPrefix(input: StageUploadRequest): string {
  const request = stageUploadRequestSchema.parse(input);
  return request.kind === "show" ? `staging/shows/${request.show_id}/${request.draft_job_id}` :
    `staging/episodes/${request.show_id}/${request.episode_id}/${request.draft_job_id}`;
}

export function stagePayloadKey(input: StageUploadRequest, asset: StageAsset): string {
  const request = stageUploadRequestSchema.parse(input);
  if (!request.payloads.some((payload) => payload.asset === asset)) throw new Error("Asset is not included in the frozen staging request");
  const name = { show_metadata: "show.toml", cover_jpg: "cover.jpg", cover_png: "cover.png", episode_metadata: "episode.toml", audio: "audio.mp3" };
  return `${stageDraftPrefix(request)}/${name[asset]}`;
}

export const stageUploadProgressSchema = z.object({
  schema_version: z.literal(1),
  operation_id: z.uuid(),
  show_id: controlRequestSchema.shape.show_id,
  show_generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["ready", "uploading", "settled", "verifying", "verified", "finished"]),
  client_settled: z.boolean(),
  readback_receipts: z.array(stageReadbackReceiptSchema).max(2).optional(),
  outcome: z.enum(["staged", "aborted"]).optional(),
  verified_assets: z.array(z.object({
    asset: stageAssetSchema,
    etag: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
    version: stageReadbackReceiptSchema.shape.version.optional(),
    length_bytes: z.number().int().positive().max(300_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(2),
  reason_code: z.literal("validation_failed").optional(),
}).strict().superRefine((value, context) => {
  const settled = !["ready", "uploading"].includes(value.phase);
  if (!settled && value.readback_receipts !== undefined) {
    context.addIssue({ code: "custom", message: "Staging readback receipts require client settlement" });
  }
  if (settled !== value.client_settled) context.addIssue({ code: "custom", message: "Staging progress requires explicit client settlement" });
  if ((value.phase === "finished") !== (value.outcome !== undefined)) {
    context.addIssue({ code: "custom", message: "Only finished staging progress has an outcome" });
  }
  if ((!(["verified", "finished"] as string[]).includes(value.phase) || value.outcome === "aborted") && value.verified_assets.length) {
    context.addIssue({ code: "custom", message: "Staging verification evidence is premature or conflicts with aborting" });
  }
  if ((value.phase === "verified" || value.outcome === "staged") && !value.verified_assets.length) {
    context.addIssue({ code: "custom", message: "Successful staging requires payload verification evidence" });
  }
  if (new Set(value.verified_assets.map((asset) => asset.asset)).size !== value.verified_assets.length) {
    context.addIssue({ code: "custom", message: "Verified staging assets must be unique" });
  }
  if (value.reason_code && value.phase !== "settled") {
    context.addIssue({ code: "custom", message: "Staging failure diagnostics belong to settled, recoverable progress" });
  }
});

export type StageUploadProgress = z.infer<typeof stageUploadProgressSchema>;
