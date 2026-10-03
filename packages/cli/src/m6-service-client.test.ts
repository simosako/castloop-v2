import { expect, test } from "bun:test";
import { M6ServiceClient } from "./m6-service-client";
import { consumeM6SetupProbe } from "../../../src/m6-setup-queue";
import { acquireServiceInvocation, readServiceAdmission, releaseServiceInvocation, SERVICE_ADMISSION_KEY } from "../../../src/service-admission";
import { m6SetupFixture } from "../../../src/test-support/m6-setup";

async function initialized() {
  const setup = await m6SetupFixture();
  await setup.run(setup.post("prepare", setup.request));
  await consumeM6SetupProbe(setup.batch(setup.sent[0]), setup.env);
  expect((await setup.run(setup.post("complete", { ...setup.request, snapshots: [setup.snapshot, setup.snapshot] }))).status).toBe(200);
  const transport = (url: URL, init: RequestInit) => setup.run(new Request(url, init));
  const client = new M6ServiceClient(setup.config, "private-secret", transport);
  return { ...setup, client, transport };
}

test("service API explicitly resumes initialized paused admission and pauses without clearing live invocation owners", async () => {
  const setup = await initialized();
  const service = { service_id: setup.config.service_id };
  expect((await setup.client.call({ ...service, action: "status" })).admission.state).toBe("paused");
  const resume = { ...service, action: "resume" as const, pause_id: setup.request.target.operation_id };
  await expect(setup.client.call({ ...resume, pause_id: crypto.randomUUID() })).rejects.toThrow("not verified");
  expect((await setup.client.call(resume)).admission.state).toBe("open");
  const invocation = await acquireServiceInvocation(setup.env, service.service_id, "m6_admin");
  const pause = { ...service, action: "pause" as const, pause_id: crypto.randomUUID() };
  const paused = await setup.client.call(pause);
  expect(paused.admission.invocations[0]!.token).toBe(invocation.token);
  await expect(setup.client.call({ ...pause, action: "resume" })).rejects.toThrow("not verified");
  await releaseServiceInvocation(setup.env, invocation);
  expect((await setup.client.call({ ...pause, action: "resume" })).admission.state).toBe("open");
  const before = [...setup.writes];
  await setup.client.call({ ...pause, action: "resume" });
  expect(setup.writes).toEqual(before);
});

test("service mutation rejects auth, malformed requests and a different runtime version; lost responses do not trigger another request", async () => {
  const setup = await initialized();
  const input = { service_id: setup.config.service_id, action: "resume" as const, pause_id: setup.request.target.operation_id };
  const before = [...setup.writes];
  const wrong = new M6ServiceClient(setup.config, "wrong-key", setup.transport);
  await expect(wrong.call(input)).rejects.toThrow("not verified");
  const request = () => new Request(`${setup.config.public_base_url}/admin/service`, { method: "POST", headers: {
    "X-Castloop-Key": "private-secret", "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const version = setup.env.CASTLOOP_VERSION_METADATA;
  setup.env.CASTLOOP_VERSION_METADATA = { ...version, id: crypto.randomUUID() };
  await expect(setup.client.call(input)).rejects.toThrow("not verified");
  expect((await setup.client.call({ service_id: setup.config.service_id, action: "status" })).worker_version_id).not.toBe(version.id);
  setup.env.CASTLOOP_VERSION_METADATA = version;
  const malformed = request();
  expect((await setup.run(new Request(malformed.url, { method: "POST", headers: malformed.headers, body: JSON.stringify({ ...input, ready: true }) }))).status).toBe(400);
  expect(setup.writes).toEqual(before);
  let calls = 0;
  const lost = new M6ServiceClient(setup.config, "private-secret", async (url, init) => {
    calls += 1; const response = await setup.transport(url, init); await response.body?.cancel(); throw new Error("Response lost");
  });
  await expect(lost.call(input)).rejects.toThrow("outcome is unknown");
  expect(calls).toBe(1);
  expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("open");
});

test("resume CAS rechecks a newly admitted consumer or changed runtime instead of relying on a preflight snapshot", async () => {
  for (const failure of ["consumer", "runtime"] as const) {
    const setup = await initialized();
    const originalGet = setup.bucket.get.bind(setup.bucket);
    let inject = true;
    setup.bucket.get = (async (...args: Parameters<typeof originalGet>) => {
      const object = await originalGet(...args);
      if (args[0] === SERVICE_ADMISSION_KEY && inject) {
        inject = false;
        if (failure === "consumer") await acquireServiceInvocation(setup.env, setup.config.service_id, "m6_consumer");
        else {
          const snapshot = (await readServiceAdmission(setup.env, setup.config.service_id))!;
          await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...snapshot.value, generation: snapshot.value.generation + 1,
            runtime_readiness: { ...snapshot.value.runtime_readiness, worker_version_id: crypto.randomUUID() } }));
        }
      }
      return object;
    }) as typeof setup.bucket.get;
    await expect(setup.client.call({ service_id: setup.config.service_id, action: "resume", pause_id: setup.request.target.operation_id })).rejects.toThrow("not verified");
    const current = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
    expect(current.state).toBe("paused");
    expect(current.invocations).toHaveLength(failure === "consumer" ? 1 : 0);
  }
});
