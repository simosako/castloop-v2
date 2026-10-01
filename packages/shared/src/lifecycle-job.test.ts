import { describe, expect, test } from "bun:test";
import { jobStatusSchema, lifecycleJobStatusSchema, lifecycleProgressSchema, parseJobStatus,
  parseLifecycleProgress, stringifyLifecycleProgress, stringifyToml } from "./index";

const identity = { job_id: crypto.randomUUID(), show_id: "daily", kind: "episode" as const,
  episode_id: "first", action: "unpublish" as const, show_generation: 1, request_sha256: "a".repeat(64) };

describe("M6 versioned job status and progress", () => {
  test("legacy publication status remains strict and round trips", () => {
    const status = jobStatusSchema.parse({ schema_version: 1, job_id: identity.job_id, show_id: "daily",
      kind: "show", state: "published" });
    expect(parseJobStatus(stringifyToml(status))).toEqual(status);
    expect(jobStatusSchema.safeParse({ ...status, action: "delete" }).success).toBe(false);
    expect(jobStatusSchema.safeParse({ ...status, state: "completed" }).success).toBe(false);
  });

  test("all new actions have explicit terminal outcomes", () => {
    for (const [action, state, result] of [["publish", "published", "active"], ["stage", "completed", undefined],
      ["unpublish", "completed", "unpublished"], ["restore", "completed", "active"], ["delete", "completed", "deleted"]] as const) {
      const status = lifecycleJobStatusSchema.parse({ schema_version: 2, ...identity, action,
        state, phase: "finished", ...(result ? { result_lifecycle: result } : {}) });
      expect(parseJobStatus(stringifyToml(status))).toEqual(status);
      expect(lifecycleJobStatusSchema.safeParse({ ...status, phase: "purge" }).success).toBe(false);
      expect(lifecycleJobStatusSchema.safeParse({ ...status, result_lifecycle: "draft" }).success).toBe(false);
      expect(lifecycleJobStatusSchema.safeParse({ ...status, state: "processing" }).success).toBe(false);
    }
  });

  test("unfinished and abandoned statuses do not advertise successful results", () => {
    for (const state of ["reserved", "processing", "retrying", "failed", "abandoned"] as const) {
      const status = { schema_version: 2, ...identity, state, phase: state === "abandoned" ? "finished" : "purge" };
      expect(lifecycleJobStatusSchema.safeParse(status).success).toBe(true);
      expect(lifecycleJobStatusSchema.safeParse({ ...status, result_lifecycle: "unpublished" }).success).toBe(false);
    }
    expect(lifecycleJobStatusSchema.safeParse({ schema_version: 2, ...identity, state: "published",
      phase: "finished", result_lifecycle: "active" }).success).toBe(false);
  });

  test("identity, versions, counters and unknown keys fail closed", () => {
    const progress = lifecycleProgressSchema.parse({ schema_version: 1, ...identity, action: "delete",
      phase: "deleting", deleted_objects: 12, purge_confirmed: true, updated_at: "2026-10-01T12:00:00Z" });
    expect(parseLifecycleProgress(stringifyLifecycleProgress(progress))).toEqual(progress);
    for (const invalid of [{ show_id: "../other" }, { kind: "show" }, { episode_id: undefined },
      { show_generation: 0 }, { request_sha256: "bad" }, { phase: "unknown" }, { schema_version: 2 },
      { deleted_objects: -1 }, { deleted_objects: 0.5 }, { token: "secret" }, { action: "stage" },
      { updated_at: "2026-02-30T12:00:00Z" }]) {
      expect(lifecycleProgressSchema.safeParse({ ...progress, ...invalid }).success).toBe(false);
    }
  });
});
