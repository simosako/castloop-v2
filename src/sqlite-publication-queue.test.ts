import { afterEach, describe, expect, test } from "bun:test";
import { PublicationQueueConflict, SqlitePublicationQueue } from "./sqlite-publication-queue";
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

describe("SQLite publication FIFO", () => {
  test("new services remain paused until explicit resume", async () => {
    const value = fixture({ resume: false });
    expect(value.queue.snapshot()).toEqual({ state: "paused", admission_window_id: null, queued: 0, active: null, drained: true });
    await expect(value.queue.enqueue(value.request({ admission_window_id: crypto.randomUUID() }))).rejects.toThrow("paused");
    const windowId = crypto.randomUUID();
    expect(value.queue.resume(windowId).admission_window_id).toBe(windowId);
    expect(() => value.queue.resume("invalid")).toThrow();
  });

  test("jobs are taken in durable acceptance order, one at a time", async () => {
    const value = fixture();
    const first = await value.queue.enqueue(value.request());
    const second = await value.queue.enqueue(value.request({ episode_id: "second" }));
    expect(first.sequence).toBeLessThan(second.sequence);
    expect(value.alarm()).toBe(1000);
    value.clearAlarm();
    const claim = value.queue.claim();
    expect(claim.state).toBe("claimed");
    if (claim.state !== "claimed") throw new Error("Missing first claim");
    expect(claim.job.job_id).toBe(first.job_id);
    expect(value.queue.claim().state).toBe("interrupted");
    await value.queue.finish(first.job_id);
    expect(value.alarm()).toBe(1000);
    const next = value.queue.claim();
    expect(next.state).toBe("claimed");
    if (next.state !== "claimed") throw new Error("Missing second claim");
    expect(next.job.job_id).toBe(second.job_id);
    await value.queue.finish(second.job_id);
    expect(value.queue.snapshot().drained).toBe(true);
    expect(value.queue.claim()).toEqual({ state: "idle" });
  });

  test("concurrent submissions get distinct acceptance sequence numbers", async () => {
    const value = fixture();
    const results = await Promise.all(Array.from({ length: 12 }, () => value.queue.enqueue(value.request())));
    expect(new Set(results.map((result) => result.sequence)).size).toBe(12);
    expect(value.queue.snapshot().queued).toBe(12);
  });

  test("same request returns the same receipt without new jobs", async () => {
    const value = fixture();
    const request = value.request();
    const before = await value.queue.enqueue(request);
    expect(await value.queue.enqueue(request)).toEqual(before);
    value.queue.claim();
    await value.queue.finish(request.job_id);
    value.queue.pause();
    expect((await value.queue.enqueue(request)).state).toBe("succeeded");
    expect(value.queue.snapshot().queued).toBe(0);
  });

  test("same request or job ID cannot acquire a different frozen body", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    await expect(value.queue.enqueue({ ...request, expected_show_state_version: 2 })).rejects.toBeInstanceOf(PublicationQueueConflict);
    await expect(value.queue.enqueue({ ...request, request_id: crypto.randomUUID() })).rejects.toBeInstanceOf(PublicationQueueConflict);
    await expect(value.queue.enqueue(value.request({ request_id: request.request_id }))).rejects.toBeInstanceOf(PublicationQueueConflict);
    expect(value.queue.snapshot().queued).toBe(1);
  });

  test("foreign service, runtime, config and admission window are rejected", async () => {
    const value = fixture();
    for (const change of [{ service_id: "other" }, { worker_version_id: crypto.randomUUID() },
      { service_config_sha256: "f".repeat(64) }, { admission_window_id: crypto.randomUUID() }]) {
      await expect(value.queue.enqueue(value.request(change))).rejects.toThrow();
    }
    expect(value.queue.snapshot().drained).toBe(true);
  });

  test("alarm scheduling failure rolls back acceptance", async () => {
    const value = fixture();
    const request = value.request();
    value.failAlarm();
    await expect(value.queue.enqueue(request)).rejects.toThrow("scheduling");
    expect(value.queue.status(request.request_id)).toBeNull();
    expect(value.queue.snapshot().drained).toBe(true);
    expect(value.alarm()).toBeNull();
  });

  test("duplicate receipt can restore a missing wake-up without replaying a job", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    value.clearAlarm();
    expect(await value.queue.enqueue(request)).toMatchObject({ state: "queued" });
    expect(value.alarm()).toBe(1000);
    expect(value.queue.snapshot().queued).toBe(1);
  });

  test("pause stops new admission but preserves the accepted drain order", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    expect(value.queue.pause()).toMatchObject({ state: "paused", drained: false, queued: 1 });
    await expect(value.queue.enqueue(value.request())).rejects.toThrow("paused");
    expect(() => value.queue.resume(crypto.randomUUID())).toThrow("drained");
    expect(value.queue.claim().state).toBe("claimed");
    await value.queue.finish(request.job_id);
    expect(() => value.queue.resume(value.windowId!)).toThrow("new explicit");
    expect(value.queue.resume(crypto.randomUUID()).state).toBe("open");
  });

  test("running and blocked heads are never skipped", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    await value.queue.enqueue(value.request());
    value.queue.claim();
    const blocked = await value.queue.block(request.job_id, "execution_interrupted");
    expect(blocked.state).toBe("blocked");
    expect(value.queue.claim()).toEqual({ state: "blocked", job: blocked });
    expect(value.queue.snapshot()).toMatchObject({ queued: 1, drained: false, active: blocked });
    await expect(value.queue.enqueue(value.request())).rejects.toThrow("blocked");
    await expect(value.queue.finish(request.job_id)).rejects.toThrow("running");
    expect((await value.queue.enqueue(request)).state).toBe("blocked");
  });

  test("definitive validation failure keeps its result and allows the next job", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    await value.queue.enqueue(value.request());
    value.clearAlarm();
    value.queue.claim();
    expect(await value.queue.finish(request.job_id, "base_conflict")).toMatchObject({ state: "failed", reason_code: "base_conflict" });
    expect(value.alarm()).toBe(1000);
    expect(value.queue.claim().state).toBe("claimed");
    expect((await value.queue.enqueue(request)).state).toBe("failed");
  });

  test("completion and next wake-up are rolled back together", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    await value.queue.enqueue(value.request());
    value.clearAlarm();
    value.queue.claim();
    value.failAlarm();
    await expect(value.queue.finish(request.job_id)).rejects.toThrow("scheduling");
    expect(value.queue.status(request.request_id)?.state).toBe("running");
    expect(value.queue.snapshot()).toMatchObject({ queued: 1, drained: false });
  });

  test("schema and runtime mismatches never reset existing records", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    expect(() => new SqlitePublicationQueue(value.storage, { ...value.runtime, worker_version_id: crypto.randomUUID() })).toThrow("runtime");
    expect(value.queue.status(request.request_id)?.state).toBe("queued");
    value.database.exec("UPDATE publication_queue_schema SET version = 99");
    expect(() => new SqlitePublicationQueue(value.storage, value.runtime)).toThrow("Unsupported");
    expect(value.database.query("SELECT COUNT(*) AS count FROM publication_jobs").get()).toEqual({ count: 1 });
  });

  test("the earlier internal queue schema is rejected without implicit conversion", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    value.database.exec("UPDATE publication_queue_schema SET version = 1");
    expect(() => new SqlitePublicationQueue(value.storage, value.runtime)).toThrow("Unsupported");
    expect(value.database.query("SELECT job_id FROM publication_jobs").get()).toEqual({ job_id: request.job_id });
  });

  test("requests and interrupted execution survive closing and reopening SQLite", async () => {
    const directory = mkdtempSync("/tmp/opencode/castloop-sqlite-");
    const path = join(directory, "queue.sqlite");
    const before = sqlitePublicationFixture({ path });
    const runtime = before.runtime;
    const request = before.request();
    try {
      await before.queue.enqueue(request);
      before.queue.claim();
    } finally { before.close(); }
    const after = sqlitePublicationFixture({ path, runtime, resume: false });
    try {
      expect(after.queue.status(request.request_id)?.state).toBe("running");
      expect(after.queue.claim().state).toBe("interrupted");
      expect(after.queue.snapshot().drained).toBe(false);
    } finally { after.close(); rmSync(directory, { recursive: true }); }
  });
});
