import { describe, expect, test } from "bun:test";
import { lifecycleCommitKey, lifecycleCommitSchema, parseLifecycleCommitKey } from "./index";

describe("M6 frozen lifecycle commits", () => {
  test("Show/Episode keys round trip without sharing publication paths", () => {
    for (const kind of ["show", "episode"] as const) {
      const target = { kind, show_id: "daily", job_id: crypto.randomUUID(), ...(kind === "episode" ? { episode_id: "first" } : {}) };
      const key = lifecycleCommitKey(target);
      expect(parseLifecycleCommitKey(key)).toEqual(target);
      expect(key).toStartWith("staging/lifecycle/");
      expect(key).toEndWith("/commit.json");
    }
  });

  test("unknown fields, publication/stage actions and malformed identities are rejected", () => {
    const base = { schema_version: 1, kind: "show", show_id: "daily", job_id: crypto.randomUUID(), action: "unpublish",
      show_generation: 1, request_sha256: "a".repeat(64) };
    for (const action of ["unpublish", "restore", "delete"]) expect(lifecycleCommitSchema.safeParse({ ...base, action }).success).toBe(true);
    for (const invalid of [{ schema_version: 2 }, { kind: "episode" }, { episode_id: "first" }, { show_id: "../other" },
      { show_id: "a".repeat(33) }, { job_id: "unknown" }, { action: "publish" }, { action: "stage" }, { show_generation: 0 },
      { show_generation: 1.5 }, { request_sha256: "BAD" }, { title: "Private title" }]) {
      expect(lifecycleCommitSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
  });

  test("invalid paths and legacy publication markers cannot be interpreted as lifecycle commits", () => {
    const jobId = crypto.randomUUID();
    for (const key of [`staging/shows/daily/${jobId}/commit.json`, `staging/episodes/daily/first/${jobId}/commit.json`,
      `staging/lifecycle/shows/daily/extra/${jobId}/commit.json`, `staging/lifecycle/episodes/daily/${jobId}/commit.json`,
      `staging/lifecycle/shows/../${jobId}/commit.json`, `staging/lifecycle/shows/daily/${jobId}/commit.json/`,
      `staging/lifecycle/shows/daily/not-a-job/commit.json`, `public/lifecycle/shows/daily/${jobId}/commit.json`]) {
      expect(parseLifecycleCommitKey(key)).toBeNull();
    }
  });
});
