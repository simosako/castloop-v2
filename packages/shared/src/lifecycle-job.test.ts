import { describe, expect, test } from "bun:test";
import { jobStatusSchema, lifecycleFailureForPhase, lifecycleFailureMessages, lifecycleJobStatusSchema, lifecyclePhaseSchema,
  lifecycleProgressSchema, parseJobStatus,
  parseLifecycleProgress, stringifyLifecycleProgress, stringifyToml } from "./index";

const identity = { job_id: crypto.randomUUID(), show_id: "daily", kind: "episode" as const,
  episode_id: "first", action: "unpublish" as const, show_generation: 1, request_sha256: "a".repeat(64) };

describe("M6 versioned job status and progress", () => {
  test("retained diagnostics use only fixed codes/messages and never arbitrary exception text", () => {
    const base = { schema_version: 2, ...identity, state: "retrying", phase: "purge" };
    for (const phase of lifecyclePhaseSchema.options) {
      const failure = lifecycleFailureForPhase(phase);
      const status = lifecycleJobStatusSchema.parse({ ...base, phase, ...failure,
        ...(phase === "finished" ? { state: "abandoned" } : {}) });
      expect(status.reason).toBe(lifecycleFailureMessages[failure.reason_code]);
      expect(parseJobStatus(stringifyToml(status))).toEqual(status);
    }
    for (const invalid of [{ reason: "owner@example.com title=private Bearer secret" },
      { reason_code: "cache_purge_failed" }, { reason: "Cache purge failed." },
      { reason_code: "cache_purge_failed", reason: "Payload deletion failed." },
      { reason_code: "arbitrary", reason: "Cache purge failed." }]) {
      expect(lifecycleJobStatusSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
  });
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

  test("deletion positions are bounded and cannot be attached to other operations or terminal cursors", () => {
    const base = { schema_version: 1, ...identity, action: "delete", phase: "verifying", deleted_objects: 0,
      purge_confirmed: true, updated_at: "2026-10-01T12:00:00Z", deletion_scope_index: 0, deletion_cursor: "opaque-cursor" };
    const progress = lifecycleProgressSchema.parse(base);
    expect(parseLifecycleProgress(stringifyLifecycleProgress(progress))).toEqual(progress);
    for (const invalid of [{ action: "unpublish" }, { deletion_scope_index: -1 }, { deletion_scope_index: 6 },
      { deletion_scope_index: 0.5 }, { deletion_scope_index: undefined }, { deletion_cursor: "" },
      { deletion_cursor: "x".repeat(4097) }, { phase: "finished" }, { phase: "finalizing" }]) {
      expect(lifecycleProgressSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
  });

  test("finished deletion requires final purge, complete scope verification and Show child tombstones", () => {
    const base = { schema_version: 1, ...identity, action: "delete", phase: "finished", deleted_objects: 10,
      purge_confirmed: true, final_purge_confirmed: true, deletion_scope_index: 3, updated_at: "2026-10-01T12:00:00Z" };
    expect(lifecycleProgressSchema.safeParse(base).success).toBe(true);
    for (const invalid of [{ final_purge_confirmed: undefined }, { final_purge_confirmed: false }, { purge_confirmed: false },
      { deletion_scope_index: 2 }, { deletion_cursor: "old" }, { tombstones_complete: true }]) {
      expect(lifecycleProgressSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
    const show = { ...base, kind: "show", episode_id: undefined, deletion_scope_index: 5, tombstones_complete: true,
      tombstoned_episodes: 20 };
    expect(lifecycleProgressSchema.safeParse(show).success).toBe(true);
    for (const invalid of [{ tombstones_complete: false }, { tombstone_cursor: "old" }, { tombstoned_episodes: -1 },
      { phase: "deleting" }, { final_purge_confirmed: false }]) {
      expect(lifecycleProgressSchema.safeParse({ ...show, ...invalid }).success).toBe(false);
    }
  });
});
