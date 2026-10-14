import { expect, test } from "bun:test";
import { acquireShowExecution, readShowControl } from "./lifecycle-control";
import { claimPublicationOperation, commitOwnedPublication } from "./publication-admission";
import { handleM6PublicationAdmin } from "./publication-admin";
import { consumeOwnedPublication } from "./publication-consumer";
import { queueM6Candidate } from "./m6-routes";
import { acquireServiceInvocation } from "./service-admission";
import { publicationAdminFixture } from "./test-support/publication-admin";
import { createHash } from "node:crypto";

async function frozenFixture(mode: "show" | "episode" | "metadata" | "audio" = "show") {
  const setup = await publicationAdminFixture(mode);
  const operation = { showId: setup.publicationOperation.show_id, jobId: setup.publicationOperation.job_id,
    generation: setup.publicationOperation.show_generation };
  await claimPublicationOperation(setup.env, setup.frozen);
  await commitOwnedPublication(setup.env, operation);
  const execution = await acquireShowExecution(setup.env, "daily", operation.jobId, operation.generation);
  await acquireServiceInvocation(setup.env, "service", "m6_consumer");
  await setup.bucket.put(`system/jobs/${operation.jobId}/dlq.json`, JSON.stringify({ key: setup.markerKey }));
  return { ...setup, frozenOperation: operation, execution };
}

async function expectReleaseBlocked(setup: Awaited<ReturnType<typeof publicationAdminFixture>>): Promise<void> {
  const before = new Map(setup.entries);
  const response = await handleM6PublicationAdmin(setup.http({ schema_version: 1, service_id: "service", action: "release",
    operation: setup.publicationOperation, manifest_sha256: createHash("sha256").update(JSON.stringify(setup.frozen)).digest("hex") }),
    setup.env, setup.bindings);
  expect(response!.status).toBe(409);
  expect(await response!.json()).toMatchObject({ reason_code: "publication_execution_unsettled" });
  expect(setup.sent).toEqual([]);
  expect(setup.entries).toEqual(before);
}

for (const mode of ["show", "episode", "metadata", "audio"] as const) {
  test(`${mode} release never treats a matching DLQ marker as proof that execution or IO ended`, async () => {
    const setup = await frozenFixture(mode);
    await expectReleaseBlocked(setup);
    expect((await readShowControl(setup.env, "daily"))!.value.owner!.execution_id).toBe(setup.execution.executionId);
    await expect(consumeOwnedPublication(setup.env, setup.markerKey, { async checkDeliveryGate() {}, async purge() {} }))
      .rejects.toThrow("still owns");
  });
}

test("release leaves multiple consumer tokens and foreign or missing DLQ history untouched", async () => {
  for (const evidence of [null, { key: `staging/shows/daily/${crypto.randomUUID()}/commit.json` }]) {
    const setup = await frozenFixture();
    await acquireServiceInvocation(setup.env, "service", "m6_consumer");
    const key = `system/jobs/${setup.frozenOperation.jobId}/dlq.json`;
    if (evidence) await setup.bucket.put(key, JSON.stringify(evidence));
    else await setup.bucket.delete(key);
    await expectReleaseBlocked(setup);
  }
});

test("an old matching DLQ marker cannot release a current streaming audio PUT", async () => {
  const setup = await publicationAdminFixture("episode");
  const operation = await claimPublicationOperation(setup.env, setup.frozen);
  await commitOwnedPublication(setup.env, operation);
  await setup.bucket.put(`system/jobs/${operation.jobId}/dlq.json`, JSON.stringify({ key: setup.markerKey }));
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const put = setup.bucket.put.bind(setup.bucket);
  setup.bucket.put = async (...args: Parameters<typeof put>) => {
    if (args[0].endsWith(`/${operation.jobId}.mp3`)) { started.resolve(); await finish.promise; }
    return put(...args);
  };
  const outcome = queueM6Candidate({ queue: "test-queue", messages: [{ id: "current-delivery",
    body: { object: { key: setup.markerKey } } }] } as never, setup.candidateEnv, setup.cachedAssets);
  try {
    await started.promise;
    await expectReleaseBlocked(setup);
    expect((await readShowControl(setup.env, "daily"))!.value.owner!.execution_id).toBeString();
  } finally { finish.resolve(); await outcome; }
  expect((await readShowControl(setup.env, "daily"))!.value.owner).toBeUndefined();
});
