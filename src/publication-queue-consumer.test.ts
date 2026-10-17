import { expect, test } from "bun:test";
import { m6ServiceConfigHash, parseJobStatus, publicationIntentHash, publicationManifestHash, signPublicationCommitIntent, stagePayloadKey } from "../packages/shared/src/index";
import { commitExecutingPublication, commitOwnedPublication } from "./publication-admission";
import { acquireShowExecution, controlRequestHash, readShowControl, releaseShowExecution } from "./lifecycle-control";
import { queueM6Candidate } from "./m6-routes";
import { inspectPublication } from "./publication-inspection";
import { advancePublicationSubmission, readPublicationSubmission, retainPublicationSubmission } from "./publication-submission-store";
import { pauseServiceAdmission, readServiceAdmission } from "./service-admission";
import { publicationAdminFixture } from "./test-support/publication-admin";

async function fixture(mode: "show" | "episode" | "metadata" | "audio" = "show") {
  const setup = await publicationAdminFixture(mode);
  await setup.publicationSuccess(setup.body("claim"));
  const intent = await signPublicationCommitIntent({ schema_version: 1, family: "publication_commit", commit_protocol: "queue-commit-v1",
    action: "commit", service_id: setup.config.service_id, submission_id: crypto.randomUUID(), operation: setup.publicationOperation,
    manifest_sha256: await publicationManifestHash(setup.frozen), request_sha256: await controlRequestHash(setup.frozen.request),
    worker_version_id: setup.versionId, service_config_sha256: await m6ServiceConfigHash(setup.config) }, "private-secret");
  const consume = (body: unknown = intent, queue = setup.config.queue_name) => queueM6Candidate({ queue, messages: [{
    id: crypto.randomUUID(), body, timestamp: new Date(), attempts: 1,
  }] } as never, setup.candidateEnv, setup.cachedAssets);
  return { ...setup, intent, consume, operation: { showId: "daily", jobId: intent.operation.job_id, generation: intent.operation.show_generation } };
}

for (const mode of ["show", "episode", "metadata", "audio"] as const) test(`Queue commit ${mode} owns execution before marker and publishes once on duplicate/native delivery`, async () => {
  const setup = await fixture(mode);
  const put = setup.bucket.put.bind(setup.bucket);
  let markerExecutions = 0;
  setup.bucket.put = async (key, value, options) => {
    if (key === setup.markerKey) {
      const show = await readShowControl(setup.env, "daily");
      expect(show?.value.owner?.state).toBe("processing");
      expect(show?.value.owner?.execution_id).toBeTruthy();
      expect((await readServiceAdmission(setup.env, "service"))?.value.invocations.some((entry) => entry.kind === "m6_consumer")).toBe(true);
      markerExecutions++;
    }
    return put(key, value, options);
  };
  expect(await setup.bucket.head(setup.markerKey)).toBeNull();
  await setup.consume();
  expect(markerExecutions).toBe(1);
  const status = await inspectPublication(setup.env, "service", setup.frozen);
  expect(status).toMatchObject({ ownership: "released", marker_present: true, execution_active: false,
    status: { state: "published" }, submission: { state: "completed", submission_id: setup.intent.submission_id } });
  expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toEqual([]);
  const writes = setup.writes.filter((key) => key.startsWith("public/"));
  const purgeCount = setup.purges.length;
  await setup.consume();
  await setup.consume({ object: { key: setup.markerKey } });
  expect(setup.writes.filter((key) => key.startsWith("public/"))).toEqual(writes);
  expect(setup.purges.length).toBe(purgeCount);
  expect(markerExecutions).toBe(1);
});

test("Queue Show update preserves 36 published Episodes and immutable audio without re-uploading media", async () => {
  const setup = await fixture();
  for (let index = 0; index < 36; index++) await setup.addEpisode(`episode-${index}`, "active");
  const audioWrites = setup.writes.filter((key) => key.endsWith(".mp3"));
  await setup.consume();
  expect(setup.text("public/podcasts/daily/feed.xml").match(/<item>/g)).toHaveLength(36);
  expect(setup.writes.filter((key) => key.endsWith(".mp3"))).toEqual(audioWrites);
  expect((await inspectPublication(setup.env, "service", setup.frozen))).toMatchObject({ ownership: "released", status: { state: "published" } });
});

test("Queue rejects forged MAC and strict unknown fields without writes; runtime/config mismatch cannot acquire tokens", async () => {
  const setup = await fixture();
  const before = setup.writes.length;
  for (const body of [{ ...setup.intent, mac: "0".repeat(64) }, { ...setup.intent, secret: "private" }]) await setup.consume(body);
  expect(setup.writes.length).toBe(before);
  for (const patch of [{ worker_version_id: crypto.randomUUID() }, { service_id: "another" }, { service_config_sha256: "0".repeat(64) }]) {
    const { mac: _mac, ...payload } = setup.intent;
    await expect(setup.consume(await signPublicationCommitIntent({ ...payload, ...patch }, "private-secret"))).rejects.toThrow("another service");
  }
  expect(setup.writes.length).toBe(before);
  expect(await setup.bucket.head(setup.markerKey)).toBeNull();
});

test("claimed owner can drain while paused; retained execution blocks retry and DLQ never releases it", async () => {
  const setup = await fixture();
  await pauseServiceAdmission(setup.env, "service", crypto.randomUUID(), setup.versionId);
  const execution = await acquireShowExecution(setup.env, "daily", setup.operation.jobId, setup.operation.generation);
  await expect(setup.consume()).rejects.toThrow("Another invocation");
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBe(execution.executionId);
  await setup.consume(setup.intent, setup.config.dlq_name);
  expect(await setup.bucket.head(`system/jobs/${setup.operation.jobId}/dlq.json`)).not.toBeNull();
  expect(await setup.bucket.head(setup.markerKey)).toBeNull();
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBe(execution.executionId);
  await releaseShowExecution(setup.env, execution);
  await setup.consume();
  expect((await inspectPublication(setup.env, "service", setup.frozen)).ownership).toBe("released");
  expect((await readServiceAdmission(setup.env, "service"))!.value.state).toBe("paused");
});

test("dead-letter intent must match the exact frozen operation before writing job diagnostics", async () => {
  const setup = await fixture();
  const { mac: _mac, ...payload } = setup.intent;
  const bad = await signPublicationCommitIntent({ ...payload, request_sha256: "0".repeat(64) }, "private-secret");
  await expect(setup.consume(bad, setup.config.dlq_name)).rejects.toThrow("frozen manifest/operation");
  expect(await setup.bucket.head(`system/jobs/${setup.operation.jobId}/dlq.json`)).toBeNull();
  expect(await setup.bucket.head(setup.markerKey)).toBeNull();
  expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toEqual([]);
});

test("deterministic validation failure holds its owner/draft and cannot publish on duplicate delivery", async () => {
  const setup = await fixture("episode");
  await setup.bucket.delete(stagePayloadKey(setup.stages[0]!, "audio"));
  const publicWrites = setup.writes.filter((key) => key.startsWith("public/"));
  await setup.consume();
  const status = await inspectPublication(setup.env, "service", setup.frozen);
  expect(status).toMatchObject({ ownership: "held", execution_active: false, status: { state: "failed", reason_code: "validation_failed" },
    submission: { state: "failed", reason_code: "validation_failed" } });
  const marker = setup.text(setup.markerKey);
  await setup.consume();
  await setup.consume({ object: { key: setup.markerKey } });
  expect(setup.writes.filter((key) => key.startsWith("public/"))).toEqual(publicWrites);
  expect(setup.text(setup.markerKey)).toBe(marker);
  expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toEqual([]);
});

test("marker failure releases only settled owned execution, retains pending intent, and same-message retry completes", async () => {
  const setup = await fixture();
  const put = setup.bucket.put.bind(setup.bucket);
  let reject = true;
  setup.bucket.put = async (key, value, options) => {
    if (key === setup.markerKey && reject) { reject = false; throw new Error("simulated IO failure"); }
    return put(key, value, options);
  };
  await expect(setup.consume()).rejects.toThrow("simulated IO failure");
  expect((await readPublicationSubmission(setup.env, setup.operation.jobId))!.value.result.state).toBe("pending");
  expect((await readShowControl(setup.env, "daily"))!.value.owner).toMatchObject({ state: "processing", job_id: setup.operation.jobId });
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBeUndefined();
  expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toEqual([]);
  await setup.consume();
  expect(parseJobStatus(setup.text(`system/jobs/${setup.operation.jobId}/status.toml`)).state).toBe("published");
});

test("lost submission completion acknowledgement is reconciled from published/released without repeating public writes", async () => {
  const setup = await fixture("episode");
  const put = setup.bucket.put.bind(setup.bucket);
  let reject = true;
  setup.bucket.put = async (key, value, options) => {
    if (key === `system/jobs/${setup.operation.jobId}/queue-submission.json` && typeof value === "string" &&
      JSON.parse(value).result.state === "completed" && reject) { reject = false; throw new Error("completion record write failed"); }
    return put(key, value, options);
  };
  await expect(setup.consume()).rejects.toThrow("completion record write failed");
  expect((await inspectPublication(setup.env, "service", setup.frozen))).toMatchObject({ ownership: "released", status: { state: "published" },
    submission: { state: "committed" } });
  const writes = setup.writes.filter((key) => key.startsWith("public/")), purges = setup.purges.length;
  await setup.consume();
  expect((await readPublicationSubmission(setup.env, setup.operation.jobId))!.value.result.state).toBe("completed");
  expect(setup.writes.filter((key) => key.startsWith("public/"))).toEqual(writes);
  expect(setup.purges.length).toBe(purges);
});

test("a pending marker PUT retains both tokens and duplicate delivery cannot steal execution", async () => {
  const setup = await fixture();
  const put = setup.bucket.put.bind(setup.bucket);
  const entered = Promise.withResolvers<void>(), continuePut = Promise.withResolvers<void>();
  setup.bucket.put = async (key, value, options) => {
    if (key === setup.markerKey) { entered.resolve(); await continuePut.promise; }
    return put(key, value, options);
  };
  const running = setup.consume();
  await entered.promise;
  try {
    const token = (await readShowControl(setup.env, "daily"))!.value.owner!.execution_id;
    expect(token).toBeTruthy();
    expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toHaveLength(1);
    await expect(setup.consume()).rejects.toThrow("Another invocation");
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBe(token);
    expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toHaveLength(1);
    expect(await setup.bucket.head(setup.markerKey)).toBeNull();
  } finally { continuePut.resolve(); await running; }
  expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toEqual([]);
});

test("same submission ID with another body and same job with another ID cannot replace retained request/result", async () => {
  const setup = await fixture();
  await retainPublicationSubmission(setup.env, setup.intent);
  const before = setup.text(`system/jobs/${setup.operation.jobId}/queue-submission.json`);
  const { mac: _mac, ...payload } = setup.intent;
  await setup.consume(await signPublicationCommitIntent({ ...payload, manifest_sha256: "0".repeat(64) }, "private-secret"));
  await setup.consume(await signPublicationCommitIntent({ ...payload, submission_id: crypto.randomUUID() }, "private-secret"));
  expect(setup.text(`system/jobs/${setup.operation.jobId}/queue-submission.json`)).toBe(before);
  expect(await setup.bucket.head(setup.markerKey)).toBeNull();
  await setup.consume();
  expect((await readPublicationSubmission(setup.env, setup.operation.jobId))!.value.result.state).toBe("completed");
  await expect(advancePublicationSubmission(setup.env, setup.intent, "pending")).rejects.toThrow("retained identity");
});

test("exact claimed generation/manifest is required; a rejected intent cannot recreate or advance the Show", async () => {
  const setup = await fixture();
  const { mac: _mac, ...payload } = setup.intent;
  const bad = await signPublicationCommitIntent({ ...payload, operation: { ...payload.operation, show_generation: payload.operation.show_generation + 1 } }, "private-secret");
  const control = setup.text("system/show-publications/daily.json");
  await setup.consume(bad);
  expect((await readPublicationSubmission(setup.env, setup.operation.jobId))!.value.result).toMatchObject({ state: "rejected", reason_code: "stale_claim" });
  await setup.consume(bad);
  expect(setup.text("system/show-publications/daily.json")).toBe(control);
  expect(await setup.bucket.head(setup.markerKey)).toBeNull();
});

test("Queue marker runner requires exact execution/hash; HTTP runner keeps reserved/no-execution restriction", async () => {
  const setup = await fixture();
  const execution = await acquireShowExecution(setup.env, "daily", setup.operation.jobId, setup.operation.generation);
  await expect(commitOwnedPublication(setup.env, setup.operation)).rejects.toThrow("unstarted");
  await expect(commitExecutingPublication(setup.env, { ...execution, executionId: crypto.randomUUID() }, setup.intent)).rejects.toThrow();
  await expect(commitExecutingPublication(setup.env, execution, { ...setup.intent, manifest_sha256: "0".repeat(64) })).rejects.toThrow();
  await expect(commitExecutingPublication(setup.env, execution, { ...setup.intent, request_sha256: "0".repeat(64) })).rejects.toThrow();
  expect(await setup.bucket.head(setup.markerKey)).toBeNull();
  expect((await commitExecutingPublication(setup.env, execution, setup.intent)).created).toBe(true);
  expect((await commitExecutingPublication(setup.env, execution, setup.intent)).created).toBe(false);
  expect(await publicationIntentHash(setup.intent)).toMatch(/^[a-f0-9]{64}$/);
});

test("Queue marker runner rechecks the frozen manifest after marker lookup without writing a stale commit", async () => {
  const setup = await fixture();
  const execution = await acquireShowExecution(setup.env, "daily", setup.operation.jobId, setup.operation.generation);
  const get = setup.bucket.get.bind(setup.bucket);
  let changed = false;
  setup.bucket.get = async (key, options) => {
    if (key === setup.markerKey && !changed) {
      changed = true;
      await setup.bucket.put(`system/jobs/${setup.operation.jobId}/publication.json`, JSON.stringify({ ...setup.frozen,
        commit: { ...setup.frozen.commit, metadata_sha256: "0".repeat(64) } }));
    }
    return get(key, options);
  };
  await expect(commitExecutingPublication(setup.env, execution, setup.intent)).rejects.toThrow("frozen request");
  expect(await setup.bucket.head(setup.markerKey)).toBeNull();
});

test("invalid cache-owner runtime cannot retain submission records or acquire Show execution", async () => {
  const setup = await fixture();
  const control = setup.text("system/show-publications/daily.json");
  setup.cachedAssets.describeRuntime = async () => ({ worker_version_id: crypto.randomUUID(), entrypoint: "CachedPublicAssets" });
  await expect(setup.consume()).rejects.toThrow();
  expect(await setup.bucket.head(`system/jobs/${setup.operation.jobId}/queue-submission.json`)).toBeNull();
  expect(await setup.bucket.head(setup.markerKey)).toBeNull();
  expect(setup.text("system/show-publications/daily.json")).toBe(control);
  expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toEqual([]);
});
