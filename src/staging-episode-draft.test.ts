import { describe, expect, test } from "bun:test";
import { stageControlRequest, stageUploadRequestSchema, stringifyLifecycleToml } from "../packages/shared/src/index";
import { claimShowOperation, readEpisodeLifecycle, readShowControl } from "./lifecycle-control";
import { initializeOwnedEpisodeDraft } from "./staging-episode-draft";
import { beginStageUpload, claimStageUpload } from "./staging-upload";
import { lifecycleFixture } from "./test-support/lifecycle";

async function fixture() {
  const setup = await lifecycleFixture();
  await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
    lifecycle: "active", generation: 0, feed_generation: 0 }));
  setup.writes.length = 0;
  const request = stageUploadRequestSchema.parse({ schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(),
    kind: "episode", show_id: "daily", episode_id: "new-episode", expected_show_generation: 0, expected_episode_generation: 0,
    created_at: "2026-10-02T12:00:00Z", payloads: [{ asset: "episode_metadata", length_bytes: 10, sha256: "a".repeat(64) }] });
  const key = "system/episode-lifecycle/daily/new-episode.toml";
  return { ...setup, request, key };
}

describe("new Episode draft initialization under staging admission", () => {
  test("creates only a generation-zero draft after Show CAS and before ready progress, not public payloads", async () => {
    const setup = await fixture();
    const operation = await claimStageUpload(setup.env, setup.request);
    expect(await readEpisodeLifecycle(setup.env, "daily", "new-episode")).toEqual({ schema_version: 1, show_id: "daily",
      episode_id: "new-episode", lifecycle: "draft", generation: 0 });
    expect(setup.writes.indexOf(setup.key)).toBeGreaterThan(setup.writes.indexOf("system/show-publications/daily.json"));
    expect(setup.writes.indexOf(setup.key)).toBeLessThan(setup.writes.indexOf(`system/jobs/${setup.request.operation_id}/upload-progress.json`));
    expect(setup.writes.every((key) => key.startsWith("system/"))).toBe(true);
    expect(await beginStageUpload(setup.env, operation)).toEqual([{ key: `staging/episodes/daily/new-episode/${setup.request.draft_job_id}/episode.toml`,
      length: 10, sha256: "a".repeat(64) }]);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.request.operation_id);
  });

  test("supports audio-first staging without changing Episode generation or overwriting on same-operation claim", async () => {
    const setup = await fixture();
    const request = stageUploadRequestSchema.parse({ ...setup.request,
      payloads: [{ asset: "audio", length_bytes: 10, sha256: "a".repeat(64) }] });
    const operation = await claimStageUpload(setup.env, request);
    const initial = setup.entries.get(setup.key)!;
    expect(await claimStageUpload(setup.env, request)).toEqual(operation);
    expect(setup.entries.get(setup.key)).toEqual(initial);
    expect((await beginStageUpload(setup.env, operation))[0]!.key).toEndWith("/audio.mp3");
  });

  test("generic staging claim and non-staging actions still reject missing Episode control", async () => {
    for (const action of ["stage", "publish", "delete", "unpublish", "restore"] as const) {
      const setup = await fixture();
      await expect(claimShowOperation(setup.env, { ...stageControlRequest(setup.request), action })).rejects.toThrow("record is missing");
      expect(setup.writes).toHaveLength(0);
    }
  });

  test("rejects stale missing generations and all stopped/deleted Show states before creating Episode control", async () => {
    const stale = await fixture();
    await expect(claimStageUpload(stale.env, { ...stale.request, expected_episode_generation: 1 })).rejects.toThrow("generation zero");
    expect(stale.writes).toHaveLength(0);
    for (const lifecycle of ["draft", "unpublished", "deleting", "deleted"] as const) {
      const setup = await fixture();
      await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
        lifecycle, generation: 0, feed_generation: 0 }));
      await expect(claimStageUpload(setup.env, setup.request)).rejects.toThrow();
      expect(setup.entries.has(setup.key)).toBe(false);
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
    }
  });

  test("retains existing tombstones and stopped Episode controls without reusing their IDs", async () => {
    for (const lifecycle of ["unpublished", "deleting", "deleted"] as const) {
      const setup = await fixture();
      await setup.bucket.put(setup.key, stringifyLifecycleToml({ schema_version: 1, show_id: "daily", episode_id: "new-episode",
        lifecycle, generation: 0 }));
      const original = setup.entries.get(setup.key)!;
      await expect(claimStageUpload(setup.env, setup.request)).rejects.toThrow("does not permit");
      expect(setup.entries.get(setup.key)).toEqual(original);
    }
  });

  test("refuses orphaned metadata/history/media/staging data including unknown keys before any mutation", async () => {
    for (const key of ["public/episodes/daily/new-episode/metadata.toml", "public/episodes/daily/new-episode/revisions/old.toml",
      "public/podcasts/daily/episodes/new-episode/old.mp3", "staging/episodes/daily/new-episode/old/audio.mp3",
      "staging/episodes/daily/new-episode/unknown"]) {
      const setup = await fixture();
      await setup.bucket.put(key, "preserve original");
      setup.writes.length = 0;
      await expect(claimStageUpload(setup.env, setup.request)).rejects.toThrow("existing data");
      expect(setup.writes).toHaveLength(0);
      expect(setup.entries.get(key)?.data).toBe("preserve original");
    }
  });

  test("prefix boundaries do not confuse sibling Episode or Show IDs with the new Episode", async () => {
    const setup = await fixture();
    await setup.bucket.put("public/episodes/daily/new-episode-extra/metadata.toml", "sibling");
    await setup.bucket.put("staging/episodes/daily-extra/new-episode/job/audio.mp3", "sibling");
    await claimStageUpload(setup.env, setup.request);
    expect((await readEpisodeLifecycle(setup.env, "daily", "new-episode"))?.lifecycle).toBe("draft");
  });

  test("incomplete inventory and missing list capability fail closed", async () => {
    for (const list of [async () => ({ objects: [], truncated: true, cursor: "unknown" }), undefined]) {
      const setup = await fixture();
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, list } } as never;
      await expect(claimStageUpload(env, setup.request)).rejects.toThrow();
      expect(setup.writes).toHaveLength(0);
    }
  });

  test("competing new Episode requests have one Show owner and cannot initialize a losing target", async () => {
    const setup = await fixture();
    const other = stageUploadRequestSchema.parse({ ...setup.request, operation_id: crypto.randomUUID(), episode_id: "another-episode" });
    const results = await Promise.allSettled([claimStageUpload(setup.env, setup.request), claimStageUpload(setup.env, other)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = (await readShowControl(setup.env, "daily"))!.value.owner!;
    expect(winner.episode_id).toBeDefined();
    const loser = winner.episode_id === "new-episode" ? "another-episode" : "new-episode";
    expect(await readEpisodeLifecycle(setup.env, "daily", loser)).toBeNull();
  });

  test("same-request initialization races preserve exactly one draft record and ready admission", async () => {
    const setup = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => claimStageUpload(setup.env, setup.request)));
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(setup.writes.filter((key) => key === setup.key)).toHaveLength(1);
    const operation = await claimStageUpload(setup.env, setup.request);
    expect((await beginStageUpload(setup.env, operation))[0]!.key).toContain("/new-episode/");
  });

  test("draft PUT failure before or after persistence retains owner and allows exact server-side claim reconciliation without issuing PUT permission", async () => {
    for (const afterWrite of [false, true]) {
      const setup = await fixture();
      let lose = true;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        if (args[0] === setup.key && lose) {
          lose = false;
          if (afterWrite) await setup.bucket.put(...args);
          throw new Error("Draft initialization response lost");
        }
        return setup.bucket.put(...args);
      } } } as never;
      await expect(claimStageUpload(env, setup.request)).rejects.toThrow("response lost");
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.request.operation_id);
      expect(setup.entries.has(`system/jobs/${setup.request.operation_id}/upload-progress.json`)).toBe(false);
      expect(setup.writes.some((key) => key.startsWith("staging/"))).toBe(false);
      const operation = await claimStageUpload(env, setup.request);
      expect((await readEpisodeLifecycle(setup.env, "daily", "new-episode"))?.generation).toBe(0);
      expect((await beginStageUpload(setup.env, operation))[0]!.key).toContain("/episode.toml");
    }
  });

  test("a late orphan object after preflight keeps Show ownership but does not initialize or overwrite data", async () => {
    const setup = await fixture();
    let lists = 0;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async list(...args: Parameters<typeof setup.bucket.list>) {
      if (++lists === 4) await setup.bucket.put("public/episodes/daily/new-episode/metadata.toml", "late orphan");
      return setup.bucket.list(...args);
    } } } as never;
    await expect(claimStageUpload(env, setup.request)).rejects.toThrow("existing data");
    expect(setup.entries.has(setup.key)).toBe(false);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.request.operation_id);
  });

  test("cannot recreate control after progress exists or from an unknown owner", async () => {
    const setup = await fixture();
    await expect(initializeOwnedEpisodeDraft(setup.env, setup.request)).rejects.toThrow("owns the Show");
    await claimStageUpload(setup.env, setup.request);
    setup.entries.delete(setup.key);
    await expect(claimStageUpload(setup.env, setup.request)).rejects.toThrow("progress exists");
    expect(setup.entries.has(setup.key)).toBe(false);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.request.operation_id);
  });

  test("conditional initialization never overwrites a late tombstone and keeps the exact stage owner", async () => {
    const setup = await fixture();
    const tombstone = stringifyLifecycleToml({ schema_version: 1, show_id: "daily", episode_id: "new-episode",
      lifecycle: "deleted", generation: 1 });
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      if (args[0] === setup.key) await setup.bucket.put(setup.key, tombstone);
      return setup.bucket.put(...args);
    } } } as never;
    await expect(claimStageUpload(env, setup.request)).rejects.toThrow("initialization conflicted");
    expect(setup.entries.get(setup.key)?.data).toBe(tombstone);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.request.operation_id);
    expect(setup.entries.has(`system/jobs/${setup.request.operation_id}/upload-progress.json`)).toBe(false);
  });

  test("invalid and oversized existing controls are rejected without changes", async () => {
    for (const data of ["", "schema_version = 1\nsecret = 'private'\n", "x".repeat(16385)]) {
      const setup = await fixture();
      await setup.bucket.put(setup.key, data);
      setup.writes.length = 0;
      await expect(claimStageUpload(setup.env, setup.request)).rejects.toThrow();
      expect(setup.writes).toHaveLength(0);
      expect(setup.entries.get(setup.key)?.data).toBe(data);
    }
  });
});
