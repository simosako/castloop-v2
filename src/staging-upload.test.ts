import { describe, expect, test } from "bun:test";
import { stageUploadRequestSchema } from "../packages/shared/src/index";
import { acquireShowExecution, claimShowOperation, readShowControl } from "./lifecycle-control";
import { beginStageUpload, claimStageUpload, readStageUploadProgress, requireStageUpload, settleStageUpload,
  writeStageUploadProgress } from "./staging-upload";
import { lifecycleFixture } from "./test-support/lifecycle";

async function fixture() {
  const setup = await lifecycleFixture();
  const current = (await readShowControl(setup.env, "daily"))!.value;
  const { owner: _owner, ...withoutOwner } = current;
  await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ ...withoutOwner, generation: 0 }));
  const request = stageUploadRequestSchema.parse({ schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(),
    kind: "show", show_id: "daily", expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z",
    payloads: [{ asset: "show_metadata", length_bytes: 10, sha256: "a".repeat(64) }, { asset: "cover_jpg", length_bytes: 10, sha256: "b".repeat(64) }] });
  return { ...setup, request };
}

describe("M6 staging admission and one-time PUT permission", () => {
  test("staging claims the same Show owner and grants only canonical draft payload keys", async () => {
    const setup = await fixture();
    const operation = await claimStageUpload(setup.env, setup.request);
    expect(operation.operationId).toBe(setup.request.operation_id);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("uploading");
    expect(await beginStageUpload(setup.env, operation)).toEqual([
      { key: `staging/shows/daily/${setup.request.draft_job_id}/show.toml`, length: 10, sha256: "a".repeat(64) },
      { key: `staging/shows/daily/${setup.request.draft_job_id}/cover.jpg`, length: 10, sha256: "b".repeat(64) },
    ]);
    await expect(beginStageUpload(setup.env, operation)).rejects.toThrow("already started");
    await expect(acquireShowExecution(setup.env, "daily", operation.operationId, operation.generation)).rejects.toThrow("staging");
    await expect(claimShowOperation(setup.env, { schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily", kind: "show",
      action: "unpublish", expected_show_generation: 1, created_at: "2026-10-01T12:00:00Z" })).rejects.toThrow("unfinished");
  });

  test("concurrent begin calls have exactly one PUT permission winner", async () => {
    const setup = await fixture();
    const operation = await claimStageUpload(setup.env, setup.request);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => beginStageUpload(setup.env, operation)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(11);
  });

  test("same manifest claim is idempotent; reusing an operation ID for different bytes is rejected", async () => {
    const setup = await fixture();
    const operation = await claimStageUpload(setup.env, setup.request);
    expect(await claimStageUpload(setup.env, setup.request)).toEqual(operation);
    await expect(claimStageUpload(setup.env, { ...setup.request, payloads: setup.request.payloads.map((payload) =>
      ({ ...payload, sha256: "c".repeat(64) })) })).rejects.toThrow("different staging manifest");
    expect((await requireStageUpload(setup.env, operation)).request).toEqual(setup.request);
  });

  test("published drafts and stopped Shows never receive staging PUT permission", async () => {
    const setup = await fixture();
    await setup.bucket.put(`staging/shows/daily/${setup.request.draft_job_id}/commit.json`, "{}");
    await expect(claimStageUpload(setup.env, setup.request)).rejects.toThrow("Committed");
    const other = await fixture();
    await other.bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
      lifecycle: "unpublished", generation: 0, feed_generation: 0 }));
    await expect(claimStageUpload(other.env, other.request)).rejects.toThrow("does not permit");
    expect((await readShowControl(other.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("settlement requires explicit confirmation, cannot reopen PUT permission, and does not release admission", async () => {
    const setup = await fixture();
    const operation = await claimStageUpload(setup.env, setup.request);
    await beginStageUpload(setup.env, operation);
    await expect(settleStageUpload(setup.env, operation, { put_requests_settled: false, no_more_puts: true } as never)).rejects.toThrow("explicitly confirmed");
    await settleStageUpload(setup.env, operation, { put_requests_settled: true, no_more_puts: true });
    const snapshot = await requireStageUpload(setup.env, operation);
    const progress = (await readStageUploadProgress(setup.env, operation, snapshot))!.value;
    expect(progress.phase).toBe("settled");
    expect(snapshot.control.value.owner.state).toBe("uploading");
    await expect(writeStageUploadProgress(setup.env, operation, { ...progress, phase: "ready", client_settled: false })).rejects.toThrow("reopen");
    await expect(beginStageUpload(setup.env, operation)).rejects.toThrow("already started");
  });

  test("lost begin response does not grant another PUT; lost settlement recovers from remote progress", async () => {
    for (const phase of ["uploading", "settled"] as const) {
      const setup = await fixture();
      const operation = await claimStageUpload(setup.env, setup.request);
      let lose = true;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        const written = await setup.bucket.put(...args);
        if (lose && written && args[0].endsWith("upload-progress.json") && JSON.parse(args[1]).phase === phase) {
          lose = false;
          throw new Error("Staging response lost");
        }
        return written;
      } } } as never;
      if (phase === "uploading") {
        await expect(beginStageUpload(env, operation)).rejects.toThrow("response lost");
        await expect(beginStageUpload(env, operation)).rejects.toThrow("already started");
      } else {
        await beginStageUpload(env, operation);
        await expect(settleStageUpload(env, operation, { put_requests_settled: true, no_more_puts: true })).rejects.toThrow("response lost");
        await settleStageUpload(env, operation, { put_requests_settled: true, no_more_puts: true });
      }
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(operation.operationId);
    }
  });
});
