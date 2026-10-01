import { describe, expect, test } from "bun:test";
import { stageControlRequest, stageDraftPrefix, stagePayloadKey, stageUploadProgressSchema, stageUploadRequestSchema } from "./index";

const base = { schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(), kind: "episode", show_id: "daily",
  episode_id: "first", expected_show_generation: 0, expected_episode_generation: 0, created_at: "2026-10-01T12:00:00Z",
  payloads: [{ asset: "audio", length_bytes: 300_000_000, sha256: "a".repeat(64) }] };

describe("M6 staging manifest and settlement", () => {
  test("operation and draft IDs are distinct and keys are derived from frozen targets", () => {
    const request = stageUploadRequestSchema.parse(base);
    expect(stageControlRequest(request).job_id).toBe(base.operation_id);
    expect(stageControlRequest(request).action).toBe("stage");
    expect(stageDraftPrefix(request)).toBe(`staging/episodes/daily/first/${base.draft_job_id}`);
    expect(stagePayloadKey(request, "audio")).toBe(`staging/episodes/daily/first/${base.draft_job_id}/audio.mp3`);
    expect(() => stagePayloadKey(request, "episode_metadata")).toThrow("not included");
  });

  test("asset sets, size limits and private/unrecognized fields are strict", () => {
    for (const invalid of [{ operation_id: base.draft_job_id }, { show_id: "../other" }, { key: "arbitrary/key" }, { token: "secret" },
      { kind: "show" }, { episode_id: undefined }, { payloads: [{ asset: "audio", length_bytes: 300_000_001, sha256: "a".repeat(64) }] },
      { payloads: [{ asset: "episode_metadata", length_bytes: 1_000_001, sha256: "a".repeat(64) }] },
      { payloads: [...base.payloads, ...base.payloads] }]) {
      expect(stageUploadRequestSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
    const show = { ...base, kind: "show", episode_id: undefined, expected_episode_generation: undefined,
      payloads: [{ asset: "show_metadata", length_bytes: 100, sha256: "a".repeat(64) },
        { asset: "cover_jpg", length_bytes: 5_000_000, sha256: "b".repeat(64) }] };
    expect(stageUploadRequestSchema.safeParse(show).success).toBe(true);
    expect(stageUploadRequestSchema.safeParse({ ...show, payloads: [...show.payloads, { asset: "cover_png", length_bytes: 1, sha256: "c".repeat(64) }] }).success).toBe(false);
  });

  test("verification and terminal progress cannot be asserted before explicit client settlement", () => {
    const progress = { schema_version: 1, operation_id: base.operation_id, show_id: "daily", show_generation: 1,
      manifest_sha256: "a".repeat(64), phase: "ready", client_settled: false, verified_assets: [] };
    expect(stageUploadProgressSchema.safeParse(progress).success).toBe(true);
    for (const invalid of [{ phase: "settled" }, { client_settled: true }, { outcome: "staged" },
      { verified_assets: [{ asset: "audio", etag: "e1", length_bytes: 1, sha256: "a".repeat(64) }] }]) {
      expect(stageUploadProgressSchema.safeParse({ ...progress, ...invalid }).success).toBe(false);
    }
    expect(stageUploadProgressSchema.safeParse({ ...progress, phase: "finished", client_settled: true, outcome: "aborted" }).success).toBe(true);
    expect(stageUploadProgressSchema.safeParse({ ...progress, phase: "finished", client_settled: true, outcome: "staged" }).success).toBe(false);
  });
});
