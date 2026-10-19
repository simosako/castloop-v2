import { afterEach, describe, expect, test } from "bun:test";
import { SqlitePublicationAlarm, SqlitePublicationInputError } from "./sqlite-publication-alarm";
import type { SqlitePublicationEvent } from "./sqlite-publication-alarm";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";

const fixtures: Array<ReturnType<typeof sqlitePublicationFixture>> = [];
function fixture() {
  const value = sqlitePublicationFixture();
  fixtures.push(value);
  return value;
}
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SQLite publication Alarm execution", () => {
  test("one alarm executes one job and schedules the next only after completion", async () => {
    const value = fixture();
    const first = value.request();
    const second = value.request({ episode_id: "second" });
    await value.queue.enqueue(first);
    await value.queue.enqueue(second);
    const actions: string[] = [];
    const events: SqlitePublicationEvent[] = [];
    const runner = new SqlitePublicationAlarm(value.queue, {
      async validate(request) { actions.push(`validate:${request.job_id}`); return request; },
      async publish(request) { actions.push(`publish:${request.job_id}`); },
    }, (event) => { events.push(event); });
    value.clearAlarm();
    expect(await runner.alarm()).toMatchObject({ state: "succeeded", job_id: first.job_id });
    expect(actions).toEqual([`validate:${first.job_id}`, `publish:${first.job_id}`]);
    expect(value.queue.status(second.request_id)?.state).toBe("queued");
    expect(value.alarm()).toBe(1000);
    value.clearAlarm();
    expect(await runner.alarm()).toMatchObject({ state: "succeeded", job_id: second.job_id });
    expect(events.map((event) => event.phase)).toEqual(["started", "succeeded", "started", "succeeded"]);
    expect(events[0]!.invocation_id).toBe(events[1]!.invocation_id);
    expect(events[0]!.invocation_id).not.toBe(events[2]!.invocation_id);
    expect(value.alarm()).toBeNull();
    expect(await runner.alarm()).toEqual({ state: "idle" });
  });

  test("all publication and purge IO settles before success and the next job", async () => {
    const value = fixture();
    const first = value.request();
    await value.queue.enqueue(first);
    const entered = deferred();
    const put = deferred();
    const purge = deferred();
    const actions: string[] = [];
    const runner = new SqlitePublicationAlarm(value.queue, {
      async validate(request) { return request; },
      async publish() {
        entered.resolve();
        await put.promise;
        actions.push("put-settled");
        await purge.promise;
        actions.push("purge-settled");
      },
    }, () => {});
    value.clearAlarm();
    const execution = runner.alarm();
    await entered.promise;
    expect(value.queue.status(first.request_id)?.state).toBe("running");
    expect(await runner.alarm()).toEqual({ state: "busy" });
    const second = await value.queue.enqueue(value.request({ episode_id: "second" }));
    expect(second.state).toBe("queued");
    expect(value.alarm()).toBeNull();
    put.resolve();
    await Promise.resolve();
    expect(actions).toEqual(["put-settled"]);
    expect(value.queue.status(first.request_id)?.state).toBe("running");
    expect(value.alarm()).toBeNull();
    purge.resolve();
    expect(await execution).toMatchObject({ state: "succeeded" });
    expect(actions).toEqual(["put-settled", "purge-settled"]);
    expect(value.alarm()).toBe(1000);
  });

  test("definitive validation errors fail without calling the publisher", async () => {
    const value = fixture();
    const first = value.request();
    await value.queue.enqueue(first);
    await value.queue.enqueue(value.request());
    let published = 0;
    const runner = new SqlitePublicationAlarm(value.queue, {
      async validate() { throw new SqlitePublicationInputError("base_conflict"); },
      async publish() { published++; },
    }, () => {});
    value.clearAlarm();
    expect(await runner.alarm()).toMatchObject({ state: "failed", reason_code: "base_conflict" });
    expect(published).toBe(0);
    expect(value.queue.snapshot()).toMatchObject({ active: null, queued: 1, drained: false });
    expect(value.alarm()).toBe(1000);
  });

  test("unclassified validation failures block instead of inventing an input failure", async () => {
    const value = fixture();
    const first = value.request();
    await value.queue.enqueue(first);
    await value.queue.enqueue(value.request());
    const events: SqlitePublicationEvent[] = [];
    const runner = new SqlitePublicationAlarm(value.queue, {
      async validate() { throw new Error("private API failure and secret"); },
      async publish() { throw new Error("must not run"); },
    }, (event) => { events.push(event); });
    value.clearAlarm();
    expect(await runner.alarm()).toMatchObject({ state: "blocked", reason_code: "validation_unavailable" });
    expect(value.alarm()).toBeNull();
    expect(value.queue.snapshot().queued).toBe(1);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain(first.payloads[0].key);
  });

  test("publisher failure cannot become a pre-write rejection even for a typed input error", async () => {
    const value = fixture();
    await value.queue.enqueue(value.request());
    await value.queue.enqueue(value.request());
    let writes = 0;
    const runner = new SqlitePublicationAlarm(value.queue, {
      async validate(request) { return request; },
      async publish() { writes++; throw new SqlitePublicationInputError("validation_failed"); },
    }, () => {});
    value.clearAlarm();
    expect(await runner.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_failed" });
    expect(await runner.alarm()).toMatchObject({ state: "blocked" });
    expect(writes).toBe(1);
    expect(value.queue.snapshot().queued).toBe(1);
    expect(value.alarm()).toBeNull();
  });

  test("runtime recreation finds running job and blocks without replay or time-based release", async () => {
    const value = fixture();
    const first = value.request();
    await value.queue.enqueue(first);
    await value.queue.enqueue(value.request());
    value.queue.claim();
    const recreated = new SqlitePublicationQueue(value.storage, value.runtime, () => Number.MAX_SAFE_INTEGER);
    let calls = 0;
    const runner = new SqlitePublicationAlarm(recreated, {
      async validate() { calls++; }, async publish() { calls++; },
    }, () => {});
    expect(await runner.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_interrupted" });
    expect(await runner.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_interrupted" });
    expect(calls).toBe(0);
    expect(recreated.snapshot()).toMatchObject({ queued: 1, drained: false });
  });

  test("durability confirmation failure starts no IO and retained running is not replayed", async () => {
    const value = fixture();
    await value.queue.enqueue(value.request());
    let calls = 0;
    const runner = new SqlitePublicationAlarm(value.queue, {
      async validate() { calls++; }, async publish() { calls++; },
    }, () => {});
    value.failSync();
    await expect(runner.alarm()).rejects.toThrow("durability");
    expect(calls).toBe(0);
    expect(await runner.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_interrupted" });
    expect(calls).toBe(0);
  });

  test("failed completion persistence never replays the completed publisher", async () => {
    const value = fixture();
    const first = value.request();
    await value.queue.enqueue(first);
    await value.queue.enqueue(value.request());
    let writes = 0;
    const runner = new SqlitePublicationAlarm(value.queue, {
      async validate(request) { return request; },
      async publish() { writes++; value.failAlarm(); },
    }, () => {});
    value.clearAlarm();
    await expect(runner.alarm()).rejects.toThrow("scheduling");
    expect(value.queue.status(first.request_id)?.state).toBe("running");
    expect(await runner.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_interrupted" });
    expect(writes).toBe(1);
    expect(value.queue.snapshot().queued).toBe(1);
  });

  test("pause closes admission while the already accepted job finishes", async () => {
    const value = fixture();
    const request = value.request();
    await value.queue.enqueue(request);
    const entered = deferred();
    const finished = deferred();
    const runner = new SqlitePublicationAlarm(value.queue, {
      async validate(request) { return request; },
      async publish() { entered.resolve(); await finished.promise; },
    }, () => {});
    const execution = runner.alarm();
    await entered.promise;
    expect(value.queue.pause()).toMatchObject({ state: "paused", drained: false });
    await expect(value.queue.enqueue(value.request())).rejects.toThrow("paused");
    finished.resolve();
    expect(await execution).toMatchObject({ state: "succeeded" });
    expect(value.queue.snapshot()).toMatchObject({ state: "paused", drained: true });
  });
});
