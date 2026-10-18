import { z } from "zod";

export const stageAssetSchema = z.enum(["show_metadata", "cover_jpg", "cover_png", "episode_metadata", "audio"]);
export const stagePayloadSchema = z.object({
  asset: stageAssetSchema,
  length_bytes: z.number().int().positive().max(300_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((value, context) => {
  const maximum = value.asset === "audio" ? 300_000_000 : value.asset.startsWith("cover_") ? 5_000_000 : 1_000_000;
  if (value.length_bytes > maximum) context.addIssue({ code: "custom", message: "Staging payload exceeds its asset size limit" });
});
export type StagePayload = z.infer<typeof stagePayloadSchema>;
export type StageAsset = z.infer<typeof stageAssetSchema>;

export const stageReadbackReceiptSchema = stagePayloadSchema.safeExtend({
  etag: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  version: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
});
export type StageReadbackReceipt = z.infer<typeof stageReadbackReceiptSchema>;
