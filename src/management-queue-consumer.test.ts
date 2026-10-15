import { expect, spyOn, test } from "bun:test";
import { managementRequestPrefix, parseEpisodeLifecycle, parseJobStatus, publicationCommitKey, signManagementIntent,
  stagePayloadKey, stringifyLifecycleToml, verifyManagementResult } from "../packages/shared/src/index";
import type { ManagementIntent } from "../packages/shared/src/index";
import { acquireShowExecution, readShowControl } from "./lifecycle-control";
import { readManagementResult } from "./management-request-store";
import { beginStageUpload } from "./staging-upload";
import { acquireServiceInvocation, pauseServiceAdmission, readServiceAdmission, releaseServiceInvocation, resumeServiceAdmission } from "./service-admission";
import { claimPublicationOperation } from "./publication-admission";
import { asyncManagementFixture } from "./test-support/async-management";

async function result(setup: Awaited<ReturnType<typeof asyncManagementFixture>>, intent: ManagementIntent) {
  return (await readManagementResult(setup.env, intent, "private-secret"))!;
}

test("Queue owns upload grant IO, staging completes without publishing and duplicates cannot regrant PUTs", async () => {
  const setup = await asyncManagementFixture();
  const start = await setup.intent({ action: "stage-start", upload: setup.upload });
  const put = setup.bucket.put.bind(setup.bucket);
  let grantExecution: string | undefined;
  const probe = spyOn(setup.bucket, "put").mockImplementation(async (key, body, options) => {
    if (key === `${managementRequestPrefix(start.request_id)}/result.json` && String(body).includes('"granted"')) {
      grantExecution = (await readShowControl(setup.env, "daily"))!.value.owner?.command_execution_id;
      expect(grantExecution).toBeTruthy();
    }
    return put(key, body, options);
  });
  try { await setup.deliver(start); } finally { probe.mockRestore(); }
  const grant = await result(setup, start);
  expect(grant.state).toBe("granted");
  const control = (await readShowControl(setup.env, "daily"))!.value;
  expect(control.owner?.command_execution_id).toBeUndefined();
  expect(control.owner?.state).toBe("uploading");
  const generation = control.generation;
  await setup.deliver(start);
  expect((await readShowControl(setup.env, "daily"))!.value.generation).toBe(generation);
  const conflicting = await setup.intent({ action: "stage-start", upload: setup.upload });
  await setup.deliver(conflicting);
  expect((await result(setup, conflicting)).state).toBe("rejected");
  await setup.putPayloads();
  const complete = await setup.intent({ action: "upload-complete", upload: setup.upload, grant_request_id: start.request_id,
    outcome: "staged", settlement: { put_requests_settled: true, no_more_puts: true, readback_receipts: setup.readbacks() } });
  const beforeFeed = setup.text("public/podcasts/daily/feed.xml");
  await setup.deliver(complete);
  expect((await result(setup, complete)).state).toBe("staged");
  expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
  expect(setup.text("public/podcasts/daily/feed.xml")).toBe(beforeFeed);
  expect(await setup.bucket.head(`staging/shows/daily/${setup.upload.draft_job_id}/commit.json`)).toBeNull();
  await setup.deliver(complete);
  expect((await result(setup, complete)).state).toBe("staged");
});

for (const mode of ["show", "episode", "metadata", "audio"] as const) {
  test(`async ${mode} publication claims in Queue, purges, releases and duplicate/native delivery preserves immutable writes`, async () => {
    const setup = await asyncManagementFixture(mode);
    if (!("frozen" in setup)) throw new Error("Expected publication fixture");
    const intent = await setup.intent({ action: "publish", publication: setup.frozen });
    await setup.deliver(intent);
    expect((await result(setup, intent)).state).toBe("published");
    expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
    expect(parseJobStatus(setup.text(`system/jobs/${setup.frozen.request.job_id}/status.toml`)).state).toBe("published");
    const writes = setup.writes.filter((key) => key.startsWith("public/"));
    await setup.deliver(intent);
    await setup.deliver({ object: { key: publicationCommitKey(setup.frozen.commit) } });
    expect(setup.writes.filter((key) => key.startsWith("public/"))).toEqual(writes);
  });
}

test("paused admission rejects unclaimed commands but drains an exact existing grant", async () => {
  const setup = await asyncManagementFixture();
  const start = await setup.intent({ action: "stage-start", upload: setup.upload });
  await setup.deliver(start);
  await pauseServiceAdmission(setup.env, setup.config.service_id, crypto.randomUUID());
  const unclaimed = await setup.intent({ action: "stage-start", upload: { ...setup.upload, operation_id: crypto.randomUUID() } });
  await setup.deliver(unclaimed);
  expect((await result(setup, unclaimed)).state).toBe("rejected");
  await setup.putPayloads();
  const complete = await setup.intent({ action: "upload-complete", upload: setup.upload, grant_request_id: start.request_id,
    outcome: "staged", settlement: { put_requests_settled: true, no_more_puts: true, readback_receipts: setup.readbacks() } });
  await setup.deliver(complete);
  expect((await result(setup, complete)).state).toBe("staged");
});

test("retained grant execution blocks HTTP, duplicates and completion without expiring or releasing it", async () => {
  const setup = await asyncManagementFixture();
  const start = await setup.intent({ action: "stage-start", upload: setup.upload });
  await setup.deliver(start);
  const current = (await readShowControl(setup.env, "daily"))!.value;
  const token = crypto.randomUUID();
  await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ ...current, owner: { ...current.owner, command_execution_id: token } }));
  await expect(beginStageUpload(setup.env, { showId: "daily", operationId: setup.upload.operation_id, generation: current.generation })).rejects.toThrow("still executing");
  await setup.putPayloads();
  const complete = await setup.intent({ action: "upload-complete", upload: setup.upload, grant_request_id: start.request_id,
    outcome: "staged", settlement: { put_requests_settled: true, no_more_puts: true, readback_receipts: setup.readbacks() } });
  await expect(setup.deliver(complete)).rejects.toThrow("execution");
  await setup.deliver(complete, true);
  expect((await result(setup, complete)).state).toBe("blocked");
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.command_execution_id).toBe(token);
});

test("wrong MAC, stale window/runtime and changed request IDs cannot authorize IO", async () => {
  const setup = await asyncManagementFixture();
  const start = await setup.intent({ action: "stage-start", upload: setup.upload });
  const writes = setup.writes.length;
  await setup.deliver({ ...start, mac: "0".repeat(64) });
  expect(setup.writes.length).toBe(writes);
  const { mac: _mac, ...payload } = start;
  const stale = await signManagementIntent({ ...payload, admission_window_id: crypto.randomUUID() }, "private-secret");
  await setup.deliver(stale);
  expect((await result(setup, stale)).reason_code).toBe("stale_window");
  const wrongRuntime = await signManagementIntent({ ...payload, request_id: crypto.randomUUID(), worker_version_id: crypto.randomUUID() }, "private-secret");
  await setup.deliver(wrongRuntime);
  expect((await result(setup, wrongRuntime)).reason_code).toBe("runtime_mismatch");
  expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
  await setup.deliver(start);
  expect((await result(setup, stale)).state).toBe("rejected");
  await expect(verifyManagementResult(await result(setup, stale), start, "private-secret")).rejects.toThrow();
  expect(await setup.bucket.head(stagePayloadKey(setup.upload, "show_metadata"))).toBeNull();
});

test("service token generation is not the admission window, but resume rejects an old queued request", async () => {
  const setup = await asyncManagementFixture();
  const start = await setup.intent({ action: "stage-start", upload: setup.upload });
  const token = await acquireServiceInvocation(setup.env, setup.config.service_id, "m6_admin");
  await releaseServiceInvocation(setup.env, token);
  expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.generation).toBe(2);
  await setup.deliver(start);
  expect((await result(setup, start)).state).toBe("granted");
  const other = await asyncManagementFixture();
  const delayed = await other.intent({ action: "stage-start", upload: other.upload });
  const pauseId = crypto.randomUUID();
  await pauseServiceAdmission(other.env, other.config.service_id, pauseId);
  await resumeServiceAdmission(other.env, other.config.service_id, pauseId);
  await other.deliver(delayed);
  expect((await result(other, delayed)).reason_code).toBe("stale_window");
  expect((await readShowControl(other.env, "daily"))!.value.owner).toBeUndefined();
});

test("retained publication execution is never stolen by Queue retries or DLQ", async () => {
  const setup = await asyncManagementFixture("show");
  const intent = await setup.intent({ action: "publish", publication: setup.frozen });
  const operation = await claimPublicationOperation(setup.env, setup.frozen);
  const execution = await acquireShowExecution(setup.env, operation.showId, operation.jobId, operation.generation);
  const before = setup.writes.filter((key) => key.startsWith("public/"));
  await expect(setup.deliver(intent)).rejects.toThrow("execution");
  await setup.deliver(intent, true);
  await setup.deliver(intent);
  expect((await result(setup, intent)).state).toBe("blocked");
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBe(execution.executionId);
  expect(setup.writes.filter((key) => key.startsWith("public/"))).toEqual(before);
});

test("deterministic publication validation failure remains held and cannot publish on duplicates", async () => {
  const setup = await asyncManagementFixture("show");
  const intent = await setup.intent({ action: "publish", publication: setup.frozen });
  await setup.bucket.delete(`staging/shows/daily/${setup.frozen.request.job_id}/cover.jpg`);
  const before = setup.writes.filter((key) => key.startsWith("public/"));
  await setup.deliver(intent);
  expect((await result(setup, intent))).toMatchObject({ state: "failed", reason_code: "validation_failed" });
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.job_id).toBe(setup.frozen.request.job_id);
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBeUndefined();
  await setup.deliver(intent);
  await setup.deliver({ object: { key: publicationCommitKey(setup.frozen.commit) } });
  expect(setup.writes.filter((key) => key.startsWith("public/"))).toEqual(before);
});

test("lost terminal result is reconciled from exact completion evidence without public writes", async () => {
  const setup = await asyncManagementFixture("episode");
  const intent = await setup.intent({ action: "publish", publication: setup.frozen });
  const put = setup.bucket.put.bind(setup.bucket);
  let lost = true;
  const probe = spyOn(setup.bucket, "put").mockImplementation(async (key, body, options) => {
    if (lost && key === `${managementRequestPrefix(intent.request_id)}/result.json` && String(body).includes('"published"')) {
      lost = false;
      throw new Error("Simulated terminal result failure");
    }
    return put(key, body, options);
  });
  try { await expect(setup.deliver(intent)).rejects.toThrow("terminal result failure"); } finally { probe.mockRestore(); }
  const before = setup.writes.filter((key) => key.startsWith("public/"));
  expect((await result(setup, intent)).state).toBe("pending");
  await setup.deliver(intent);
  expect((await result(setup, intent)).state).toBe("published");
  expect(setup.writes.filter((key) => key.startsWith("public/"))).toEqual(before);
});

test("grant writes keep own Show/service tokens until IO settles; a concurrent duplicate cannot run", async () => {
  const setup = await asyncManagementFixture();
  const start = await setup.intent({ action: "stage-start", upload: setup.upload });
  const put = setup.bucket.put.bind(setup.bucket);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const probe = spyOn(setup.bucket, "put").mockImplementation(async (key, body, options) => {
    if (key === `${managementRequestPrefix(start.request_id)}/result.json` && String(body).includes('"granted"')) {
      entered();
      await waiting;
    }
    return put(key, body, options);
  });
  const first = setup.deliver(start);
  try {
    await started;
    const token = (await readShowControl(setup.env, "daily"))!.value.owner?.command_execution_id;
    expect(token).toBeTruthy();
    await expect(setup.deliver(start)).rejects.toThrow("execution");
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.command_execution_id).toBe(token);
    expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.invocations).toHaveLength(1);
    release();
    await first;
    expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.invocations).toHaveLength(0);
  } finally { release(); await first; probe.mockRestore(); }
});

test("failed grant recording resumes the same grant identity without a second PUT start", async () => {
  const setup = await asyncManagementFixture();
  const start = await setup.intent({ action: "stage-start", upload: setup.upload });
  const put = setup.bucket.put.bind(setup.bucket);
  const probe = spyOn(setup.bucket, "put").mockImplementation(async (key, body, options) => {
    if (key === `${managementRequestPrefix(start.request_id)}/result.json` && String(body).includes('"granted"')) throw new Error("Grant result failed");
    return put(key, body, options);
  });
  try { await expect(setup.deliver(start)).rejects.toThrow("Grant result failed"); } finally { probe.mockRestore(); }
  const progressKey = `system/jobs/${setup.upload.operation_id}/upload-progress.json`;
  const before = setup.text(progressKey);
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.command_execution_id).toBeUndefined();
  await setup.deliver(start);
  expect((await result(setup, start)).state).toBe("granted");
  expect(setup.text(progressKey)).toBe(before);
});

test("changed Episode generation is rejected before publication claim rather than silently rebased", async () => {
  const setup = await asyncManagementFixture("metadata");
  const intent = await setup.intent({ action: "publish", publication: setup.frozen });
  const key = "system/episode-lifecycle/daily/next.toml";
  const episode = parseEpisodeLifecycle(setup.text(key));
  await setup.bucket.put(key, stringifyLifecycleToml({ ...episode, generation: episode.generation + 1 }));
  await setup.deliver(intent);
  expect((await result(setup, intent))).toMatchObject({ state: "rejected", reason_code: "target_conflict" });
  expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
  expect(await setup.bucket.head(publicationCommitKey(setup.frozen.commit))).toBeNull();
});

test("the same request ID with another signed body cannot replace a grant or its operation", async () => {
  const setup = await asyncManagementFixture();
  const start = await setup.intent({ action: "stage-start", upload: setup.upload });
  await setup.deliver(start);
  const before = await result(setup, start);
  const control = setup.text("system/show-publications/daily.json");
  const changed = await setup.intent({ action: "stage-start", upload: { ...setup.upload, operation_id: crypto.randomUUID() } }, start.request_id);
  await setup.deliver(changed);
  expect(await result(setup, start)).toEqual(before);
  expect(setup.text("system/show-publications/daily.json")).toBe(control);
  await expect(verifyManagementResult(before, changed, "private-secret")).rejects.toThrow();
});

test("a caught grant error after owned admission returns only its settled command token and can retry the same request", async () => {
  const setup = await asyncManagementFixture();
  const start = await setup.intent({ action: "stage-start", upload: setup.upload });
  const get = setup.bucket.get.bind(setup.bucket);
  let failed = false;
  const probe = spyOn(setup.bucket, "get").mockImplementation(async (key, options) => {
    if (!failed && key === `system/jobs/${setup.upload.operation_id}/request.toml`) {
      failed = true;
      throw new Error("Caught post-admission grant read failure");
    }
    return get(key, options);
  });
  try { await expect(setup.deliver(start)).rejects.toThrow("post-admission grant read failure"); } finally { probe.mockRestore(); }
  const owner = (await readShowControl(setup.env, "daily"))!.value.owner;
  expect(owner?.job_id).toBe(setup.upload.operation_id);
  expect(owner?.command_execution_id).toBeUndefined();
  expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.invocations).toHaveLength(0);
  await setup.deliver(start);
  expect((await result(setup, start)).state).toBe("granted");
});

test("a caught publication read error after atomic claim returns only its own settled execution before finite retry", async () => {
  const setup = await asyncManagementFixture("show");
  const intent = await setup.intent({ action: "publish", publication: setup.frozen });
  const get = setup.bucket.get.bind(setup.bucket);
  let failed = false;
  const probe = spyOn(setup.bucket, "get").mockImplementation(async (key, options) => {
    if (!failed && key === `system/jobs/${setup.frozen.request.job_id}/request.toml`) {
      failed = true;
      throw new Error("Caught post-admission publication read failure");
    }
    return get(key, options);
  });
  try { await expect(setup.deliver(intent)).rejects.toThrow("post-admission publication read failure"); } finally { probe.mockRestore(); }
  const owner = (await readShowControl(setup.env, "daily"))!.value.owner;
  expect(owner?.job_id).toBe(setup.frozen.request.job_id);
  expect(owner?.execution_id).toBeUndefined();
  expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.invocations).toHaveLength(0);
  await setup.deliver(intent);
  expect((await result(setup, intent)).state).toBe("published");
});
