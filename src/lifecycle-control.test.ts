import { describe, expect, test } from "bun:test";
import { episodeLifecycleSchema, parseShowControl, stringifyLifecycleToml } from "../packages/shared/src/index";
import type { ControlRequest, LifecycleState } from "../packages/shared/src/index";
import { abandonReservedShowOperation, acquireShowExecution, beginShowOperation, claimShowOperation,
  readEpisodeLifecycle, readPublicVisibility, readPublicVisibilitySnapshot, readShowControl,
  releaseShowExecution, requireShowExecution } from "./lifecycle-control";

function memoryBucket() {
  const entries = new Map<string, { data: string; etag: string }>();
  let revision = 0;
  return {
    entries,
    async get(key: string) {
      const value = entries.get(key);
      return value ? { etag: value.etag, size: new TextEncoder().encode(value.data).length,
        text: async () => value.data, json: async () => JSON.parse(value.data) } : null;
    },
    async head(key: string) { return entries.has(key) ? { key } : null; },
    async put(key: string, data: string, options?: { onlyIf?: Headers | { etagMatches: string } }) {
      const previous = entries.get(key);
      if (options?.onlyIf instanceof Headers && options.onlyIf.get("If-None-Match") === "*" && previous) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches !== previous?.etag) {
        return null;
      }
      const etag = String(++revision);
      entries.set(key, { data, etag });
      return { key, etag };
    },
  };
}

async function fixture(showState: LifecycleState = "active", episodeState: LifecycleState = "active") {
  const bucket = memoryBucket();
  const show = parseShowControl({ schema_version: 2, show_id: "daily", lifecycle: showState,
    generation: 0, feed_generation: 0 });
  const episode = episodeLifecycleSchema.parse({ schema_version: 1, show_id: "daily", episode_id: "first",
    lifecycle: episodeState, generation: 0 });
  await bucket.put("system/show-publications/daily.json", JSON.stringify(show));
  await bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml(episode));
  await bucket.put("system/show-reservations/daily.json", "{}");
  return { bucket, env: { CASTLOOP_BUCKET: bucket } as never };
}

function request(overrides: Partial<ControlRequest> = {}): ControlRequest {
  return { schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily", kind: "show",
    action: "unpublish", expected_show_generation: 0, created_at: "2026-09-30T12:00:00Z", ...overrides };
}

describe("M6 atomic Show control", () => {
  test("publication, lifecycle and staging compete for the same CAS owner", async () => {
    const { env } = await fixture();
    const operations = Array.from({ length: 16 }, (_, index) => request({
      action: (["publish", "stage", "unpublish", "delete"] as const)[index % 4],
      ...(index % 2 ? { kind: "episode", episode_id: "first", expected_episode_generation: 0 } : {}),
    }));
    const results = await Promise.allSettled(operations.map((input) => claimShowOperation(env, input)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(15);
    const current = await readShowControl(env, "daily");
    expect(current?.value.generation).toBe(1);
    expect(current?.value.lifecycle).toBe("active");
    expect(current?.value.feed_generation).toBe(0);
  });

  test("the same frozen request is idempotent across concurrent claims and processing", async () => {
    const { env } = await fixture();
    const input = request();
    const results = await Promise.all(Array.from({ length: 6 }, () => claimShowOperation(env, input)));
    expect(new Set(results.map((result) => result.value.owner?.job_id))).toEqual(new Set([input.job_id]));
    expect((await claimShowOperation(env, Object.fromEntries(Object.entries(input).reverse())))
      .value.owner?.job_id).toBe(input.job_id);
    const begun = await beginShowOperation(env, "daily", input.job_id, 1);
    expect(begun.value.owner?.state).toBe("processing");
    expect((await beginShowOperation(env, "daily", input.job_id, 1)).etag).toBe(begun.etag);
    expect((await claimShowOperation(env, input)).value.owner?.state).toBe("processing");
    await expect(claimShowOperation(env, request())).rejects.toThrow("unfinished operation");
    await expect(claimShowOperation(env, { ...input, action: "delete" })).rejects.toThrow("unfinished operation");
  });

  test("a lost CAS response is recovered without claiming another job", async () => {
    const { bucket } = await fixture();
    let loseResponse = true;
    const env = { CASTLOOP_BUCKET: { ...bucket, async put(...args: Parameters<typeof bucket.put>) {
      const result = await bucket.put(...args);
      if (loseResponse && args[0] === "system/show-publications/daily.json" && result) {
        loseResponse = false;
        throw new Error("Response was lost");
      }
      return result;
    } } } as never;
    const input = request();
    await expect(claimShowOperation(env, input)).rejects.toThrow("Response was lost");
    expect((await claimShowOperation(env, input)).value.owner?.job_id).toBe(input.job_id);
    expect((await readShowControl(env, "daily"))?.value.generation).toBe(1);
  });

  test("a lost frozen-request response leaves the Show free and can be retried", async () => {
    const { bucket } = await fixture();
    let loseResponse = true;
    const env = { CASTLOOP_BUCKET: { ...bucket, async put(...args: Parameters<typeof bucket.put>) {
      const result = await bucket.put(...args);
      if (loseResponse && args[0].endsWith("/request.toml") && result) {
        loseResponse = false;
        throw new Error("Request response was lost");
      }
      return result;
    } } } as never;
    const input = request();
    await expect(claimShowOperation(env, input)).rejects.toThrow("Request response was lost");
    expect((await readShowControl(env, "daily"))?.value.owner).toBeUndefined();
    expect((await claimShowOperation(env, input)).value.owner?.job_id).toBe(input.job_id);
  });

  test("a lost processing response retains ownership and supports the same retry", async () => {
    const { bucket, env: original } = await fixture();
    const input = request();
    await claimShowOperation(original, input);
    let loseResponse = true;
    const env = { CASTLOOP_BUCKET: { ...bucket, async put(...args: Parameters<typeof bucket.put>) {
      const result = await bucket.put(...args);
      if (loseResponse && args[0] === "system/show-publications/daily.json" && result) {
        loseResponse = false;
        throw new Error("Processing response was lost");
      }
      return result;
    } } } as never;
    await expect(beginShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("Processing response was lost");
    expect((await beginShowOperation(env, "daily", input.job_id, 1)).value.owner?.state).toBe("processing");
    await expect(beginShowOperation(env, "daily", crypto.randomUUID(), 1)).rejects.toThrow("no longer owns");
  });

  test("staging has an uploading owner and cannot enter consumer processing", async () => {
    const { env } = await fixture();
    const input = request({ action: "stage" });
    expect((await claimShowOperation(env, input)).value.owner?.state).toBe("uploading");
    await expect(beginShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("reserved operation");
    await expect(claimShowOperation(env, request({ action: "delete" }))).rejects.toThrow("unfinished operation");
  });

  test("Show and Episode generations are checked before creating an owner", async () => {
    const { env, bucket } = await fixture();
    await expect(claimShowOperation(env, request({ expected_show_generation: 1 }))).rejects.toThrow("Show generation changed");
    await expect(claimShowOperation(env, request({ kind: "episode", episode_id: "first",
      expected_episode_generation: 1 }))).rejects.toThrow("Episode generation changed");
    expect((await readShowControl(env, "daily"))?.value.owner).toBeUndefined();
    expect([...bucket.entries.keys()].some((key) => key.endsWith("request.toml"))).toBe(false);
  });

  test("stale request and reused job ID cannot obtain ownership after release", async () => {
    const { env, bucket } = await fixture();
    const input = request();
    const claimed = await claimShowOperation(env, input);
    const { owner: _owner, ...released } = claimed.value;
    await bucket.put("system/show-publications/daily.json", JSON.stringify(released));
    await expect(claimShowOperation(env, input)).rejects.toThrow("Show generation changed");
    await expect(claimShowOperation(env, { ...input, expected_show_generation: 1 })).rejects.toThrow("different control request");
    await expect(beginShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("no longer owns");
  });

  test("an existing old job status also prevents job ID reuse", async () => {
    const { env, bucket } = await fixture();
    const input = request();
    await bucket.put(`system/jobs/${input.job_id}/status.toml`, "old status");
    await expect(claimShowOperation(env, input)).rejects.toThrow("already been used");
    expect((await readShowControl(env, "daily"))?.value.owner).toBeUndefined();
  });

  test("missing or changed frozen requests prevent a consumer from starting", async () => {
    const { env, bucket } = await fixture();
    const input = request();
    await claimShowOperation(env, input);
    bucket.entries.delete(`system/jobs/${input.job_id}/request.toml`);
    await expect(beginShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("request is missing");
    await bucket.put(`system/jobs/${input.job_id}/request.toml`, stringifyLifecycleToml({ ...input, action: "delete" }));
    await expect(beginShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("does not match");
    expect((await readShowControl(env, "daily"))?.value.owner?.state).toBe("reserved");
  });

  test("legacy admissions are never silently migrated or overwritten", async () => {
    const { env, bucket } = await fixture();
    const old = JSON.stringify({ job_id: crypto.randomUUID(), state: "processing" });
    await bucket.put("system/show-publications/daily.json", old);
    await expect(claimShowOperation(env, request({ action: "delete" }))).rejects.toThrow();
    expect(bucket.entries.get("system/show-publications/daily.json")?.data).toBe(old);
  });
});

describe("M6 per-invocation execution admission", () => {
  test("duplicate deliveries of the same job have only one executing invocation", async () => {
    const { env } = await fixture();
    const input = request();
    await claimShowOperation(env, input);
    const results = await Promise.allSettled(Array.from({ length: 16 }, () =>
      acquireShowExecution(env, "daily", input.job_id, 1)));
    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const execution = winners[0]!.status === "fulfilled" ? winners[0]!.value : null;
    expect(execution).not.toBeNull();
    expect((await requireShowExecution(env, execution!)).value.owner?.execution_id).toBe(execution!.executionId);
    await expect(acquireShowExecution(env, "daily", input.job_id, 1)).rejects.toThrow("still executing");
    await expect(abandonReservedShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("unstarted reserved");
    await releaseShowExecution(env, execution!);
    const next = await acquireShowExecution(env, "daily", input.job_id, 1);
    expect(next.executionId).not.toBe(execution!.executionId);
    await expect(releaseShowExecution(env, execution!)).rejects.toThrow("execution token");
    expect((await requireShowExecution(env, next)).value.owner?.execution_id).toBe(next.executionId);
  });

  test("execution release retains the processing owner and cannot free a different job", async () => {
    const { env } = await fixture();
    const input = request();
    await claimShowOperation(env, input);
    const execution = await acquireShowExecution(env, "daily", input.job_id, 1);
    for (const invalid of [{ executionId: crypto.randomUUID() }, { generation: 2 }, { jobId: crypto.randomUUID() }]) {
      await expect(releaseShowExecution(env, { ...execution, ...invalid })).rejects.toThrow();
    }
    const released = await releaseShowExecution(env, execution);
    expect(released.value.owner?.state).toBe("processing");
    expect(released.value.owner?.execution_id).toBeUndefined();
    expect(released.value.generation).toBe(1);
    expect(released.value.lifecycle).toBe("active");
    expect((await releaseShowExecution(env, execution)).etag).toBe(released.etag);
    await expect(claimShowOperation(env, request({ expected_show_generation: 1 }))).rejects.toThrow("unfinished operation");
  });

  test("unknown acquisition outcomes retain the token and never automatically steal it", async () => {
    const { env: original, bucket } = await fixture();
    const input = request();
    await claimShowOperation(original, input);
    const env = { CASTLOOP_BUCKET: { ...bucket, async put(...args: Parameters<typeof bucket.put>) {
      const result = await bucket.put(...args);
      if (result && args[0] === "system/show-publications/daily.json") throw new Error("Execution response lost");
      return result;
    } } } as never;
    await expect(acquireShowExecution(env, "daily", input.job_id, 1)).rejects.toThrow("response lost");
    expect((await readShowControl(original, "daily"))?.value.owner?.execution_id).toBeDefined();
    await expect(acquireShowExecution(original, "daily", input.job_id, 1)).rejects.toThrow("still executing");
  });

  test("release response loss is idempotent without clearing the operation", async () => {
    const { env: original, bucket } = await fixture();
    const input = request();
    await claimShowOperation(original, input);
    const execution = await acquireShowExecution(original, "daily", input.job_id, 1);
    const env = { CASTLOOP_BUCKET: { ...bucket, async put(...args: Parameters<typeof bucket.put>) {
      const result = await bucket.put(...args);
      if (result && args[0] === "system/show-publications/daily.json") throw new Error("Release response lost");
      return result;
    } } } as never;
    await expect(releaseShowExecution(env, execution)).rejects.toThrow("response lost");
    expect((await releaseShowExecution(original, execution)).value.owner?.job_id).toBe(input.job_id);
  });

  test("staging and tampered frozen requests cannot execute", async () => {
    const { env, bucket } = await fixture();
    const staged = request({ action: "stage" });
    await claimShowOperation(env, staged);
    await expect(acquireShowExecution(env, "daily", staged.job_id, 1)).rejects.toThrow("staging operation");
    const second = await fixture();
    const input = request();
    await claimShowOperation(second.env, input);
    await second.bucket.put(`system/jobs/${input.job_id}/request.toml`, stringifyLifecycleToml({ ...input, action: "delete" }));
    await expect(acquireShowExecution(second.env, "daily", input.job_id, 1)).rejects.toThrow("does not match");
    expect(bucket.entries.has(`system/jobs/${staged.job_id}/request.toml`)).toBe(true);
  });
});

describe("M6 reserved-operation abandonment", () => {
  test("abandonment atomically revokes ownership without changing public state", async () => {
    const { env } = await fixture();
    const input = request();
    await claimShowOperation(env, input);
    const abandoned = await abandonReservedShowOperation(env, "daily", input.job_id, 1);
    expect(abandoned.value.owner).toBeUndefined();
    expect(abandoned.value.lifecycle).toBe("active");
    expect(abandoned.value.feed_generation).toBe(0);
    expect(abandoned.value.generation).toBe(2);
    expect(abandoned.value.last_abandoned_operation?.job_id).toBe(input.job_id);
    expect((await abandonReservedShowOperation(env, "daily", input.job_id, 1)).etag).toBe(abandoned.etag);
    await expect(beginShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("no longer owns");
    await expect(claimShowOperation(env, input)).rejects.toThrow("Show generation changed");
    await expect(claimShowOperation(env, { ...input, expected_show_generation: 2 })).rejects.toThrow("different control request");
    const next = await claimShowOperation(env, request({ expected_show_generation: 2, action: "delete" }));
    expect(next.value.generation).toBe(3);
  });

  test("begin and abandon compete for the same CAS; processing cannot be revoked", async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const { env } = await fixture();
      const input = request();
      await claimShowOperation(env, input);
      const contenders = [() => beginShowOperation(env, "daily", input.job_id, 1),
        () => abandonReservedShowOperation(env, "daily", input.job_id, 1)];
      if (attempt % 2) contenders.reverse();
      const results = await Promise.allSettled(contenders.map((run) => run()));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const current = (await readShowControl(env, "daily"))!;
      if (current.value.owner) {
        expect(current.value.owner.state).toBe("processing");
        await expect(abandonReservedShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("unstarted reserved");
      } else {
        expect(current.value.last_abandoned_operation?.job_id).toBe(input.job_id);
        await expect(beginShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("no longer owns");
      }
    }
  });

  test("uploading, stale generations and mismatched requests never release the Show", async () => {
    const { env, bucket } = await fixture();
    const input = request({ action: "stage" });
    await claimShowOperation(env, input);
    await expect(abandonReservedShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("unstarted reserved");
    await expect(abandonReservedShowOperation(env, "daily", input.job_id, 2)).rejects.toThrow("does not match");
    await bucket.put(`system/jobs/${input.job_id}/request.toml`, stringifyLifecycleToml({ ...input, action: "delete" }));
    await expect(abandonReservedShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("no longer owns");
    expect((await readShowControl(env, "daily"))?.value.owner?.state).toBe("uploading");
  });

  test("a lost abandonment response is recovered from the same atomic control record", async () => {
    const { env: original, bucket } = await fixture();
    const input = request();
    await claimShowOperation(original, input);
    let loseResponse = true;
    const env = { CASTLOOP_BUCKET: { ...bucket, async put(...args: Parameters<typeof bucket.put>) {
      const result = await bucket.put(...args);
      if (loseResponse && args[0] === "system/show-publications/daily.json" && result) {
        loseResponse = false;
        throw new Error("Abandonment response was lost");
      }
      return result;
    } } } as never;
    await expect(abandonReservedShowOperation(env, "daily", input.job_id, 1)).rejects.toThrow("response was lost");
    const retried = await abandonReservedShowOperation(env, "daily", input.job_id, 1);
    expect(retried.value.generation).toBe(2);
    expect(retried.value.owner).toBeUndefined();
  });

  test("a later abandonment does not allow an older job ID to be reclaimed", async () => {
    const { env } = await fixture();
    const first = request();
    await claimShowOperation(env, first);
    await abandonReservedShowOperation(env, "daily", first.job_id, 1);
    const second = request({ expected_show_generation: 2 });
    await claimShowOperation(env, second);
    await abandonReservedShowOperation(env, "daily", second.job_id, 3);
    await expect(beginShowOperation(env, "daily", first.job_id, 1)).rejects.toThrow("no longer owns");
    await expect(claimShowOperation(env, { ...first, expected_show_generation: 4 })).rejects.toThrow("different control request");
  });
});

describe("M6 lifecycle admission policies", () => {
  test("unpublished and deleted Show/Episode cannot be implicitly published", async () => {
    for (const state of ["unpublished", "deleting", "deleted"] as const) {
      const show = await fixture(state);
      await expect(claimShowOperation(show.env, request({ action: "publish" }))).rejects.toThrow("does not permit");
      const episode = await fixture("active", state);
      await expect(claimShowOperation(episode.env, request({ action: "publish", kind: "episode",
        episode_id: "first", expected_episode_generation: 0 }))).rejects.toThrow("does not permit");
    }
  });

  test("only explicit restore accepts an unpublished target", async () => {
    const stopped = await fixture("unpublished");
    expect((await claimShowOperation(stopped.env, request({ action: "restore" }))).value.owner?.action).toBe("restore");
    const active = await fixture();
    await expect(claimShowOperation(active.env, request({ action: "restore" }))).rejects.toThrow("does not permit");
  });

  test("a stopped Show allows child unpublish/delete but not restore or upload", async () => {
    for (const action of ["unpublish", "delete"] as const) {
      const { env } = await fixture("unpublished");
      expect((await claimShowOperation(env, request({ action, kind: "episode", episode_id: "first",
        expected_episode_generation: 0 }))).value.owner?.action).toBe(action);
    }
    for (const action of ["restore", "stage"] as const) {
      const { env } = await fixture("unpublished", "unpublished");
      await expect(claimShowOperation(env, request({ action, kind: "episode", episode_id: "first",
        expected_episode_generation: 0 }))).rejects.toThrow("does not permit");
    }
  });
});

describe("M6 uncached public visibility policy", () => {
  test("public decisions carry cache generations from the same reads without a second Show lookup", async () => {
    const { bucket, env: original } = await fixture();
    const control = (await readShowControl(original, "daily"))!.value;
    await bucket.put("system/show-publications/daily.json", JSON.stringify({ ...control, generation: 7, feed_generation: 4 }));
    const episode = (await readEpisodeLifecycle(original, "daily", "first"))!;
    await bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({ ...episode, generation: 3 }));
    const reads: string[] = [];
    const env = { CASTLOOP_BUCKET: { ...bucket, async get(key: string) { reads.push(key); return bucket.get(key); } } } as never;
    expect(await readPublicVisibilitySnapshot(env, "daily")).toEqual({ visibility: "public", showId: "daily",
      showGeneration: 7, feedGeneration: 4 });
    expect(reads).toEqual(["system/show-publications/daily.json"]);
    reads.length = 0;
    expect(await readPublicVisibilitySnapshot(env, "daily", "first")).toEqual({ visibility: "public", showId: "daily",
      episodeId: "first", showGeneration: 7, feedGeneration: 4, episodeGeneration: 3 });
    expect(reads).toEqual(["system/show-publications/daily.json", "system/episode-lifecycle/daily/first.toml"]);
  });

  test("non-public snapshots contain no public generation token; an empty Episode ID is not a Show lookup", async () => {
    const { env } = await fixture("unpublished");
    expect(await readPublicVisibilitySnapshot(env, "daily")).toEqual({ visibility: "not_found" });
    await expect(readPublicVisibilitySnapshot(env, "daily", "")).rejects.toThrow();
    const deleted = await fixture("deleted");
    expect(await readPublicVisibilitySnapshot(deleted.env, "daily")).toEqual({ visibility: "gone" });
  });

  test("Show state gates every asset and preserves independent child state", async () => {
    for (const [state, result] of [["draft", "not_found"], ["active", "public"],
      ["unpublished", "not_found"], ["deleting", "gone"], ["deleted", "gone"]] as const) {
      const { env } = await fixture(state);
      expect(await readPublicVisibility(env, "daily")).toBe(result);
      expect(await readPublicVisibility(env, "daily", "first")).toBe(result);
      expect((await readEpisodeLifecycle(env, "daily", "first"))?.lifecycle).toBe("active");
    }
    for (const [state, result] of [["draft", "not_found"], ["active", "public"],
      ["unpublished", "not_found"], ["deleting", "gone"], ["deleted", "gone"]] as const) {
      const { env } = await fixture("active", state);
      expect(await readPublicVisibility(env, "daily", "first")).toBe(result);
      expect(await readPublicVisibility(env, "daily")).toBe("public");
    }
  });

  test("visibility is read afresh after state changes without a process-local cache", async () => {
    const { env, bucket } = await fixture();
    expect(await readPublicVisibility(env, "daily", "first")).toBe("public");
    const episode = (await readEpisodeLifecycle(env, "daily", "first"))!;
    await bucket.put("system/episode-lifecycle/daily/first.toml",
      stringifyLifecycleToml({ ...episode, lifecycle: "unpublished", generation: 1 }));
    expect(await readPublicVisibility(env, "daily", "first")).toBe("not_found");
  });

  test("unknown targets are not found; missing state for known targets fails closed", async () => {
    const { env, bucket } = await fixture();
    expect(await readPublicVisibility(env, "unknown")).toBe("not_found");
    expect(await readPublicVisibility(env, "daily", "unknown")).toBe("not_found");
    bucket.entries.delete("system/episode-lifecycle/daily/first.toml");
    await bucket.put("public/episodes/daily/first/metadata.toml", "published metadata");
    await expect(readPublicVisibility(env, "daily", "first")).rejects.toThrow("no lifecycle control record");
    bucket.entries.delete("system/show-publications/daily.json");
    await expect(readPublicVisibility(env, "daily")).rejects.toThrow("no lifecycle control record");
  });

  test("corrupt, oversized and mismatched records never produce public visibility", async () => {
    const { env, bucket } = await fixture();
    const key = "system/show-publications/daily.json";
    await bucket.put(key, "not json");
    await expect(readPublicVisibility(env, "daily")).rejects.toThrow();
    await bucket.put(key, "x".repeat(16385));
    await expect(readPublicVisibility(env, "daily")).rejects.toThrow("size limit");
    await bucket.put(key, JSON.stringify({ schema_version: 2, show_id: "other", lifecycle: "active",
      generation: 0, feed_generation: 0 }));
    await expect(readPublicVisibility(env, "daily")).rejects.toThrow("does not match its key");
  });

  test("R2 read failures are not replaced with a cached public decision", async () => {
    const { bucket } = await fixture();
    for (const key of ["system/show-publications/daily.json", "system/episode-lifecycle/daily/first.toml"]) {
      const env = { CASTLOOP_BUCKET: { ...bucket, async get(requested: string) {
        if (requested === key) throw new Error("R2 read failed");
        return bucket.get(requested);
      } } } as never;
      await expect(readPublicVisibility(env, "daily", "first")).rejects.toThrow("R2 read failed");
    }
  });
});
