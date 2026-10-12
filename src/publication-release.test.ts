import { expect, test } from "bun:test";
import { publicationAdminResponseSchema } from "../packages/shared/src/index";
import { acquireShowExecution, readShowControl } from "./lifecycle-control";
import { claimPublicationOperation, commitOwnedPublication } from "./publication-admission";
import { handleM6PublicationAdmin } from "./publication-admin";
import { consumeOwnedPublication, releaseAbandonedPublication } from "./publication-consumer";
import { acquireServiceInvocation, readServiceAdmission } from "./service-admission";
import { publicationAdminFixture } from "./test-support/publication-admin";
import { createHash } from "node:crypto";

async function frozenFixture() {
  const setup = await publicationAdminFixture("show");
  const operation = { showId: setup.publicationOperation.show_id, jobId: setup.publicationOperation.job_id,
    generation: setup.publicationOperation.show_generation };
  await claimPublicationOperation(setup.env, setup.frozen);
  await commitOwnedPublication(setup.env, operation);
  const execution = await acquireShowExecution(setup.env, "daily", operation.jobId, operation.generation);
  await acquireServiceInvocation(setup.env, "service", "m6_consumer");
  await setup.bucket.put(`system/jobs/${operation.jobId}/dlq.json`, JSON.stringify({ key: setup.markerKey }));
  return { ...setup, frozenOperation: operation, execution };
}

function admissionInvocations(setup: Awaited<ReturnType<typeof publicationAdminFixture>>) {
  return JSON.parse(setup.text("system/lifecycle-service.json")).invocations as { token: string; kind: string }[];
}

test("publication release frees a frozen execution with dead-letter evidence and the job finishes after requeue", async () => {
  const setup = await frozenFixture();
  const sent: string[] = [];
  const released = await releaseAbandonedPublication(setup.env, setup.frozenOperation, { serviceId: "service",
    send: async (key) => { sent.push(key); } });
  expect(released.key).toBe(setup.markerKey);
  expect(released.invocationReleased).toBe(true);
  expect(sent).toEqual([setup.markerKey]);
  const owner = (await readShowControl(setup.env, "daily"))!.value.owner!;
  expect(owner.state).toBe("processing");
  expect(owner.execution_id).toBeUndefined();
  expect(admissionInvocations(setup).filter((item) => item.kind === "m6_consumer")).toHaveLength(0);
  await consumeOwnedPublication(setup.env, setup.markerKey, { async checkDeliveryGate() {}, async purge() {} });
  const control = (await readShowControl(setup.env, "daily"))!.value;
  expect(control.owner).toBeUndefined();
  expect(control.last_finished_operation?.job_id).toBe(setup.frozenOperation.jobId);
});

test("publication release rejects missing or foreign dead-letter evidence without touching ownership", async () => {
  for (const evidence of [null, { key: `staging/shows/daily/${crypto.randomUUID()}/commit.json` }]) {
    const setup = await frozenFixture();
    if (evidence) await setup.bucket.put(`system/jobs/${setup.frozenOperation.jobId}/dlq.json`, JSON.stringify(evidence));
    else await setup.bucket.delete(`system/jobs/${setup.frozenOperation.jobId}/dlq.json`);
    await expect(releaseAbandonedPublication(setup.env, setup.frozenOperation, { serviceId: "service",
      send: async () => { throw new Error("Release must not requeue without evidence"); } })).rejects.toThrow("dead-letter");
    const owner = (await readShowControl(setup.env, "daily"))!.value.owner!;
    expect(owner.state).toBe("processing");
    expect(owner.execution_id).toBe(setup.execution.executionId);
    expect(admissionInvocations(setup).filter((item) => item.kind === "m6_consumer")).toHaveLength(1);
  }
});

test("publication release requeues an already released owner without a second invocation return", async () => {
  const setup = await frozenFixture();
  await releaseAbandonedPublication(setup.env, setup.frozenOperation, { serviceId: "service", send: async () => {} });
  const sent: string[] = [];
  const repeated = await releaseAbandonedPublication(setup.env, setup.frozenOperation, { serviceId: "service",
    send: async (key) => { sent.push(key); } });
  expect(repeated.invocationReleased).toBe(false);
  expect(sent).toEqual([setup.markerKey]);
  const owner = (await readShowControl(setup.env, "daily"))!.value.owner!;
  expect(owner.state).toBe("processing");
  expect(owner.execution_id).toBeUndefined();
});

test("publication release keeps multiple retained consumer invocations untouched", async () => {
  const setup = await frozenFixture();
  await acquireServiceInvocation(setup.env, "service", "m6_consumer");
  const released = await releaseAbandonedPublication(setup.env, setup.frozenOperation, { serviceId: "service", send: async () => {} });
  expect(released.invocationReleased).toBe(false);
  expect(admissionInvocations(setup).filter((item) => item.kind === "m6_consumer")).toHaveLength(2);
  const owner = (await readShowControl(setup.env, "daily"))!.value.owner!;
  expect(owner.execution_id).toBeUndefined();
});

test("publication admin release requires the frozen manifest and reports the retained invocation", async () => {
  const setup = await frozenFixture();
  const response = await handleM6PublicationAdmin(new Request("https://current.example/admin/publication", {
    method: "POST", headers: { "X-Castloop-Key": "private-secret" },
    body: JSON.stringify({ schema_version: 1, service_id: "service", action: "release", operation: setup.publicationOperation,
      manifest_sha256: createHash("sha256").update(JSON.stringify(setup.frozen)).digest("hex") }),
  }), setup.env, setup.bindings);
  expect(response!.status).toBe(200);
  const value = publicationAdminResponseSchema.parse(await response!.json<unknown>());
  expect(value.result).toBe("released");
  if (value.result !== "released") throw new Error("unreachable");
  expect(value.key).toBe(setup.markerKey);
  expect(value.invocation_released).toBe(true);
  expect(setup.sent).toEqual([setup.markerKey]);
  expect((await readServiceAdmission(setup.env, "service"))!.value.invocations).toHaveLength(0);
  const mismatch = await handleM6PublicationAdmin(new Request("https://current.example/admin/publication", {
    method: "POST", headers: { "X-Castloop-Key": "private-secret" },
    body: JSON.stringify({ schema_version: 1, service_id: "service", action: "release", operation: setup.publicationOperation,
      manifest_sha256: "0".repeat(64) }),
  }), setup.env, setup.bindings);
  expect(mismatch!.status).toBe(409);
});
