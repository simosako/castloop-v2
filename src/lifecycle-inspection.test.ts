import { describe, expect, test } from "bun:test";
import { lifecycleAdminResponseSchema, lifecycleCommitKey, parseJobStatus, stringifyToml } from "../packages/shared/src/index";
import { readEpisodeLifecycle, readShowControl } from "./lifecycle-control";
import { pauseServiceAdmission, readServiceAdmission } from "./service-admission";
import { lifecycleAdminFixture } from "./test-support/lifecycle-admin";

describe("read-only lifecycle inspection and explicit same-job retry", () => {
  test("reserved/committed/completed inspection never writes or authorizes retry", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("episode", "unpublish");
    await setup.success(await setup.body("claim", request));
    const before = new Map(setup.entries);
    const reserved = await setup.success(await setup.body("status", request));
    if (reserved.result !== "status") throw new Error("Expected inspection");
    expect(reserved.status).toBeNull();
    expect(reserved.progress).toBeNull();
    expect(reserved.ownership).toBe("held");
    expect(reserved.marker_present).toBe(false);
    expect(reserved.execution_active).toBe(false);
    expect(reserved.authorizes_retry).toBe(false);
    expect(setup.entries).toEqual(before);
    const committed = await setup.success(await setup.body("commit", request));
    if (committed.result !== "committed") throw new Error("Expected marker");
    const marked = await setup.success(await setup.body("status", request));
    if (marked.result !== "status") throw new Error("Expected inspection");
    expect(marked.marker_present).toBe(true);
    expect(marked.status).toBeNull();
    await setup.consume(committed.key);
    const completedBefore = new Map(setup.entries);
    const completed = await setup.success(await setup.body("status", request));
    if (completed.result !== "status") throw new Error("Expected inspection");
    expect(completed.status?.state).toBe("completed");
    expect(completed.progress?.phase).toBe("finished");
    expect(completed.progress?.purge_confirmed).toBe(true);
    expect(completed.ownership).toBe("released");
    expect(completed.authorizes_retry).toBe(false);
    expect(setup.entries).toEqual(completedBefore);
  });

  test("older completed status remains inspectable after restoration without treating old results as current state", async () => {
    const setup = await lifecycleAdminFixture();
    const stop = await setup.operationRequest("episode", "unpublish");
    await setup.execute(stop);
    await setup.execute(await setup.operationRequest("episode", "restore"));
    const result = await setup.success(await setup.body("status", stop));
    if (result.result !== "status") throw new Error("Expected inspection");
    expect(result.status?.result_lifecycle).toBe("unpublished");
    expect(result.ownership).toBe("superseded");
    expect((await readEpisodeLifecycle(setup.env, "daily", "next"))?.lifecycle).toBe("active");
    expect((await setup.call(await setup.body("retry", stop))).status).toBe(409);
    expect(setup.continuations).toEqual([]);
  });

  test("live consumer token is observable but cannot be requeued, expired or released by inspection", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("episode", "unpublish");
    await setup.success(await setup.body("claim", request));
    const marker = await setup.success(await setup.body("commit", request));
    if (marker.result !== "committed") throw new Error("Expected marker");
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const invalidate = setup.cachedAssets.invalidate;
    setup.cachedAssets.invalidate = async (target) => { started.resolve(); await ended.promise; return invalidate(target); };
    const pending = setup.consume(marker.key);
    await started.promise;
    const before = new Map(setup.entries);
    const active = await setup.success(await setup.body("status", request));
    if (active.result !== "status") throw new Error("Expected inspection");
    expect(active.execution_active).toBe(true);
    expect(active.ownership).toBe("held");
    expect(active.authorizes_retry).toBe(false);
    expect(setup.entries).toEqual(before);
    const token = (await readShowControl(setup.env, "daily"))?.value.owner?.execution_id;
    expect((await setup.call(await setup.body("retry", request))).status).toBe(409);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBe(token);
    expect(setup.continuations).toEqual([]);
    ended.resolve();
    await pending;
  });

  test("purge failure can be explicitly requeued under pause using the same job and unchanged commit", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("episode", "unpublish");
    await setup.success(await setup.body("claim", request));
    const marker = await setup.success(await setup.body("commit", request));
    if (marker.result !== "committed") throw new Error("Expected marker");
    const etag = setup.entries.get(marker.key)!.etag;
    const invalidate = setup.cachedAssets.invalidate;
    setup.cachedAssets.invalidate = async () => { throw new Error("Private cache failure"); };
    await expect(setup.consume(marker.key)).rejects.toThrow("Private cache failure");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    const inspected = await setup.success(await setup.body("status", request));
    if (inspected.result !== "status") throw new Error("Expected inspection");
    expect(inspected.status?.state).toBe("retrying");
    expect(inspected.status?.reason_code).toBe("cache_purge_failed");
    expect(JSON.stringify(inspected)).not.toContain("Private cache failure");
    const pauseId = crypto.randomUUID();
    await pauseServiceAdmission(setup.env, "service", pauseId);
    const requeued = await setup.success(await setup.body("retry", request));
    if (requeued.result !== "requeued") throw new Error("Expected same-job enqueue receipt");
    expect(requeued.operation.job_id).toBe(request.job_id);
    expect(requeued.operation.show_generation).toBe(request.expected_show_generation + 1);
    expect(requeued.key).toBe(marker.key);
    expect(setup.continuations).toEqual([marker.key]);
    expect(setup.entries.get(marker.key)!.etag).toBe(etag);
    setup.cachedAssets.invalidate = invalidate;
    await setup.consume(setup.continuations.pop()!);
    expect(parseJobStatus(setup.text(`system/jobs/${request.job_id}/status.toml`)).state).toBe("completed");
    expect((await readServiceAdmission(setup.env, "service"))?.value.pause_id).toBe(pauseId);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("missing marker, completed owner and changed request cannot be requeued or replace a job", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("show", "unpublish");
    await setup.success(await setup.body("claim", request));
    expect((await setup.call(await setup.body("retry", request))).status).toBe(409);
    const marked = await setup.success(await setup.body("commit", request));
    if (marked.result !== "committed") throw new Error("Expected marker");
    const altered = { ...request, created_at: "2026-10-02T13:00:00Z" };
    expect((await setup.call(await setup.body("retry", altered))).status).toBe(409);
    expect((await setup.call(await setup.body("status", altered))).status).toBe(409);
    expect(setup.continuations).toEqual([]);
    await setup.consume(marked.key);
    expect((await setup.call(await setup.body("retry", request))).status).toBe(409);
  });

  test("unknown Queue send outcome keeps ownership and marker and never automatically resends", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("show", "delete");
    await setup.success(await setup.body("claim", request));
    const marked = await setup.success(await setup.body("commit", request));
    if (marked.result !== "committed") throw new Error("Expected marker");
    const send = setup.env.CASTLOOP_QUEUE.send.bind(setup.env.CASTLOOP_QUEUE);
    let sends = 0;
    setup.env.CASTLOOP_QUEUE.send = async (body, options) => {
      await send(body, options);
      sends += 1;
      throw new Error("Private Queue result lost");
    };
    const etag = setup.entries.get(marked.key)!.etag;
    const result = await setup.call(await setup.body("retry", request));
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain("Private Queue result");
    expect(sends).toBe(1);
    expect(setup.continuations).toEqual([marked.key]);
    expect(setup.entries.get(marked.key)!.etag).toBe(etag);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
    setup.env.CASTLOOP_QUEUE.send = send;
  });

  test("foreign, malformed, oversized and arbitrary-diagnostic records fail inspection without being rewritten", async () => {
    for (const change of ["hash", "body", "size", "diagnostic", "missing-progress"] as const) {
      const setup = await lifecycleAdminFixture();
      const request = await setup.operationRequest("show", "unpublish");
      await setup.execute(request);
      const key = `system/jobs/${request.job_id}/status.toml`;
      const status = parseJobStatus(setup.text(key));
      if (status.schema_version !== 2) throw new Error("Expected lifecycle status");
      if (change === "hash") await setup.bucket.put(key, stringifyToml({ ...status, request_sha256: "f".repeat(64) }));
      if (change === "body") await setup.bucket.put(key, "Private invalid status");
      if (change === "size") await setup.bucket.put(key, "x".repeat(16385));
      if (change === "diagnostic") await setup.bucket.put(key, `${setup.text(key)}\nsecret = 'private-secret'\n`);
      if (change === "missing-progress") setup.entries.delete(`system/jobs/${request.job_id}/progress.toml`);
      const before = new Map(setup.entries);
      const result = await setup.call(await setup.body("status", request));
      expect(result.status).toBe(409);
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(await result.text()).not.toContain("Private invalid");
      expect(setup.entries).toEqual(before);
    }
  });

  test("inspection refuses a record changing mid-read rather than promoting a mixed snapshot", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("show", "unpublish");
    await setup.execute(request);
    const statusKey = `system/jobs/${request.job_id}/status.toml`;
    const head = setup.env.CASTLOOP_BUCKET.head.bind(setup.env.CASTLOOP_BUCKET);
    setup.env.CASTLOOP_BUCKET.head = (async (key: string) => {
      if (key === statusKey) await setup.bucket.put(statusKey, setup.text(statusKey));
      return head(key);
    }) as typeof setup.env.CASTLOOP_BUCKET.head;
    expect((await setup.call(await setup.body("status", request))).status).toBe(409);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("retry receipts do not claim commit creation/completion or authorize subsequent retry", async () => {
    const setup = await lifecycleAdminFixture();
    const request = await setup.operationRequest("show", "unpublish");
    await setup.success(await setup.body("claim", request));
    const marked = await setup.success(await setup.body("commit", request));
    if (marked.result !== "committed") throw new Error("Expected marker");
    const result = await setup.success(await setup.body("retry", request));
    expect(result.result).toBe("requeued");
    expect(lifecycleAdminResponseSchema.safeParse({ ...result, created: true }).success).toBe(false);
    expect(lifecycleAdminResponseSchema.safeParse({ ...result, result: "completed" }).success).toBe(false);
    const inspection = await setup.success(await setup.body("status", request));
    expect(lifecycleAdminResponseSchema.safeParse({ ...inspection, authorizes_retry: true }).success).toBe(false);
    expect(lifecycleCommitKey({ kind: request.kind, show_id: request.show_id, job_id: request.job_id })).toBe(marked.key);
  });
});
