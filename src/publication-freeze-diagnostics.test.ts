import { expect, spyOn, test } from "bun:test";
import { parseJobStatus, parseShowControl } from "../packages/shared/src/index";
import { readShowControl } from "./lifecycle-control";
import { queueM6Candidate } from "./m6-routes";
import { claimPublicationOperation, commitOwnedPublication } from "./publication-admission";
import { consumeOwnedPublication } from "./publication-consumer";
import { readPublicationBytes } from "./publication-inputs";
import { readServiceAdmission } from "./service-admission";
import { episodePublicationFixture } from "./test-support/episode-publication";
import { publicationAdminFixture } from "./test-support/publication-admin";

for (const stop of ["audio_put", "catalog_advance", "feed_generation_write", "status_write.published", "owner_release", "invocation_release"] as const) {
  test(`Episode ${stop} emits a start while pending and holds the appropriate ownership until IO settles`, async () => {
    const setup = await publicationAdminFixture("episode");
    const operation = await claimPublicationOperation(setup.env, setup.frozen);
    await commitOwnedPublication(setup.env, operation);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const put = setup.bucket.put.bind(setup.bucket);
    let paused = false;
    setup.bucket.put = async (...args: Parameters<typeof put>) => {
      const [key, input] = args;
      const source = typeof input === "string" ? input : "";
      const control = key === "system/show-publications/daily.json" ? parseShowControl(JSON.parse(source)) : null;
      const matches = stop === "audio_put" ? key.endsWith(`/${operation.jobId}.mp3`) :
        stop === "catalog_advance" ? key.endsWith("episode-catalog.json") :
        stop === "feed_generation_write" ? control?.last_feed_job_id === operation.jobId && !!control.owner :
        stop === "status_write.published" ? key === `system/jobs/${operation.jobId}/status.toml` && parseJobStatus(source).state === "published" :
        stop === "owner_release" ? control?.last_finished_operation?.job_id === operation.jobId && !control.owner :
        key === "system/lifecycle-service.json" && JSON.parse(source).invocations.length === 0;
      if (!paused && matches) { paused = true; started.resolve(); await finish.promise; }
      return put(...args);
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    const outcome = queueM6Candidate({ queue: "test-queue", messages: [{ id: "episode-diagnostic", attempts: 1,
      timestamp: new Date(), body: { object: { key: setup.markerKey } } }] } as never, setup.candidateEnv, setup.cachedAssets);
    try {
      await started.promise;
      const records = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      const phase = `publication.${stop}`;
      const start = records.find((record) => record.event === "worker_phase_started" && record.phase === phase);
      expect(start).toMatchObject({ job_id: operation.jobId, phase });
      expect(records.some((record) => record.event === "worker_timing" && record.timing_id === start.timing_id)).toBe(false);
      const control = (await readShowControl(setup.env, "daily"))!.value;
      if (stop === "invocation_release") expect(control.owner).toBeUndefined();
      else expect(control.owner?.execution_id).toBeString();
      expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toHaveLength(1);
      expect(JSON.stringify(records)).not.toContain("Private Episode description");
      expect(JSON.stringify(records)).not.toContain("execution_id");
    } finally { finish.resolve(); await outcome; log.mockRestore(); }
    expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
    expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toHaveLength(0);
  });
}

for (const fault of ["source_changed", "owner_check", "put_rejected"] as const) {
  test(`Episode ${fault} cancels and awaits the unused audio body before returning its execution token`, async () => {
    const setup = await episodePublicationFixture();
    const canceled = Promise.withResolvers<void>();
    const finishCancel = Promise.withResolvers<void>();
    const sourceKey = `staging/episodes/daily/${setup.episodeId}/${setup.operation.jobId}/audio.mp3`;
    const get = setup.bucket.get.bind(setup.bucket);
    const put = setup.bucket.put.bind(setup.bucket);
    let rejectOwner = false;
    setup.bucket.get = async (...args: Parameters<typeof get>) => {
      if (args[0] === "system/show-publications/daily.json" && rejectOwner) {
        rejectOwner = false;
        throw new Error("Audio owner check unavailable");
      }
      const object = await get(...args);
      if (args[0] !== sourceKey || !object || !("body" in object)) return object;
      await object.body.cancel();
      const body = new ReadableStream<Uint8Array>({ async cancel() { canceled.resolve(); await finishCancel.promise; } });
      if (fault === "owner_check") rejectOwner = true;
      return { ...object, body, ...(fault === "source_changed" ? { version: "changed-version" } : {}) };
    };
    setup.bucket.put = async (...args: Parameters<typeof put>) => {
      if (fault === "put_rejected" && args[0] === setup.mediaKey) throw new Error("Audio PUT rejected before reading the source");
      return put(...args);
    };
    const outcome = consumeOwnedPublication(setup.env, setup.key, { async checkDeliveryGate() {}, async purge() {} })
      .then(() => null, (error: unknown) => error);
    try {
      await canceled.promise;
      expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBeString();
      expect(setup.entries.has(setup.mediaKey)).toBe(false);
    } finally { finishCancel.resolve(); }
    expect(await outcome).toBeInstanceOf(Error);
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBeUndefined();
    expect(parseJobStatus(setup.text(setup.statusKey)).state).toBe("retrying");
  });
}

test("publication snapshot mismatch cancels the discarded response instead of leaving an unread body", async () => {
  const setup = await episodePublicationFixture();
  const get = setup.bucket.get.bind(setup.bucket);
  let canceled = false;
  setup.bucket.get = async (...args: Parameters<typeof get>) => {
    const object = await get(...args);
    if (!object || !("body" in object)) return object;
    await object.body.cancel();
    return { ...object, etag: "changed-etag", body: new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }) };
  };
  await expect(readPublicationBytes(setup.env, "system/service.toml", 16384)).rejects.toThrow("changed before reading");
  expect(canceled).toBe(true);
});

test("journal read failure waits for the other started read before consumer cleanup", async () => {
  const setup = await episodePublicationFixture();
  const get = setup.bucket.get.bind(setup.bucket);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  setup.bucket.get = async (...args: Parameters<typeof get>) => {
    if (args[0] === setup.statusKey) throw new Error("Status read failed");
    if (args[0] === setup.progressKey) { started.resolve(); await finish.promise; }
    return get(...args);
  };
  const outcome = consumeOwnedPublication(setup.env, setup.key, { async checkDeliveryGate() {}, async purge() {} })
    .then(() => null, (error: unknown) => error);
  try {
    await started.promise;
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBeString();
  } finally { finish.resolve(); }
  expect(await outcome).toBeInstanceOf(Error);
  expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBeUndefined();
});

test("persistent cleanup IO failure leaves tokens held and reports which cleanup stages failed", async () => {
  const setup = await publicationAdminFixture("episode");
  const operation = await claimPublicationOperation(setup.env, setup.frozen);
  await commitOwnedPublication(setup.env, operation);
  const get = setup.bucket.get.bind(setup.bucket);
  const put = setup.bucket.put.bind(setup.bucket);
  let unavailable = false;
  setup.bucket.get = async (...args: Parameters<typeof get>) => {
    if (unavailable) throw new Error("Private failure detail must not appear in structured logs");
    return get(...args);
  };
  setup.bucket.put = async (...args: Parameters<typeof put>) => {
    if (args[0].endsWith(`/${operation.jobId}.mp3`)) {
      unavailable = true;
      throw new Error("Audio PUT failure");
    }
    return put(...args);
  };
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(queueM6Candidate({ queue: "test-queue", messages: [{ id: "persistent-io",
      body: { object: { key: setup.markerKey } } }] } as never, setup.candidateEnv, setup.cachedAssets)).rejects.toThrow();
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line)));
    for (const phase of ["publication.audio_put", "publication.failure_record", "publication.execution_cleanup", "publication.invocation_release"]) {
      expect(records.find((record) => record.event === "worker_timing" && record.phase === phase)).toMatchObject({ outcome: "error" });
    }
    expect(JSON.stringify(records)).not.toContain("Private failure detail");
    unavailable = false;
    expect((await readShowControl(setup.env, "daily"))!.value.owner?.execution_id).toBeString();
    expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toHaveLength(1);
    await expect(consumeOwnedPublication(setup.env, setup.markerKey, { async checkDeliveryGate() {}, async purge() {} }))
      .rejects.toThrow("still owns");
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line))).find((record) => record.event === "publication_execution_blocked"))
      .toMatchObject({ reason_code: "retained_execution_token", authorizes_recovery: false });
  } finally { unavailable = false; log.mockRestore(); }
});
