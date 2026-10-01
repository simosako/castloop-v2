import { describe, expect, test } from "bun:test";
import { lifecycleJobStatusSchema, lifecycleProgressSchema, stringifyToml } from "../packages/shared/src/index";
import { acquireShowExecution, claimShowOperation, finishShowOperation, readShowControl } from "./lifecycle-control";
import { readLifecycleJobJournal, writeLifecycleJobStatus, writeLifecycleProgress } from "./lifecycle-job-store";
import { closeOwnedLifecycleTarget } from "./lifecycle-mutations";

async function fixture() {
  const entries = new Map<string, { data: string; etag: string }>();
  let version = 0;
  const bucket = {
    async get(key: string) {
      const value = entries.get(key);
      return value ? { ...value, size: new TextEncoder().encode(value.data).length,
        text: async () => value.data, json: async () => JSON.parse(value.data) } : null;
    },
    async head(key: string) { return entries.has(key) ? { key } : null; },
    async put(key: string, data: string, options?: { onlyIf?: Headers | { etagMatches: string } }) {
      const previous = entries.get(key);
      if (options?.onlyIf instanceof Headers && previous) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches !== previous?.etag) return null;
      const etag = String(++version);
      entries.set(key, { data, etag });
      return { etag };
    },
  };
  const env = { CASTLOOP_BUCKET: bucket } as never;
  const jobId = crypto.randomUUID();
  await bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily", lifecycle: "active",
    generation: 0, feed_generation: 0 }));
  await claimShowOperation(env, { schema_version: 1, job_id: jobId, show_id: "daily", kind: "show", action: "unpublish",
    expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z" });
  const execution = await acquireShowExecution(env, "daily", jobId, 1);
  const journal = await readLifecycleJobJournal(env, execution);
  const progress = lifecycleProgressSchema.parse({ schema_version: 1, ...journal.identity, phase: "visibility", deleted_objects: 0,
    purge_confirmed: false, updated_at: "2026-10-01T12:00:00Z" });
  const status = lifecycleJobStatusSchema.parse({ schema_version: 2, ...journal.identity, state: "processing", phase: "visibility" });
  return { entries, bucket, env, execution, journal, progress, status, jobId };
}

describe("M6 owner-checked job journal", () => {
  test("strict status/progress writes round trip under the same execution owner", async () => {
    const setup = await fixture();
    expect(setup.journal.status).toBeNull();
    expect(setup.journal.progress).toBeNull();
    await writeLifecycleProgress(setup.env, setup.execution, setup.progress);
    await writeLifecycleJobStatus(setup.env, setup.execution, setup.status);
    const result = await readLifecycleJobJournal(setup.env, setup.execution);
    expect(result.progress).toEqual(setup.progress);
    expect(result.status).toEqual(setup.status);
  });

  test("terminal status requires durable purge completion and the matching target state", async () => {
    const setup = await fixture();
    const completed = lifecycleJobStatusSchema.parse({ ...setup.status, state: "completed", phase: "finished", result_lifecycle: "unpublished" });
    await expect(writeLifecycleJobStatus(setup.env, setup.execution, completed)).rejects.toThrow("durable progress");
    await writeLifecycleProgress(setup.env, setup.execution, setup.progress);
    await expect(writeLifecycleJobStatus(setup.env, setup.execution, completed)).rejects.toThrow("finished, purged");
    const finished = { ...setup.progress, phase: "finished" as const, purge_confirmed: true };
    await writeLifecycleProgress(setup.env, setup.execution, finished);
    await expect(writeLifecycleJobStatus(setup.env, setup.execution, completed)).rejects.toThrow("target result");
    await closeOwnedLifecycleTarget(setup.env, setup.execution);
    await writeLifecycleJobStatus(setup.env, setup.execution, completed);
    await finishShowOperation(setup.env, setup.execution);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("finished progress and terminal status cannot regress or change their evidence", async () => {
    const setup = await fixture();
    await closeOwnedLifecycleTarget(setup.env, setup.execution);
    const finished = { ...setup.progress, phase: "finished" as const, purge_confirmed: true };
    await writeLifecycleProgress(setup.env, setup.execution, finished);
    const before = new Map(setup.entries);
    await writeLifecycleProgress(setup.env, setup.execution, { ...finished, updated_at: "2026-10-01T13:00:00Z" });
    expect(setup.entries).toEqual(before);
    await expect(writeLifecycleProgress(setup.env, setup.execution, setup.progress)).rejects.toThrow("cannot be changed");
    const completed = lifecycleJobStatusSchema.parse({ ...setup.status, state: "completed", phase: "finished", result_lifecycle: "unpublished" });
    await writeLifecycleJobStatus(setup.env, setup.execution, completed);
    await writeLifecycleJobStatus(setup.env, setup.execution, completed);
    await expect(writeLifecycleJobStatus(setup.env, setup.execution, setup.status)).rejects.toThrow("cannot be changed");
  });

  test("concurrent first writes compete on CAS instead of silently overwriting", async () => {
    const setup = await fixture();
    let readers = 0;
    const ready = Promise.withResolvers<void>();
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, get: async (key: string) => {
      const object = await setup.bucket.get(key);
      if (key === `system/jobs/${setup.jobId}/progress.toml`) {
        if (++readers === 2) ready.resolve();
        await ready.promise;
      }
      return object;
    } } } as never;
    const results = await Promise.allSettled([writeLifecycleProgress(env, setup.execution, setup.progress),
      writeLifecycleProgress(env, setup.execution, { ...setup.progress, phase: "feed" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  test("stale tokens and mismatched records never modify the journal", async () => {
    const setup = await fixture();
    await expect(writeLifecycleProgress(setup.env, { ...setup.execution, executionId: crypto.randomUUID() }, setup.progress)).rejects.toThrow("execution token");
    await expect(writeLifecycleProgress(setup.env, setup.execution, { ...setup.progress, request_sha256: "b".repeat(64) })).rejects.toThrow("owner");
    await expect(writeLifecycleJobStatus(setup.env, setup.execution, { ...setup.status, show_generation: 2 })).rejects.toThrow("owner");
    expect((await readLifecycleJobJournal(setup.env, setup.execution)).progress).toBeNull();
    expect((await readLifecycleJobJournal(setup.env, setup.execution)).status).toBeNull();
  });

  test("legacy or corrupt records fail closed instead of being rewritten", async () => {
    const setup = await fixture();
    const key = `system/jobs/${setup.jobId}/status.toml`;
    const old = stringifyToml({ schema_version: 1, job_id: setup.jobId, show_id: "daily", kind: "show", state: "failed" });
    await setup.bucket.put(key, old);
    await expect(readLifecycleJobJournal(setup.env, setup.execution)).rejects.toThrow("owner");
    await expect(writeLifecycleJobStatus(setup.env, setup.execution, setup.status)).rejects.toThrow("owner");
    expect(setup.entries.get(key)?.data).toBe(old);
    await setup.bucket.put(key, "x".repeat(16385));
    await expect(readLifecycleJobJournal(setup.env, setup.execution)).rejects.toThrow("size limit");
  });

  test("lost progress/status responses recover from retained remote records", async () => {
    for (const name of ["progress", "status"] as const) {
      const setup = await fixture();
      let lose = true;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        const written = await setup.bucket.put(...args);
        if (lose && args[0].endsWith(`/${name}.toml`)) { lose = false; throw new Error("Journal response lost"); }
        return written;
      } } } as never;
      const write = () => name === "progress" ? writeLifecycleProgress(env, setup.execution, setup.progress) :
        writeLifecycleJobStatus(env, setup.execution, setup.status);
      await expect(write()).rejects.toThrow("response lost");
      await write();
      expect((await readLifecycleJobJournal(env, setup.execution))[name]).toEqual(name === "progress" ? setup.progress : setup.status);
    }
  });
});
