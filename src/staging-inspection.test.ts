import { expect, test } from "bun:test";
import { stageUploadRequestSchema, stringifyToml } from "../packages/shared/src/index";
import { readShowControl } from "./lifecycle-control";
import { SERVICE_ADMISSION_KEY } from "./service-admission";
import { acquireStageVerification } from "./staging-verification";
import { stagingAdminFixture } from "./test-support/staging-admin";

test("staging status observes ready/uploading/settled/finished without writes or PUT authorization", async () => {
  const setup = await stagingAdminFixture("audio");
  const status = () => setup.success(setup.input("status", { upload: setup.upload }));
  await setup.success(setup.input("claim", { upload: setup.upload }));
  for (const phase of ["ready", "uploading", "settled", "finished"] as const) {
    if (phase === "uploading") await setup.success(setup.input("begin", { operation: setup.operation }));
    if (phase === "settled") {
      await setup.putPayloads();
      await setup.success(setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true, readback_receipts: setup.readbacks() }));
    }
    if (phase === "finished") await setup.success(setup.input("finish", { operation: setup.operation, outcome: "staged" }));
    const writes = setup.writes.length;
    const bodyReads = setup.bodyReads.length;
    const value = await status();
    if (value.result !== "status") throw new Error("Expected staging status");
    expect(value.progress?.phase).toBe(phase);
    expect(value.ownership).toBe(phase === "finished" ? "released" : "held");
    expect(value.authorizes_put).toBe(false);
    expect(value.authorizes_recovery).toBe(false);
    expect(value.verification_active).toBe(false);
    expect(setup.writes.length).toBe(writes);
    expect(setup.bodyReads.slice(bodyReads).some((key) => key.startsWith("staging/"))).toBe(false);
  }
});

test("partial claim manifest can be inspected but cannot authorize a PUT or adopt another request", async () => {
  const setup = await stagingAdminFixture();
  await setup.bucket.put(`system/jobs/${setup.upload.operation_id}/upload.json`, JSON.stringify(setup.upload));
  const value = await setup.success(setup.input("status", { upload: setup.upload }));
  if (value.result !== "status") throw new Error("Expected staging status");
  expect(value.ownership).toBe("unclaimed");
  expect(value.progress).toBeNull();
  expect(value.status).toBeNull();
  const changed = { ...setup.upload, draft_job_id: crypto.randomUUID() };
  expect((await setup.call(setup.input("status", { upload: changed }))).status).toBe(409);
});

test("paused service and retained verification tokens can be observed without releasing them", async () => {
  const setup = await stagingAdminFixture();
  await setup.success(setup.input("claim", { upload: setup.upload }));
  await setup.success(setup.input("settle", { operation: setup.operation, put_requests_settled: true, no_more_puts: true, readback_receipts: [] }));
  const token = await acquireStageVerification(setup.env, { showId: "daily", operationId: setup.upload.operation_id, generation: setup.operation.show_generation });
  await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...setup.service, state: "paused", pause_id: crypto.randomUUID(),
    invocations: [{ token: crypto.randomUUID(), kind: "m6_recovery" }] }));
  const writes = setup.writes.length;
  const service = setup.text(SERVICE_ADMISSION_KEY);
  const value = await setup.success(setup.input("status", { upload: setup.upload }));
  if (value.result !== "status") throw new Error("Expected staging status");
  expect(value.verification_active).toBe(true);
  expect(value.authorizes_recovery).toBe(false);
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.verification_id).toBe(token.verificationId);
  expect(setup.writes.length).toBe(writes);
  expect(setup.text(SERVICE_ADMISSION_KEY)).toBe(service);
});

test("archived staging status remains available after newer uploads replace its completion receipt", async () => {
  const setup = await stagingAdminFixture();
  const stage = async (upload: typeof setup.upload) => {
    const operation = { show_id: upload.show_id, operation_id: upload.operation_id, show_generation: upload.expected_show_generation + 1 };
    await setup.success(setup.input("claim", { upload }));
    await setup.success(setup.input("begin", { operation }));
    await setup.success(setup.input("settle", { operation, put_requests_settled: true, no_more_puts: true, readback_receipts: [] }));
    await setup.success(setup.input("finish", { operation, outcome: "aborted" }));
  };
  await stage(setup.upload);
  const next = stageUploadRequestSchema.parse({ ...setup.upload, operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(),
    expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation });
  await stage(next);
  const value = await setup.success(setup.input("status", { upload: setup.upload }));
  if (value.result !== "status") throw new Error("Expected staging status");
  expect(value.ownership).toBe("superseded");
  expect(value.status?.state).toBe("completed");
  expect(value.progress?.outcome).toBe("aborted");
});

test("status rejects oversized/secret/foreign progress, status and missing frozen request", async () => {
  const setup = await stagingAdminFixture();
  await setup.success(setup.input("claim", { upload: setup.upload }));
  const key = `system/jobs/${setup.upload.operation_id}/upload-progress.json`;
  const original = setup.text(key);
  for (const text of [" ".repeat(16385), JSON.stringify({ ...JSON.parse(original), secret: "private-secret" }),
    JSON.stringify({ ...JSON.parse(original), manifest_sha256: "0".repeat(64) }),
    JSON.stringify({ ...JSON.parse(original), show_generation: setup.operation.show_generation + 1 })]) {
    await setup.bucket.put(key, text);
    const response = await setup.call(setup.input("status", { upload: setup.upload }));
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("private-secret");
  }
  await setup.bucket.put(key, original);
  const statusKey = `system/jobs/${setup.upload.operation_id}/status.toml`;
  await setup.bucket.put(statusKey, stringifyToml({ schema_version: 2, job_id: setup.upload.operation_id, show_id: "daily", kind: "show",
    action: "stage", show_generation: setup.operation.show_generation, request_sha256: "0".repeat(64), state: "processing", phase: "validating" }));
  expect((await setup.call(setup.input("status", { upload: setup.upload }))).status).toBe(409);
  await setup.bucket.delete(statusKey);
  await setup.bucket.delete(`system/jobs/${setup.upload.operation_id}/request.toml`);
  expect((await setup.call(setup.input("status", { upload: setup.upload }))).status).toBe(409);
});

test("status fails closed when records or draft marker change during inspection", async () => {
  for (const markerChanged of [false, true]) {
    const setup = await stagingAdminFixture();
    await setup.success(setup.input("claim", { upload: setup.upload }));
    const key = markerChanged ? `staging/shows/daily/${setup.upload.draft_job_id}/commit.json` :
      `system/jobs/${setup.upload.operation_id}/upload-progress.json`;
    const head = setup.bucket.head.bind(setup.bucket);
    let reads = 0;
    setup.bucket.head = async (name) => {
      if (name === key && ++reads === (markerChanged ? 2 : 1)) await setup.bucket.put(key, markerChanged ? "{}" : setup.text(key));
      return head(name);
    };
    expect((await setup.call(setup.input("status", { upload: setup.upload }))).status).toBe(409);
  }
});
