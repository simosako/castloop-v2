import { expect, test } from "bun:test";
import { serviceAdmissionSchema } from "../packages/shared/src/index";
import { createM6DeliveryGate, describeCachedDeliveryRuntime } from "./lifecycle-delivery-gate";
import { completeM6ServiceInitialization, prepareM6ServiceInitialization } from "./m6-service-initialization";
import { acquireServiceInvocation, readServiceAdmission, releaseServiceInvocation, requireM6ServiceRuntime,
  resumeServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { readServiceCapabilities } from "./service-capabilities";
import { m6InitializationFixture as fixture } from "./test-support/m6-initialization";
import { PUBLICATION_SERVICE_TEXT } from "./test-support/publication";

test("fresh M6 initialization starts closed, verifies its runtime and completes paused without legacy migration records", async () => {
  const setup = await fixture();
  await prepareM6ServiceInitialization(setup.env, setup.target);
  const pending = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
  expect(pending.state).toBe("initializing");
  expect(pending.initialization).toEqual(setup.target);
  expect(pending.readiness).toBeUndefined();
  expect(pending.runtime_readiness).toBeUndefined();
  for (const kind of ["legacy_admin", "legacy_consumer", "m6_admin", "m6_consumer", "m6_recovery"] as const) {
    await expect(acquireServiceInvocation(setup.env, setup.config.service_id, kind)).rejects.toThrow("not admitting");
  }
  await expect(requireM6ServiceRuntime(setup.env, setup.config.service_id, setup.target.worker_version_id)).rejects.toThrow("readiness");
  expect((await readServiceCapabilities(setup.env, setup.config.service_id, "m6_candidate")).m6_ready).toBe(false);
  expect(await completeM6ServiceInitialization(setup.env, setup.target, setup.checks)).toEqual(setup.readiness);
  const completed = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
  expect(completed.state).toBe("paused");
  expect(completed.initialization).toBeUndefined();
  expect(completed.runtime_readiness).toEqual(setup.readiness);
  expect(completed.readiness).toBeUndefined();
  expect([...setup.entries.keys()].sort()).toEqual([SERVICE_ADMISSION_KEY, "system/service.toml"].sort());
  const before = [...setup.writes];
  await prepareM6ServiceInitialization(setup.env, setup.target);
  await completeM6ServiceInitialization(setup.env, setup.target, { inspectDeployment: async () => { throw new Error("No reinspection"); },
    verifyRuntime: async () => { throw new Error("No reactivation"); } });
  expect(setup.writes).toEqual(before);
  await expect(acquireServiceInvocation(setup.env, setup.config.service_id, "m6_admin")).rejects.toThrow("not admitting");
  await resumeServiceAdmission(setup.env, setup.config.service_id, setup.target.operation_id);
  const invocation = await acquireServiceInvocation(setup.env, setup.config.service_id, "m6_admin");
  await createM6DeliveryGate(setup.env, invocation, { versionMetadata: { id: setup.target.worker_version_id },
    gatewayProtocol: "m6-uncached-gateway-v1", cachedAssets: { describeRuntime: async () => describeCachedDeliveryRuntime(
      { id: setup.target.worker_version_id }, { purge: async () => ({ success: true, errors: [] }) }) } })({ showId: "fresh" });
  await releaseServiceInvocation(setup.env, invocation);
  await expect(requireM6ServiceRuntime(setup.env, setup.config.service_id, crypto.randomUUID())).rejects.toThrow("Worker version");
});

test("fresh initialization rejects retained data, legacy admission and different permanent targets", async () => {
  for (const key of ["public/podcasts/old/feed.xml", "system/show-publications/old.json", "system/jobs/retained/status.toml"]) {
    const setup = await fixture();
    await setup.bucket.put(key, "retained");
    const before = new Map(setup.entries);
    await expect(prepareM6ServiceInitialization(setup.env, setup.target)).rejects.toThrow("empty service");
    expect(setup.entries).toEqual(before);
  }
  const setup = await fixture();
  await prepareM6ServiceInitialization(setup.env, setup.target);
  await expect(prepareM6ServiceInitialization(setup.env, { ...setup.target, operation_id: crypto.randomUUID() })).rejects.toThrow("different permanent");
  await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ schema_version: 1, service_id: setup.config.service_id, generation: 0,
    mode: "legacy", state: "open", invocations: [] }));
  await expect(prepareM6ServiceInitialization(setup.env, setup.target)).rejects.toThrow("different permanent");
});

test("competing fresh initialization targets cannot replace the winning CAS owner", async () => {
  const setup = await fixture();
  const other = { ...setup.target, operation_id: crypto.randomUUID() };
  const results = await Promise.allSettled([prepareM6ServiceInitialization(setup.env, setup.target), prepareM6ServiceInitialization(setup.env, other)]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const owner = (await readServiceAdmission(setup.env, setup.config.service_id))!.value.initialization!;
  const foreign = owner.operation_id === setup.target.operation_id ? other : setup.target;
  await expect(completeM6ServiceInitialization(setup.env, foreign, setup.checks)).rejects.toThrow("exact retained");
});

test("incomplete or foreign runtime/deployment evidence leaves fresh initialization closed", async () => {
  for (const invalid of ["routes", "version", "deployment", "cache", "lost-response"] as const) {
    const setup = await fixture();
    await prepareM6ServiceInitialization(setup.env, setup.target);
    const before = new Map(setup.entries);
    await expect(completeM6ServiceInitialization(setup.env, setup.target, {
      inspectDeployment: async () => invalid === "deployment" ? { ...setup.deployment, deployment_id: crypto.randomUUID() } : setup.deployment,
      verifyRuntime: async () => {
        if (invalid === "lost-response") throw new Error("Verification response lost");
        return { ...setup.readiness, ...(invalid === "routes" ? { publication_routes_verified: false } : {}),
          ...(invalid === "version" ? { worker_version_id: crypto.randomUUID() } : {}), ...(invalid === "cache" ? { default_cache_disabled: false } : {}) };
      },
    })).rejects.toThrow();
    expect(setup.entries).toEqual(before);
    expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.state).toBe("initializing");
  }
});

test("configuration, inventory, deployment or admission changes during verification cannot activate the service", async () => {
  for (const change of ["config", "inventory", "deployment", "admission"] as const) {
    const setup = await fixture();
    await prepareM6ServiceInitialization(setup.env, setup.target);
    let inspections = 0;
    await expect(completeM6ServiceInitialization(setup.env, setup.target, {
      inspectDeployment: async () => ++inspections > 1 && change === "deployment" ? { ...setup.deployment, deployment_id: crypto.randomUUID() } : setup.deployment,
      verifyRuntime: async () => {
        if (change === "config") await setup.bucket.put("system/service.toml", `${PUBLICATION_SERVICE_TEXT}\n`);
        if (change === "inventory") await setup.bucket.put("staging/foreign.json", "foreign");
        if (change === "admission") await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify({ ...(await readServiceAdmission(setup.env, setup.config.service_id))!.value,
          generation: 1, initialization: { ...setup.target, operation_id: crypto.randomUUID() } }));
        return setup.readiness;
      },
    })).rejects.toThrow();
    expect((await readServiceAdmission(setup.env, setup.config.service_id))!.value.runtime_readiness).toBeUndefined();
  }
});

test("initializing admission cannot carry a forged readiness, pause owner or invocation", async () => {
  const setup = await fixture();
  await prepareM6ServiceInitialization(setup.env, setup.target);
  const value = (await readServiceAdmission(setup.env, setup.config.service_id))!.value;
  for (const patch of [{ runtime_readiness: setup.readiness }, { pause_id: crypto.randomUUID() }, { initialization: undefined },
    { invocations: [{ token: crypto.randomUUID(), kind: "m6_admin" }] }, { mode: "legacy" }]) {
    expect(() => serviceAdmissionSchema.parse({ ...value, ...patch })).toThrow();
  }
});
