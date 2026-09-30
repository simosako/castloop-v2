import { describe, expect, test } from "bun:test";
import { controlRequestSchema, episodeLifecycleSchema, parseControlRequest, parseEpisodeLifecycle,
  parseShowControl, permitsControlAction, showControlSchema, stringifyLifecycleToml } from "./index";
import type { ControlAction, ControlRequest, LifecycleState } from "./index";

const request: ControlRequest = {
  schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily", kind: "episode", episode_id: "first",
  action: "unpublish", expected_show_generation: 0, expected_episode_generation: 0,
  created_at: "2026-09-30T12:00:00+09:00",
};

describe("M6 lifecycle schemas", () => {
  test("round trips strict control requests and Episode state TOML", () => {
    expect(parseControlRequest(stringifyLifecycleToml(request))).toEqual(request);
    const episode = episodeLifecycleSchema.parse({ schema_version: 1, show_id: "daily", episode_id: "first",
      lifecycle: "unpublished", generation: 3, last_job_id: request.job_id });
    expect(parseEpisodeLifecycle(stringifyLifecycleToml(episode))).toEqual(episode);
    expect(() => parseControlRequest(stringifyLifecycleToml(request) + "publish = false\n")).toThrow();
    expect(() => parseEpisodeLifecycle(stringifyLifecycleToml(episode) + "token = \"secret\"\n")).toThrow();
  });

  test("Show and Episode requests have different required target fields", () => {
    expect(controlRequestSchema.safeParse({ ...request, kind: "show" }).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...request, episode_id: undefined }).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...request, expected_episode_generation: undefined }).success).toBe(false);
    expect(controlRequestSchema.safeParse({ ...request, kind: "show", episode_id: undefined,
      expected_episode_generation: undefined }).success).toBe(true);
  });

  test("generations, IDs, timestamps and schema versions are validated", () => {
    for (const invalid of [{ expected_show_generation: -1 }, { expected_show_generation: 0.5 },
      { expected_show_generation: Number.MAX_SAFE_INTEGER + 1 }, { episode_id: "../other" },
      { show_id: "a".repeat(33) }, { episode_id: "a".repeat(81) }, { schema_version: 2 },
      { created_at: "2026-02-30T12:00:00Z" }, { created_at: "2026-09-30T12:00:00" }]) {
      expect(controlRequestSchema.safeParse({ ...request, ...invalid }).success).toBe(false);
    }
    expect(() => parseControlRequest(stringifyLifecycleToml(request)
      .replace('"2026-09-30T12:00:00+09:00"', "2026-09-30T12:00:00+09:00"))).toThrow();
  });

  test("Show controls reject legacy records, unknown fields and inconsistent owners", () => {
    const control = { schema_version: 2, show_id: "daily", lifecycle: "active", generation: 1, feed_generation: 0 };
    expect(parseShowControl(control).owner).toBeUndefined();
    expect(showControlSchema.safeParse({ job_id: request.job_id, state: "free" }).success).toBe(false);
    expect(showControlSchema.safeParse({ ...control, publish: false }).success).toBe(false);
    const owner = { job_id: request.job_id, kind: "episode", episode_id: "first", action: "delete",
      state: "reserved", request_sha256: "a".repeat(64) };
    expect(showControlSchema.safeParse({ ...control, owner }).success).toBe(true);
    expect(showControlSchema.safeParse({ ...control, owner: { ...owner, kind: "show" } }).success).toBe(false);
    expect(showControlSchema.safeParse({ ...control, owner: { ...owner, action: "stage" } }).success).toBe(false);
    expect(showControlSchema.safeParse({ ...control, owner: { ...owner, state: "uploading" } }).success).toBe(false);
    expect(showControlSchema.safeParse({ ...control, lifecycle: "deleted",
      owner: { ...owner, action: "publish" } }).success).toBe(false);
  });

  test("abandonment receipts require an older generation and cannot identify the current owner", () => {
    const control = { schema_version: 2, show_id: "daily", lifecycle: "active", generation: 2, feed_generation: 0 };
    const receipt = { job_id: request.job_id, generation: 1, request_sha256: "a".repeat(64) };
    expect(showControlSchema.safeParse({ ...control, last_abandoned_operation: receipt }).success).toBe(true);
    expect(showControlSchema.safeParse({ ...control,
      last_abandoned_operation: { ...receipt, generation: 2 } }).success).toBe(false);
    expect(showControlSchema.safeParse({ ...control, last_abandoned_operation: receipt,
      owner: { job_id: request.job_id, kind: "show", action: "delete", state: "reserved",
        request_sha256: "a".repeat(64) } }).success).toBe(false);
  });
});

test("ordinary publication cannot restore stopped or deleted content", () => {
  const expected: Record<LifecycleState, ControlAction[]> = {
    draft: ["publish", "stage", "delete"],
    active: ["publish", "stage", "unpublish", "delete"],
    unpublished: ["restore", "delete"],
    deleting: [],
    deleted: [],
  };
  const actions: ControlAction[] = ["publish", "stage", "unpublish", "restore", "delete"];
  for (const state of Object.keys(expected) as LifecycleState[]) {
    for (const action of actions) expect(permitsControlAction(state, action)).toBe(expected[state].includes(action));
  }
});
