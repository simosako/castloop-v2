import { describe, expect, test } from "bun:test";
import { lifecycleCommitKey } from "../packages/shared/src/index";
import { parseQueueDelivery, recordDeadLetterDelivery } from "./queue-delivery";
import { lifecycleFixture } from "./test-support/lifecycle";
import worker from "./index";

describe("publication/lifecycle Queue delivery boundary", () => {
  test("legacy publications and lifecycle commits are recognized without copying notification payloads", () => {
    for (const kind of ["show", "episode"] as const) {
      const target = { kind, show_id: "daily", job_id: crypto.randomUUID(), ...(kind === "episode" ? { episode_id: "first" } : {}) };
      const legacy = kind === "show" ? `staging/shows/daily/${target.job_id}/commit.json` :
        `staging/episodes/daily/first/${target.job_id}/commit.json`;
      for (const [family, key] of [["publication", legacy], ["lifecycle", lifecycleCommitKey(target)]] as const) {
        expect(parseQueueDelivery({ object: { key, title: "Private title" }, token: "secret", action: "PutObject" }))
          .toEqual({ family, key, target });
      }
    }
  });

  test("malformed notifications and paths cannot supply a job storage key", () => {
    const jobId = crypto.randomUUID();
    for (const body of [null, "text", [], { object: null }, { object: { key: 7 } }, { key: "commit.json" },
      ...[`staging/shows/../${jobId}/commit.json`, `staging/shows/daily/not-a-job/commit.json`,
        `staging/episodes/daily/first/${jobId}/extra/commit.json`, `system/jobs/${jobId}/commit.json`,
        `staging/shows/daily/${jobId}/commit.json/`, "secret".repeat(1000)].map((key) => ({ object: { key } }))]) {
      expect(parseQueueDelivery(body)).toBeNull();
    }
  });

  test("matched DLQ records keep only canonical keys and preserve the existing retry marker shape", async () => {
    const setup = await lifecycleFixture();
    const key = lifecycleCommitKey({ kind: "show", show_id: "daily", job_id: setup.jobId });
    const message = { id: crypto.randomUUID(), body: { object: { key }, title: "Private title", token: "Bearer secret" } };
    await recordDeadLetterDelivery(setup.env, message);
    expect(JSON.parse(setup.entries.get(`system/jobs/${setup.jobId}/dlq.json`)!.data)).toEqual({ key });
    const count = setup.writes.length;
    await recordDeadLetterDelivery(setup.env, message);
    expect(setup.writes).toHaveLength(count);
    expect([...setup.entries.values()].some((entry) => entry.data.includes("Bearer secret"))).toBe(false);
  });

  test("unmatched bodies and invalid paths are replaced by fixed diagnostics, not retained verbatim", async () => {
    const setup = await lifecycleFixture();
    const id = crypto.randomUUID();
    await recordDeadLetterDelivery(setup.env, { id, body: { object: { key: "Private title owner@example.com" }, token: "Bearer secret" } });
    expect(JSON.parse(setup.entries.get(`system/dlq/unmatched/${id}.json`)!.data))
      .toEqual({ schema_version: 1, reason_code: "unmatched_queue_delivery" });
    await expect(recordDeadLetterDelivery(setup.env, { id: "../other", body: {} })).rejects.toThrow("identifier");
  });

  test("a conflicting retained marker is never silently overwritten", async () => {
    const setup = await lifecycleFixture();
    const other = `staging/shows/other/${setup.jobId}/commit.json`;
    const stored = JSON.stringify({ key: other });
    await setup.bucket.put(`system/jobs/${setup.jobId}/dlq.json`, stored);
    const key = `staging/shows/daily/${setup.jobId}/commit.json`;
    await expect(recordDeadLetterDelivery(setup.env, { id: crypto.randomUUID(), body: { object: { key } } }))
      .rejects.toThrow("different delivery");
    expect(setup.entries.get(`system/jobs/${setup.jobId}/dlq.json`)!.data).toBe(stored);
  });

  test("the live DLQ handler uses sanitized markers but does not change job status or admission", async () => {
    const setup = await lifecycleFixture();
    const key = `staging/shows/daily/${setup.jobId}/commit.json`;
    const before = setup.entries.get("system/show-publications/daily.json");
    const unmatchedId = crypto.randomUUID();
    await worker.queue({ queue: "test-dlq", messages: [
      { id: crypto.randomUUID(), body: { object: { key }, secret: "confidential-token" } },
      { id: unmatchedId, body: { title: "Private title", email: "private@example.com" } },
    ] } as never, { CASTLOOP_BUCKET: setup.bucket, CASTLOOP_DLQ_NAME: "test-dlq" } as never, {} as never);
    expect(setup.entries.get("system/show-publications/daily.json")).toEqual(before);
    expect(setup.entries.has(`system/jobs/${setup.jobId}/status.toml`)).toBe(false);
    expect(JSON.parse(setup.entries.get(`system/jobs/${setup.jobId}/dlq.json`)!.data)).toEqual({ key });
    expect(JSON.parse(setup.entries.get(`system/dlq/unmatched/${unmatchedId}.json`)!.data).reason_code).toBe("unmatched_queue_delivery");
  });

  test("the current live Queue handler does not expose lifecycle execution before integration gates", async () => {
    const setup = await lifecycleFixture();
    const key = lifecycleCommitKey({ kind: "show", show_id: "daily", job_id: setup.jobId });
    const before = new Map(setup.entries);
    await worker.queue({ queue: "test-queue", messages: [{ id: crypto.randomUUID(), body: { object: { key } } }] } as never,
      { CASTLOOP_BUCKET: setup.bucket, CASTLOOP_DLQ_NAME: "test-dlq" } as never, {} as never);
    expect(setup.entries).toEqual(before);
  });
});
