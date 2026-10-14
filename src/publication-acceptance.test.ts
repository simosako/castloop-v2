import { describe, expect, spyOn, test } from "bun:test";
import { parseJobStatus, stagePayloadKey } from "../packages/shared/src/index";
import { readShowControl } from "./lifecycle-control";
import { consumeOwnedPublication } from "./publication-consumer";
import { queueM6Candidate } from "./m6-routes";
import { SERVICE_ADMISSION_KEY } from "./service-admission";
import { publicationAdminFixture } from "./test-support/publication-admin";

describe("Queue-validated publication acceptance", () => {
  test("old or unknown acceptance protocols cannot claim or create markers", async () => {
    const setup = await publicationAdminFixture();
    const writes = setup.writes.length;
    for (const action of ["claim", "commit"] as const) {
      const { acceptance_protocol: _protocol, ...legacy } = setup.body(action);
      for (const body of [legacy, { ...legacy, acceptance_protocol: "unverified-protocol" }]) {
        expect((await setup.call(body)).status).toBe(400);
      }
    }
    expect(setup.writes).toHaveLength(writes);
    expect(setup.entries.has(setup.markerKey)).toBe(false);
  });

  for (const mode of ["show", "episode", "metadata", "audio"] as const) {
    test(`${mode}: invalid proofs fail once, preserve the owner and never publish on duplicate delivery`, async () => {
      const setup = await publicationAdminFixture(mode);
      await setup.publicationSuccess(setup.body("claim"));
      const proof = `system/jobs/${setup.stages[0]!.operation_id}/upload-progress.json`;
      await setup.bucket.put(proof, "malformed private proof");
      expect((await setup.call(setup.body("commit"))).status).toBe(202);
      const before = [...setup.entries].filter(([key]) => key.startsWith("public/") || key.startsWith("system/shows/"));
      const deliver = () => queueM6Candidate({ queue: "test-queue", messages: [
        { id: "publication", body: { object: { key: setup.markerKey } } },
      ] } as never, setup.candidateEnv, setup.cachedAssets);
      await deliver();
      const statusKey = `system/jobs/${setup.publicationOperation.job_id}/status.toml`;
      expect(parseJobStatus(setup.text(statusKey))).toMatchObject({ state: "failed", reason_code: "validation_failed" });
      const status = setup.entries.get(statusKey);
      const get = spyOn(setup.bucket, "get");
      try {
        await deliver();
        expect(get.mock.calls.some(([key]) => key === proof)).toBe(false);
      } finally { get.mockRestore(); }
      expect(setup.entries.get(statusKey)).toEqual(status);
      expect([...setup.entries].filter(([key]) => key.startsWith("public/") || key.startsWith("system/shows/"))).toEqual(before);
      expect(setup.purges).toEqual([]);
      const owner = (await readShowControl(setup.env, "daily"))!.value.owner!;
      expect(owner.job_id).toBe(setup.publicationOperation.job_id);
      expect(owner.execution_id).toBeUndefined();
      expect(JSON.parse(setup.text(SERVICE_ADMISSION_KEY)).invocations).toEqual([]);
      expect((await setup.call(setup.body("retry"))).status).toBe(409);
      expect(setup.sent).toEqual([]);
      expect(setup.text(statusKey)).not.toContain("private proof");
    });
  }

  for (const change of ["etag", "version", "size"] as const) {
    test(`${change}: payload identity is checked by the consumer after HTTP acceptance`, async () => {
      const setup = await publicationAdminFixture("audio");
      await setup.publicationSuccess(setup.body("claim"));
      await setup.publicationSuccess(setup.body("commit"));
      const key = stagePayloadKey(setup.stages[0]!, "audio");
      const original = setup.bucket.head.bind(setup.bucket);
      const head = spyOn(setup.bucket, "head").mockImplementation(async (...args) => {
        const value = await original(...args);
        return args[0] === key && value ? { ...value, [change]: change === "size" ? value.size + 1 : "changed-object" } : value;
      });
      try {
        expect(await consumeOwnedPublication(setup.env, setup.markerKey, { checkDeliveryGate: async () => {}, purge: async () => {} }))
          .toEqual({ state: "failed", reason: "validation_failed" });
        expect(setup.entries.has(`public/podcasts/daily/episodes/next/${setup.publicationOperation.job_id}.mp3`)).toBe(false);
      } finally { head.mockRestore(); }
    });
  }

  test("transient proof I/O failure waits for all started reads and remains retryable", async () => {
    const setup = await publicationAdminFixture();
    await setup.publicationSuccess(setup.body("claim"));
    await setup.publicationSuccess(setup.body("commit"));
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const requestKey = `system/jobs/${setup.stages[0]!.operation_id}/upload.json`;
    const progressKey = `system/jobs/${setup.stages[0]!.operation_id}/upload-progress.json`;
    const original = setup.bucket.get.bind(setup.bucket);
    const get = spyOn(setup.bucket, "get").mockImplementation(async (...args) => {
      if (args[0] === requestKey) throw new Error("Private transient storage failure");
      if (args[0] === progressKey) { started.resolve(); await ended.promise; }
      return original(...args);
    });
    try {
      let settled = false;
      const pending = consumeOwnedPublication(setup.env, setup.markerKey, { checkDeliveryGate: async () => {}, purge: async () => {} })
        .then(() => { settled = true; return null; }, (error: unknown) => { settled = true; return error; });
      await started.promise;
      expect(settled).toBe(false);
      expect((await readShowControl(setup.env, "daily"))!.value.owner!.execution_id).toBeString();
      ended.resolve();
      expect(await pending).toBeInstanceOf(Error);
      const status = setup.text(`system/jobs/${setup.publicationOperation.job_id}/status.toml`);
      expect(parseJobStatus(status).state).toBe("retrying");
      expect(status).not.toContain("Private transient");
      expect((await readShowControl(setup.env, "daily"))!.value.owner!.execution_id).toBeUndefined();
    } finally { ended.resolve(); get.mockRestore(); }
  });

  test("input mismatch after a previous public write stays retryable rather than claiming a pre-write rejection", async () => {
    const setup = await publicationAdminFixture("episode");
    await setup.publicationSuccess(setup.body("claim"));
    await setup.publicationSuccess(setup.body("commit"));
    const key = `public/podcasts/daily/episodes/next/${setup.publicationOperation.job_id}.mp3`;
    const effects = { checkDeliveryGate: async () => {}, purge: async () => {} };
    const original = setup.bucket.put.bind(setup.bucket);
    const put = spyOn(setup.bucket, "put").mockImplementation(async (...args) => {
      const written = await original(...args);
      if (args[0] === key && written) throw new Error("Audio write acknowledgement lost");
      return written;
    });
    try { await expect(consumeOwnedPublication(setup.env, setup.markerKey, effects)).rejects.toThrow("acknowledgement lost"); }
    finally { put.mockRestore(); }
    const media = setup.entries.get(key);
    expect(media).toBeDefined();
    await setup.bucket.put(`system/jobs/${setup.stages[0]!.operation_id}/upload-progress.json`, "malformed private proof");
    await expect(consumeOwnedPublication(setup.env, setup.markerKey, effects)).rejects.toThrow("could not be validated");
    expect(parseJobStatus(setup.text(`system/jobs/${setup.publicationOperation.job_id}/status.toml`))).toMatchObject({ state: "retrying", phase: "feed" });
    expect(setup.entries.get(key)).toEqual(media);
    expect((await readShowControl(setup.env, "daily"))!.value.owner!.execution_id).toBeUndefined();
  });

  test("failed-status response loss preserves durable failure and the next delivery cannot publish", async () => {
    const setup = await publicationAdminFixture();
    const feed = setup.entries.get("public/podcasts/daily/feed.xml");
    await setup.publicationSuccess(setup.body("claim"));
    await setup.publicationSuccess(setup.body("commit"));
    await setup.bucket.put(`system/jobs/${setup.stages[0]!.operation_id}/upload-progress.json`, "malformed proof");
    const effects = { checkDeliveryGate: async () => {}, purge: async () => {} };
    const key = `system/jobs/${setup.publicationOperation.job_id}/status.toml`;
    const original = setup.bucket.put.bind(setup.bucket);
    const put = spyOn(setup.bucket, "put").mockImplementation(async (...args) => {
      const written = await original(...args);
      if (args[0] === key && typeof args[1] === "string" && parseJobStatus(args[1]).state === "failed") {
        throw new Error("Failure status acknowledgement lost");
      }
      return written;
    });
    try { await expect(consumeOwnedPublication(setup.env, setup.markerKey, effects)).rejects.toThrow("acknowledgement lost"); }
    finally { put.mockRestore(); }
    expect(parseJobStatus(setup.text(key)).state).toBe("failed");
    expect(await consumeOwnedPublication(setup.env, setup.markerKey, effects)).toEqual({ state: "failed", reason: "validation_failed" });
    expect(setup.entries.get("public/podcasts/daily/feed.xml")).toEqual(feed);
    expect((await readShowControl(setup.env, "daily"))!.value.owner!.execution_id).toBeUndefined();
  });
});
