import { describe, expect, test } from "bun:test";
import { lifecycleCommitKey, stringifyLifecycleToml } from "../packages/shared/src/index";
import { commitOwnedLifecycleOperation, InvalidLifecycleCommit, readLifecycleCommit } from "./lifecycle-commit";
import { abandonReservedShowOperation, acquireShowExecution, readShowControl } from "./lifecycle-control";
import { lifecycleFixture } from "./test-support/lifecycle";

describe("M6 owner-checked frozen commit creation", () => {
  test("each lifecycle action commits only the reserved target, without starting side effects", async () => {
    for (const action of ["unpublish", "restore", "delete"] as const) {
      for (const kind of ["show", "episode"] as const) {
        const setup = await lifecycleFixture({ action, kind });
        const before = (await readShowControl(setup.env, "daily"))!.value;
        const result = await commitOwnedLifecycleOperation(setup.env, setup.operation);
        expect(result.created).toBe(true);
        expect(result.marker.action).toBe(action);
        expect(result.marker.kind).toBe(kind);
        expect(await readLifecycleCommit(setup.env, result.key)).toEqual(result.marker);
        expect((await readShowControl(setup.env, "daily"))!.value).toEqual(before);
        const count = setup.writes.length;
        expect((await commitOwnedLifecycleOperation(setup.env, setup.operation)).created).toBe(false);
        expect(setup.writes).toHaveLength(count);
      }
    }
  });

  test("simultaneous commit creation is immutable with one CAS winner", async () => {
    const setup = await lifecycleFixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => commitOwnedLifecycleOperation(setup.env, setup.operation)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    for (const result of results) expect(result.marker).toEqual(results[0]!.marker);
  });

  test("lost commit success recovers from the existing marker without rewriting it", async () => {
    const setup = await lifecycleFixture();
    let lose = true;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      const written = await setup.bucket.put(...args);
      if (lose && args[0].endsWith("/commit.json") && written) { lose = false; throw new Error("Commit response lost"); }
      return written;
    } } } as never;
    await expect(commitOwnedLifecycleOperation(env, setup.operation)).rejects.toThrow("response lost");
    const count = setup.writes.length;
    expect((await commitOwnedLifecycleOperation(env, setup.operation)).created).toBe(false);
    expect(setup.writes).toHaveLength(count);
  });

  test("existing markers can be checked during processing but missing ones cannot be created then", async () => {
    const setup = await lifecycleFixture();
    const committed = await commitOwnedLifecycleOperation(setup.env, setup.operation);
    await acquireShowExecution(setup.env, "daily", setup.jobId, 1);
    expect((await commitOwnedLifecycleOperation(setup.env, setup.operation)).created).toBe(false);
    setup.entries.delete(committed.key);
    await expect(commitOwnedLifecycleOperation(setup.env, setup.operation)).rejects.toThrow("unstarted reserved");
  });

  test("canceled, stale, publication and staging owners cannot create lifecycle commits", async () => {
    const setup = await lifecycleFixture();
    await expect(commitOwnedLifecycleOperation(setup.env, { ...setup.operation, generation: 2 })).rejects.toThrow("owns");
    await abandonReservedShowOperation(setup.env, "daily", setup.jobId, 1);
    await expect(commitOwnedLifecycleOperation(setup.env, setup.operation)).rejects.toThrow("owns");
    for (const action of ["stage", "publish"] as const) {
      const other = await lifecycleFixture({ action });
      await expect(commitOwnedLifecycleOperation(other.env, other.operation)).rejects.toThrow();
      expect([...other.entries.keys()].some((key) => key.endsWith("/commit.json"))).toBe(false);
    }
  });

  test("corrupt or target/hash/action-mismatched markers and requests fail closed without overwriting", async () => {
    for (const fault of ["invalid-json", "oversized", "target", "action", "hash", "unknown-field", "request", "missing-request"] as const) {
      const setup = await lifecycleFixture();
      const committed = await commitOwnedLifecycleOperation(setup.env, setup.operation);
      const source = fault === "invalid-json" ? "{" : fault === "oversized" ? "x".repeat(16385) : JSON.stringify({ ...committed.marker,
        ...(fault === "target" ? { show_id: "other" } : fault === "action" ? { action: "delete" } :
          fault === "hash" ? { request_sha256: "b".repeat(64) } : fault === "unknown-field" ? { title: "Private title" } : {}) });
      await setup.bucket.put(committed.key, source);
      if (fault === "request") await setup.bucket.put(`system/jobs/${setup.jobId}/request.toml`,
        stringifyLifecycleToml({ ...setup.request, created_at: "2026-10-01T13:00:00Z" }));
      if (fault === "missing-request") setup.entries.delete(`system/jobs/${setup.jobId}/request.toml`);
      await expect(readLifecycleCommit(setup.env, committed.key)).rejects.toBeInstanceOf(InvalidLifecycleCommit);
      await expect(commitOwnedLifecycleOperation(setup.env, setup.operation)).rejects.toThrow();
      expect(setup.entries.get(committed.key)!.data).toBe(source);
    }
  });

  test("transport failures reading a marker body remain retryable errors, not invalid-input diagnoses", async () => {
    const setup = await lifecycleFixture();
    const committed = await commitOwnedLifecycleOperation(setup.env, setup.operation);
    const failure = new Error("R2 stream failed");
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async get(key: string) {
      const object = await setup.bucket.get(key);
      return object && key === committed.key ? { ...object, async text() { throw failure; } } : object;
    } } } as never;
    await expect(readLifecycleCommit(env, committed.key)).rejects.toBe(failure);
    expect(await readLifecycleCommit(setup.env, lifecycleCommitKey({ kind: "show", show_id: "daily", job_id: crypto.randomUUID() }))).toBeNull();
  });
});
