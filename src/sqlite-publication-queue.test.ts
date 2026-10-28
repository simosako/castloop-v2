import { afterEach, describe, expect, test } from "bun:test";
import { PublicationQueueConflict, SqlitePublicationInputError, SqlitePublicationQueue } from "./sqlite-publication-queue";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const fixtures: Array<ReturnType<typeof sqlitePublicationFixture>> = [];
function fixture(options: Parameters<typeof sqlitePublicationFixture>[0] = {}) {
  const value = sqlitePublicationFixture(options);
  fixtures.push(value);
  return value;
}
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });

describe("SQLite synchronous publication queue", () => {
  test("new services remain paused until explicit resume", async () => {
    const value = fixture({ resume: false });
    expect(value.queue.snapshot()).toEqual({ state: "paused", admission_window_id: null, availability_version: 0, queued: 0, active: null, drained: true });
    await expect(value.queue.enqueue(value.request({ admission_window_id: crypto.randomUUID() }))).rejects.toThrow("paused");
    const windowId = crypto.randomUUID();
    expect(value.queue.resume(windowId).admission_window_id).toBe(windowId);
    expect(() => value.queue.resume("invalid")).toThrow();
  });

  test("publications execute synchronously in acceptance order and complete immediately", async () => {
    const value = fixture();
    const first = await value.queue.enqueue(value.request());
    const second = await value.queue.enqueue(value.request({ episode_id: "second" }));
    expect(first.state).toBe("succeeded");
    expect(second.state).toBe("succeeded");
    expect(first.sequence).toBeLessThan(second.sequence);
    expect(value.queue.snapshot()).toMatchObject({ queued: 0, active: null, drained: true });
  });

  test("concurrent submissions get distinct sequence numbers", async () => {
    const value = fixture();
    const results = await Promise.all(Array.from({ length: 12 }, () => value.queue.enqueue(value.request())));
    expect(new Set(results.map((result) => result.sequence)).size).toBe(12);
    expect(results.every((result) => result.state === "succeeded")).toBe(true);
    expect(value.queue.snapshot().drained).toBe(true);
  });

  test("same request returns the same receipt without re-executing", async () => {
    const value = fixture();
    let executions = 0;
    value.queue.executor = { execute: async () => { executions++; return () => {}; } };
    const request = value.request();
    const before = await value.queue.enqueue(request);
    expect(before.state).toBe("succeeded");
    expect(await value.queue.enqueue(request)).toEqual(before);
    value.queue.pause();
    expect(await value.queue.enqueue(request)).toEqual(before);
    expect(executions).toBe(1);
  });

  test("same request or job ID cannot acquire a different frozen body", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    await expect(value.queue.enqueue({ ...request, expected_show_state_version: 2 })).rejects.toBeInstanceOf(PublicationQueueConflict);
    await expect(value.queue.enqueue({ ...request, request_id: crypto.randomUUID() })).rejects.toBeInstanceOf(PublicationQueueConflict);
    await expect(value.queue.enqueue(value.request({ request_id: request.request_id }))).rejects.toBeInstanceOf(PublicationQueueConflict);
  });

  test("foreign service, runtime, config and admission window are rejected", async () => {
    const value = fixture();
    for (const change of [{ service_id: "other" }, { worker_version_id: crypto.randomUUID() },
      { service_config_sha256: "f".repeat(64) }, { admission_window_id: crypto.randomUUID() }]) {
      await expect(value.queue.enqueue(value.request(change))).rejects.toThrow();
    }
    expect(value.queue.snapshot().drained).toBe(true);
  });

  test("transient executor failure leaves no job record and allows immediate retry", async () => {
    const value = fixture();
    const request = value.request();
    let fail = true;
    value.queue.executor = {
      execute: async () => {
        if (fail) { fail = false; throw new Error("transient purge failure"); }
        return () => {};
      },
    };
    await expect(value.queue.enqueue(request)).rejects.toThrow("transient purge failure");
    expect(value.queue.status(request.request_id)).toBeNull();
    expect(value.queue.snapshot().drained).toBe(true);
    expect((await value.queue.enqueue(request)).state).toBe("succeeded");
  });

  test("pause stops new admission and resume requires a new explicit admission window", async () => {
    const value = fixture();
    const request = value.request();
    expect((await value.queue.enqueue(request)).state).toBe("succeeded");
    expect(value.queue.pause()).toMatchObject({ state: "paused", drained: true, queued: 0 });
    await expect(value.queue.enqueue(value.request())).rejects.toThrow("paused");
    expect(() => value.queue.resume(value.windowId!)).toThrow("new explicit");
    expect(value.queue.resume(crypto.randomUUID()).state).toBe("open");
  });

  test("definitive validation failure keeps its failed result and allows the next job", async () => {
    const value = fixture();
    const request = value.request();
    let first = true;
    value.queue.executor = {
      execute: async () => {
        if (first) { first = false; throw new SqlitePublicationInputError("base_conflict"); }
        return () => {};
      },
    };
    expect(await value.queue.enqueue(request)).toMatchObject({ state: "failed", reason_code: "base_conflict" });
    expect((await value.queue.enqueue(request)).state).toBe("failed");
    expect((await value.queue.enqueue(value.request())).state).toBe("succeeded");
  });

  test("schema and runtime mismatches never reset existing records", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    expect(() => new SqlitePublicationQueue(value.storage, { ...value.runtime, worker_version_id: crypto.randomUUID() })).toThrow("runtime");
    expect(value.queue.status(request.request_id)?.state).toBe("succeeded");
    value.database.exec("UPDATE publication_queue_schema SET version = 99");
    expect(() => new SqlitePublicationQueue(value.storage, value.runtime)).toThrow("Unsupported");
    expect(value.database.query("SELECT COUNT(*) AS count FROM publication_jobs").get()).toEqual({ count: 1 });
  });

  for (const version of [1, 9, 10, 11]) test(`earlier queue schema ${version} is rejected without implicit conversion`, async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    value.database.exec(`UPDATE publication_queue_schema SET version = ${version}`);
    expect(() => new SqlitePublicationQueue(value.storage, value.runtime)).toThrow("Unsupported");
    expect(value.database.query("SELECT job_id FROM publication_jobs").get()).toEqual({ job_id: request.job_id });
  });

  test("completed requests survive closing and reopening SQLite", async () => {
    const directory = mkdtempSync("/tmp/opencode/castloop-sqlite-");
    const path = join(directory, "queue.sqlite");
    const before = sqlitePublicationFixture({ path });
    const runtime = before.runtime;
    const request = before.request();
    try {
      await before.queue.enqueue(request);
    } finally { before.close(); }
    const after = sqlitePublicationFixture({ path, runtime, resume: false });
    try {
      expect(after.queue.status(request.request_id)?.state).toBe("succeeded");
      expect(after.queue.snapshot().drained).toBe(true);
    } finally { after.close(); rmSync(directory, { recursive: true }); }
  });
});
