import { describe, expect, test } from "bun:test";
import { serviceAdmissionSchema, serviceMigrationRequestSchema } from "../packages/shared/src/index";
import { abortUnstartedServiceMigration, acquireServiceInvocation, acquireServiceMigrationExecution, claimServiceMigration,
  initializeServiceAdmission, pauseServiceAdmission, readServiceAdmission, releaseServiceInvocation, releaseServiceMigrationExecution,
  requireServiceInvocation, resumeServiceAdmission, SERVICE_ADMISSION_KEY, withServiceInvocation } from "./service-admission";
import { lifecycleFixture } from "./test-support/lifecycle";

async function fixture() {
  const setup = await lifecycleFixture();
  await initializeServiceAdmission(setup.env, "service");
  const pauseId = crypto.randomUUID();
  async function request() {
    const current = (await readServiceAdmission(setup.env, "service"))!.value;
    return serviceMigrationRequestSchema.parse({ schema_version: 1, service_id: "service", migration_id: crypto.randomUUID(),
      pause_id: pauseId, expected_service_generation: current.generation, created_at: "2026-10-01T12:00:00Z" });
  }
  return { ...setup, pauseId, request };
}

describe("M6 atomic service mutation and migration admission", () => {
  test("initialization preserves existing controls and rejects malformed/cross-service records", async () => {
    const setup = await fixture();
    const before = new Map(setup.entries);
    await initializeServiceAdmission(setup.env, "service");
    expect(setup.entries).toEqual(before);
    await expect(initializeServiceAdmission(setup.env, "other")).rejects.toThrow("another service");
    await setup.bucket.put(SERVICE_ADMISSION_KEY, "{}");
    await expect(acquireServiceInvocation(setup.env, "service", "legacy_admin")).rejects.toThrow();
  });

  test("concurrent registry CAS retains every token and each caller can return only its own", async () => {
    const setup = await fixture();
    const invocations = await Promise.all(Array.from({ length: 12 }, () => acquireServiceInvocation(setup.env, "service", "legacy_admin")));
    expect(new Set(invocations.map((invocation) => invocation.token)).size).toBe(12);
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toHaveLength(12);
    await expect(releaseServiceInvocation(setup.env, { ...invocations[0]!, kind: "legacy_consumer" })).rejects.toThrow("another invocation kind");
    await Promise.all(invocations.map((invocation) => releaseServiceInvocation(setup.env, invocation)));
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
  });

  test("pause fences new administrative writes, drains live invocations and allows legacy consumer completion", async () => {
    const setup = await fixture();
    const invocation = await acquireServiceInvocation(setup.env, "service", "legacy_admin");
    await pauseServiceAdmission(setup.env, "service", setup.pauseId);
    await requireServiceInvocation(setup.env, invocation);
    await expect(acquireServiceInvocation(setup.env, "service", "legacy_admin")).rejects.toThrow("not admitting");
    const consumer = await acquireServiceInvocation(setup.env, "service", "legacy_consumer");
    await expect(claimServiceMigration(setup.env, await setup.request())).rejects.toThrow("no live");
    await releaseServiceInvocation(setup.env, invocation);
    await releaseServiceInvocation(setup.env, consumer);
    const request = await setup.request();
    await claimServiceMigration(setup.env, request);
    await expect(acquireServiceInvocation(setup.env, "service", "legacy_consumer")).rejects.toThrow("not admitting");
    await expect(resumeServiceAdmission(setup.env, "service", setup.pauseId)).rejects.toThrow("Only the current pause");
    expect((await readServiceAdmission(setup.env, "service"))?.value.state).toBe("migrating");
  });

  test("migration and late consumer CAS race cannot coexist", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const setup = await fixture();
      await pauseServiceAdmission(setup.env, "service", setup.pauseId);
      const request = await setup.request();
      const results = await Promise.allSettled([claimServiceMigration(setup.env, request), acquireServiceInvocation(setup.env, "service", "legacy_consumer")]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const control = (await readServiceAdmission(setup.env, "service"))!.value;
      expect(control.state === "migrating" ? control.invocations.length === 0 : control.invocations.length === 1).toBe(true);
    }
  });

  test("live callbacks are awaited before token return, even on exception", async () => {
    const setup = await fixture();
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const outcome = (async () => {
      try { await withServiceInvocation(setup.env, "service", "legacy_admin", async () => {
        started.resolve(); await ended.promise; throw new Error("Callback failed");
      }); return null; } catch (error) { return error; }
    })();
    await started.promise;
    await pauseServiceAdmission(setup.env, "service", setup.pauseId);
    await expect(claimServiceMigration(setup.env, await setup.request())).rejects.toThrow("no live");
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toHaveLength(1);
    ended.resolve();
    expect((await outcome as Error).message).toBe("Callback failed");
    expect((await readServiceAdmission(setup.env, "service"))?.value.invocations).toEqual([]);
  });

  test("pause/resume response losses retain ownership receipts, and unknown acquisition blocks migration", async () => {
    for (const fault of ["pause", "resume", "acquire"] as const) {
      const setup = await fixture();
      let lost = false;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        const written = await setup.bucket.put(...args);
        const value = args[0] === SERVICE_ADMISSION_KEY ? serviceAdmissionSchema.parse(JSON.parse(args[1])) : null;
        const matches = fault === "pause" ? value?.state === "paused" : fault === "resume" ? value?.last_resumed_pause_id === setup.pauseId : value?.invocations.length === 1;
        if (!lost && written && matches) { lost = true; throw new Error("Service response lost"); }
        return written;
      } } } as never;
      if (fault === "acquire") {
        await expect(acquireServiceInvocation(env, "service", "legacy_admin")).rejects.toThrow("response lost");
        await pauseServiceAdmission(env, "service", setup.pauseId);
        await expect(claimServiceMigration(env, await setup.request())).rejects.toThrow("no live");
      } else {
        if (fault === "pause") await expect(pauseServiceAdmission(env, "service", setup.pauseId)).rejects.toThrow("response lost");
        await pauseServiceAdmission(env, "service", setup.pauseId);
        if (fault === "resume") await expect(resumeServiceAdmission(env, "service", setup.pauseId)).rejects.toThrow("response lost");
        await resumeServiceAdmission(env, "service", setup.pauseId);
        expect((await readServiceAdmission(env, "service"))?.value.state).toBe("open");
        await expect(pauseServiceAdmission(env, "service", setup.pauseId)).rejects.toThrow("cannot be reused");
      }
    }
  });

  test("migration invocation tokens are exclusive and idle unstarted abort permanently stales the old request", async () => {
    const setup = await fixture();
    await pauseServiceAdmission(setup.env, "service", setup.pauseId);
    const request = await setup.request();
    await claimServiceMigration(setup.env, request);
    await claimServiceMigration(setup.env, request);
    const execution = await acquireServiceMigrationExecution(setup.env, "service", request.migration_id);
    await expect(acquireServiceMigrationExecution(setup.env, "service", request.migration_id)).rejects.toThrow("still running");
    await expect(abortUnstartedServiceMigration(setup.env, "service", request.migration_id)).rejects.toThrow("idle unstarted");
    await releaseServiceMigrationExecution(setup.env, execution);
    await abortUnstartedServiceMigration(setup.env, "service", request.migration_id);
    expect((await readServiceAdmission(setup.env, "service"))?.value.state).toBe("paused");
    await expect(claimServiceMigration(setup.env, request)).rejects.toThrow("changed before");
    await expect(claimServiceMigration(setup.env, { ...request, expected_service_generation: (await readServiceAdmission(setup.env, "service"))!.value.generation }))
      .rejects.toThrow("different frozen request");
  });

  test("migration execution response loss remains blocked without unsafe timeout recovery", async () => {
    const setup = await fixture();
    await pauseServiceAdmission(setup.env, "service", setup.pauseId);
    const request = await setup.request();
    await claimServiceMigration(setup.env, request);
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      const written = await setup.bucket.put(...args);
      if (written && args[0] === SERVICE_ADMISSION_KEY && args[1].includes('"execution_id"')) throw new Error("Migration execution response lost");
      return written;
    } } } as never;
    await expect(acquireServiceMigrationExecution(env, "service", request.migration_id)).rejects.toThrow("response lost");
    await expect(acquireServiceMigrationExecution(setup.env, "service", request.migration_id)).rejects.toThrow("still running");
    await expect(abortUnstartedServiceMigration(setup.env, "service", request.migration_id)).rejects.toThrow("idle unstarted");
  });

  test("readiness, migration/lease coexistence and retained diagnostic fields are strict", async () => {
    const base = { schema_version: 1, service_id: "service", generation: 0, mode: "legacy", state: "open", invocations: [] };
    for (const invalid of [{ title: "Private" }, { mode: "m6" }, { state: "migrating", pause_id: crypto.randomUUID() },
      { pause_id: crypto.randomUUID() }, { invocations: [{ token: crypto.randomUUID(), kind: "legacy_admin", secret: "token" }] }]) {
      expect(serviceAdmissionSchema.safeParse({ ...base, ...invalid }).success).toBe(false);
    }
  });
});
