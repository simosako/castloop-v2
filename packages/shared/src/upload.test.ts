import { expect, test } from "bun:test";
import { stageAssetSchema, stagePayloadSchema, stageReadbackReceiptSchema } from "./upload";

test("upload payloads preserve per-asset limits and strict hash validation", () => {
  for (const [asset, maximum] of [["audio", 300_000_000], ["cover_jpg", 5_000_000], ["cover_png", 5_000_000],
    ["show_metadata", 1_000_000], ["episode_metadata", 1_000_000]] as const) {
    const payload = { asset, length_bytes: maximum, sha256: "a".repeat(64) };
    expect(stagePayloadSchema.parse(payload)).toEqual(payload);
    for (const length_bytes of [0, -1, 1.5, maximum + 1]) {
      expect(stagePayloadSchema.safeParse({ ...payload, length_bytes }).success).toBe(false);
    }
    expect(stagePayloadSchema.safeParse({ ...payload, sha256: "A".repeat(64) }).success).toBe(false);
    expect(stagePayloadSchema.safeParse({ ...payload, extra: true }).success).toBe(false);
  }
  expect(stageAssetSchema.safeParse("other").success).toBe(false);
});

test("readback receipts require bounded safe object identities without changing saved values", () => {
  const receipt = { asset: "audio" as const, length_bytes: 1, sha256: "a".repeat(64), etag: "etag-1_abc", version: "version_1" };
  expect(stageReadbackReceiptSchema.parse(receipt)).toEqual(receipt);
  for (const field of ["etag", "version"] as const) {
    for (const value of ["", "a".repeat(129), "with space", "../outside", '"quoted"', "line\nbreak"]) {
      expect(stageReadbackReceiptSchema.safeParse({ ...receipt, [field]: value }).success).toBe(false);
    }
  }
});
