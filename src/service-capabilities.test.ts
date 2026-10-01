import { describe, expect, test } from "bun:test";
import { serviceCapabilitiesSchema } from "../packages/shared/src/index";
import worker from "./index";
import { acquireServiceInvocation, initializeServiceAdmission, pauseServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { readServiceCapabilities } from "./service-capabilities";
import { runLifecycleMigrationStep } from "./lifecycle-migration-apply";
import { migrationFixture } from "./test-support/migration";

describe("authenticated read-only service capabilities", () => {
  test("uninitialized services report legacy-only capability without creating records", async () => {
    const setup = await migrationFixture();
    setup.entries.delete(SERVICE_ADMISSION_KEY);
    const before = new Map(setup.entries);
    const value = await readServiceCapabilities(setup.env, "service");
    expect(value.admission.state).toBe("uninitialized");
    expect(value.legacy_mutations_admitted).toBe(true);
    expect(value.m6_ready).toBe(false);
    expect(setup.entries).toEqual(before);
  });

  test("admission status reports counts but never invocation tokens or frozen requests", async () => {
    const setup = await migrationFixture();
    setup.entries.delete(SERVICE_ADMISSION_KEY);
    await initializeServiceAdmission(setup.env, "service");
    const invocation = await acquireServiceInvocation(setup.env, "service", "legacy_admin");
    let value = await readServiceCapabilities(setup.env, "service");
    expect(value.admission.active_invocations).toBe(1);
    expect(value.legacy_mutations_admitted).toBe(true);
    expect(JSON.stringify(value)).not.toContain(invocation.token);
    await pauseServiceAdmission(setup.env, "service", crypto.randomUUID());
    value = await readServiceCapabilities(setup.env, "service");
    expect(value.legacy_mutations_admitted).toBe(false);
    expect(value.admission.state).toBe("paused");
  });

  test("mock migration readiness never claims that this Worker exposes M6 routes", async () => {
    const setup = await migrationFixture();
    const migrating = await readServiceCapabilities(setup.env, "service");
    expect(migrating.admission.migration_id).toBe(setup.migrationId);
    expect(migrating.legacy_mutations_admitted).toBe(false);
    for (let index = 0; index < 3; index += 1) await runLifecycleMigrationStep(setup.env, "service", setup.migrationId, setup.effects);
    const value = await readServiceCapabilities(setup.env, "service");
    expect(value.admission.mode).toBe("m6");
    expect(value.m6_ready).toBe(false);
    expect(value.features.lifecycle_delivery).toBe(false);
    expect(value.features.lifecycle_commands).toBe(false);
    expect(value.features.m6_publication).toBe(false);
  });

  test("HTTP requires authentication, is no-store and fails closed on corrupt admission", async () => {
    const setup = await migrationFixture();
    const env = { CASTLOOP_BUCKET: setup.bucket, CASTLOOP_ADMIN_KEY: "test-secret" } as never;
    const request = (secret?: string) => new Request<unknown, IncomingRequestCfProperties>("https://example.workers.dev/admin/capabilities",
      { headers: secret ? { "X-Castloop-Key": secret } : {} });
    const before = new Map(setup.entries);
    expect((await worker.fetch(request(), env)).status).toBe(401);
    const response = await worker.fetch(request("test-secret"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(serviceCapabilitiesSchema.parse(await response.json()).admission.state).toBe("migrating");
    expect(setup.entries).toEqual(before);
    await setup.bucket.put(SERVICE_ADMISSION_KEY, "{}");
    const failed = await worker.fetch(request("test-secret"), env);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("test-secret");
  });

  test("capability schema rejects assertions of unfinished route support and private data", async () => {
    const setup = await migrationFixture();
    const value = await readServiceCapabilities(setup.env, "service");
    for (const changes of [{ m6_ready: true }, { title: "Private title" }, { features: { ...value.features, lifecycle_commands: true } },
      { legacy_mutations_admitted: true }, { admission: { ...value.admission, token: crypto.randomUUID() } }]) {
      expect(serviceCapabilitiesSchema.safeParse({ ...value, ...changes }).success).toBe(false);
    }
  });
});
