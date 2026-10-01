import { describe, expect, test } from "bun:test";
import { cachedDeliveryRuntimeSchema, serviceAdmissionSchema } from "../packages/shared/src/index";
import { createM6DeliveryGate, describeCachedDeliveryRuntime } from "./lifecycle-delivery-gate";
import { runLifecycleMigrationStep } from "./lifecycle-migration-apply";
import { acquireServiceInvocation, initializeServiceAdmission, readServiceAdmission, releaseServiceInvocation, resumeServiceAdmission,
  SERVICE_ADMISSION_KEY } from "./service-admission";
import { migrationFixture } from "./test-support/migration";
import { claimShowOperation, readShowControl } from "./lifecycle-control";
import { commitOwnedLifecycleOperation } from "./lifecycle-commit";
import { consumeLifecycleCommit } from "./lifecycle-consumer";
import { createLifecycleWorkerEffects } from "./lifecycle-worker-effects";

async function fixture() {
  const setup = await migrationFixture();
  for (let index = 0; index < 3; index += 1) await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
  const invocation = await acquireServiceInvocation(setup.env, "service", "m6_consumer");
  const cached = describeCachedDeliveryRuntime({ id: setup.runtime.worker_version_id }, { purge: async () => ({ success: true, errors: [] }) });
  const bindings = { versionMetadata: { id: setup.runtime.worker_version_id }, gatewayProtocol: "m6-uncached-gateway-v1" as const,
    cachedAssets: { describeRuntime: async () => cached } };
  return { ...setup, invocation, cached, bindings, gate: createM6DeliveryGate(setup.env, invocation, bindings) };
}

describe("M6 mutation delivery runtime gate", () => {
  test("paused drain and open invocation require matching verified Worker and cache owner versions", async () => {
    const setup = await fixture();
    const before = new Map(setup.entries);
    await setup.gate({ showId: "daily" });
    await setup.gate({ showId: "daily", episodeId: "first" });
    expect(setup.entries).toEqual(before);
    await resumeServiceAdmission(setup.env, "service", setup.pauseId);
    await setup.gate({ showId: "daily" });
  });

  test("missing migration, foreign executing version, unknown protocol and missing ownership fail closed", async () => {
    const setup = await fixture();
    await expect(createM6DeliveryGate(setup.env, setup.invocation, { ...setup.bindings,
      versionMetadata: { id: crypto.randomUUID() } })({ showId: "daily" })).rejects.toThrow("Executing Worker version");
    await expect(createM6DeliveryGate(setup.env, setup.invocation, { ...setup.bindings,
      gatewayProtocol: "legacy" as never })({ showId: "daily" })).rejects.toThrow("uncached gateway");
    await releaseServiceInvocation(setup.env, setup.invocation);
    await expect(setup.gate({ showId: "daily" })).rejects.toThrow("no longer owns");
    setup.entries.delete(SERVICE_ADMISSION_KEY);
    await expect(setup.gate({ showId: "daily" })).rejects.toThrow("migration readiness");
    await initializeServiceAdmission(setup.env, "service");
    await expect(setup.gate({ showId: "daily" })).rejects.toThrow("migration readiness");
  });

  test("wrong cache owner, missing purge support, arbitrary metadata and RPC failure cannot bless writes", async () => {
    const setup = await fixture();
    for (const value of [{ ...setup.cached, worker_version_id: crypto.randomUUID() }, { ...setup.cached, entrypoint: "Other" },
      { ...setup.cached, purge_api_available: false }, { ...setup.cached, title: "Private title" }, {}]) {
      await expect(createM6DeliveryGate(setup.env, setup.invocation, { ...setup.bindings,
        cachedAssets: { describeRuntime: async () => value } })({ showId: "daily" })).rejects.toThrow();
    }
    await expect(createM6DeliveryGate(setup.env, setup.invocation, { ...setup.bindings, cachedAssets: {
      describeRuntime: async () => { throw new Error("Cache owner unavailable"); },
    } })({ showId: "daily" })).rejects.toThrow("unavailable");
  });

  test("ownership and readiness are rechecked after awaited cache owner RPC", async () => {
    for (const change of ["release", "readiness", "pause"] as const) {
      const setup = await fixture();
      const started = Promise.withResolvers<void>();
      const ended = Promise.withResolvers<void>();
      const gate = createM6DeliveryGate(setup.env, setup.invocation, { ...setup.bindings, cachedAssets: {
        describeRuntime: async () => { started.resolve(); await ended.promise; return setup.cached; },
      } });
      const outcome = (async () => { try { await gate({ showId: "daily" }); return null; } catch (error) { return error; } })();
      await started.promise;
      if (change === "release") await releaseServiceInvocation(setup.env, setup.invocation);
      if (change === "readiness") {
        const value = (await readServiceAdmission(setup.env, "service"))!.value;
        await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify(serviceAdmissionSchema.parse({ ...value,
          readiness: { ...value.readiness, deployment_id: crypto.randomUUID() } })));
      }
      if (change === "pause") await resumeServiceAdmission(setup.env, "service", setup.pauseId);
      ended.resolve();
      const error = await outcome;
      if (change === "pause") expect(error).toBeNull();
      else expect(error).toBeInstanceOf(Error);
    }
  });

  test("legacy tokens, malformed records and invalid target IDs are rejected without cache calls", async () => {
    const setup = await fixture();
    let calls = 0;
    const bindings = { ...setup.bindings, cachedAssets: { describeRuntime: async () => { calls += 1; return setup.cached; } } };
    const gate = createM6DeliveryGate(setup.env, setup.invocation, bindings);
    await expect(gate({ showId: "../private" })).rejects.toThrow();
    await expect(gate({ showId: "daily", episodeId: "BAD" })).rejects.toThrow();
    await expect(createM6DeliveryGate(setup.env, { ...setup.invocation, kind: "legacy_consumer" }, bindings)({ showId: "daily" }))
      .rejects.toThrow("registered M6");
    await setup.bucket.put(SERVICE_ADMISSION_KEY, "{}");
    await expect(gate({ showId: "daily" })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("cached runtime identity requires runtime metadata and purge API; identity is not a configuration probe", () => {
    const cache = { purge: async () => ({ success: true, errors: [] }) };
    expect(() => describeCachedDeliveryRuntime(undefined, cache)).toThrow();
    expect(() => describeCachedDeliveryRuntime({ id: crypto.randomUUID() }, undefined)).toThrow("purge API");
    expect(() => describeCachedDeliveryRuntime({ id: "unknown" }, cache)).toThrow();
    const value = describeCachedDeliveryRuntime({ id: crypto.randomUUID() }, cache);
    expect(cachedDeliveryRuntimeSchema.safeParse(value).success).toBe(true);
    expect(JSON.stringify(value)).not.toContain("default_cache_disabled");
    expect(JSON.stringify(value)).not.toContain("cutover_verified");
  });

  test("lifecycle consumer rejects a foreign runtime before visibility or payload side effects", async () => {
    for (const valid of [false, true]) {
      const setup = await fixture();
      const jobId = crypto.randomUUID();
      const control = await claimShowOperation(setup.env, { schema_version: 1, kind: "show", action: "unpublish", job_id: jobId,
        show_id: "daily", expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z" });
      const operation = { showId: "daily", jobId, generation: control.value.generation };
      const marker = await commitOwnedLifecycleOperation(setup.env, operation);
      const before = new Map(setup.entries);
      let purges = 0;
      const gate = createM6DeliveryGate(setup.env, setup.invocation, { ...setup.bindings, cachedAssets: {
        describeRuntime: async () => valid ? setup.cached : { ...setup.cached, worker_version_id: crypto.randomUUID() },
      } });
      const outcome = consumeLifecycleCommit(setup.env, marker.key, (execution) => createLifecycleWorkerEffects(setup.env, execution, {
        checkDeliveryGate: gate, cachedAssets: { invalidate: async () => { purges += 1; } }, queue: { send: async () => {} } as never,
      }));
      if (valid) {
        expect(await outcome).toEqual({ state: "completed" });
        expect((await readShowControl(setup.env, "daily"))!.value.lifecycle).toBe("unpublished");
        expect(purges).toBe(1);
      } else {
        await expect(outcome).rejects.toThrow("Cache owner runtime");
        const current = (await readShowControl(setup.env, "daily"))!.value;
        expect(current.lifecycle).toBe("active");
        expect(current.owner?.execution_id).toBeUndefined();
        expect(current.owner?.job_id).toBe(jobId);
        expect(purges).toBe(0);
      }
      for (const [key, entry] of before) if (key.startsWith("public/") || key.startsWith("system/shows/")) expect(setup.entries.get(key)).toEqual(entry);
    }
  });
});
