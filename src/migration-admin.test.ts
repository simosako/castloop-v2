import { describe, expect, test } from "bun:test";
import { migrationApplyProgressSchema, migrationBootstrapSchema } from "../packages/shared/src/index";
import { handleMigrationAdmin } from "./migration-admin";
import type { BootstrapRuntime } from "./migration-bootstrap";
import { readServiceAdmission, SERVICE_ADMISSION_KEY } from "./service-admission";
import { bootstrapFixture } from "./test-support/bootstrap";

type Setup = Awaited<ReturnType<typeof bootstrapFixture>>;
async function call(setup: Setup, route: string, input?: object, runtime: BootstrapRuntime = setup.bridge): Promise<Response> {
  const request = new Request(`https://current.example/admin/migration/${route}`, { method: input ? "POST" : "GET",
    headers: { "X-Castloop-Key": "private-key" }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const result = await handleMigrationAdmin(request, setup.env, runtime);
  if (!result) throw new Error("Migration route was not handled");
  return result;
}
const identity = (setup: Setup) => ({ schema_version: 1, service_id: "service", migration_id: setup.migrationId });

describe("authenticated migration bridge/candidate control API", () => {
  test("authentication/method/path/input validation performs no mutation and returns no-store fixed diagnostics", async () => {
    const setup = await bootstrapFixture(false);
    const before = new Map(setup.entries);
    const responses = [
      await handleMigrationAdmin(new Request("https://current.example/admin/migration/pause", { method: "POST", body: "{}" }), setup.env, setup.bridge),
      await call(setup, "unknown"), await call(setup, "pause"),
      await call(setup, "pause", { schema_version: 1, service_id: "another", pause_id: crypto.randomUUID() }),
      await call(setup, "pause", { schema_version: 1, service_id: "service", pause_id: "wrong", token: "private" }),
    ];
    expect(responses.map((response) => response?.status)).toEqual([401, 404, 405, 400, 400]);
    for (const response of responses) expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(setup.entries).toEqual(before);
    expect(await handleMigrationAdmin(new Request("https://current.example/admin/health"), setup.env, setup.bridge)).toBeNull();
  });

  test("chunked oversized/malformed request bodies are bounded before mutations", async () => {
    const setup = await bootstrapFixture(false);
    const before = new Map(setup.entries);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(9000)); }, cancel() { cancelled = true; } });
    const response = await handleMigrationAdmin(new Request("https://current.example/admin/migration/pause", { method: "POST",
      headers: { "X-Castloop-Key": "private-key" }, body: stream }), setup.env, setup.bridge);
    expect(response?.status).toBe(400);
    expect(cancelled).toBe(true);
    for (const body of ["{", '"private-json-text"', "null", "[]"]) {
      const result = await handleMigrationAdmin(new Request("https://current.example/admin/migration/pause", { method: "POST",
        headers: { "X-Castloop-Key": "private-key" }, body }), setup.env, setup.bridge);
      expect(result?.status).toBe(400);
      expect(await result?.text()).not.toContain("private-json-text");
    }
    expect(setup.entries).toEqual(before);
  });

  test("bridge pause/claim allows only drained admission and abort/resume only unstarted legacy migrations", async () => {
    const setup = await bootstrapFixture(false);
    setup.entries.delete(SERVICE_ADMISSION_KEY);
    expect((await call(setup, "initialize-admission", { schema_version: 1, service_id: "service" })).status).toBe(200);
    const pauseId = crypto.randomUUID();
    const pause = { schema_version: 1, service_id: "service", pause_id: pauseId };
    expect((await call(setup, "pause", pause)).status).toBe(200);
    const migrationId = crypto.randomUUID();
    const claim = { ...pause, migration_id: migrationId, expected_service_generation: (await readServiceAdmission(setup.env, "service"))!.value.generation,
      created_at: "2026-10-01T12:00:00Z" };
    expect((await call(setup, "claim", claim)).status).toBe(200);
    expect((await call(setup, "resume-legacy", pause)).status).toBe(409);
    expect((await call(setup, "abort-unstarted", { schema_version: 1, service_id: "service", migration_id: migrationId })).status).toBe(200);
    expect((await call(setup, "resume-legacy", pause)).status).toBe(200);
    expect((await readServiceAdmission(setup.env, "service"))!.value.state).toBe("open");
    expect((await call(setup, "pause", { ...pause, pause_id: crypto.randomUUID() }, setup.candidate)).status).toBe(409);
  });

  test("apply refuses missing quiescence then initializes without marking M6 complete or enabling writes", async () => {
    const setup = await bootstrapFixture(false);
    const input = { ...identity(setup), maximum_targets: 1 };
    expect((await call(setup, "apply", input)).status).toBe(409);
    expect((await call(setup, "quiescence", setup.quiescence)).status).toBe(200);
    for (let index = 0; index < 4; index += 1) expect((await call(setup, "apply", input)).status).toBe(200);
    const progress = migrationApplyProgressSchema.parse(JSON.parse(setup.entries.get(`system/lifecycle-migrations/${setup.migrationId}/progress.json`)!.data));
    expect(progress.phase).toBe("runtime");
    expect(progress.runtime).toBeUndefined();
    expect((await call(setup, "resume-legacy", { schema_version: 1, service_id: "service", pause_id: setup.pauseId })).status).toBe(409);
    expect((await call(setup, "abort-unstarted", identity(setup))).status).toBe(409);
    expect((await call(setup, "complete", identity(setup))).status).toBe(404);
    const admission = (await readServiceAdmission(setup.env, "service"))!.value;
    expect(admission.migration!.execution_id).toBeUndefined();
    expect(admission.mode).toBe("legacy");
    expect(admission.readiness).toBeUndefined();
  });

  test("bootstrap API performs freeze/start/settle/bounded probes but never returns completion booleans", async () => {
    const setup = await bootstrapFixture();
    expect((await call(setup, "prepare-deployment", setup.bootstrapRequest)).status).toBe(200);
    expect((await call(setup, "begin-deployment", { ...identity(setup), bootstrap_id: setup.bootstrapRequest.bootstrap_id })).status).toBe(200);
    expect((await call(setup, "begin-deployment", { ...identity(setup), bootstrap_id: setup.bootstrapRequest.bootstrap_id })).status).toBe(409);
    expect((await call(setup, "settle-deployment", { ...identity(setup), settlement: setup.settlement }, setup.candidate)).status).toBe(200);
    for (let index = 0; index < 3; index += 1) expect((await call(setup, "verify-delivery", { ...identity(setup), maximum_assets: 1 }, setup.candidate)).status).toBe(200);
    const record = migrationBootstrapSchema.parse(JSON.parse(setup.entries.get(setup.bootstrapKey)!.data));
    expect(record.phase).toBe("verified");
    const response = await call(setup, "status", undefined, setup.candidate);
    expect(response.status).toBe(200);
    const data = await response.text();
    expect(data).toContain('"m6_ready":false');
    for (const field of ["private-key", "Private episode", "Private description", "cutover_verified", "publication_routes_verified"]) expect(data).not.toContain(field);
    expect((await readServiceAdmission(setup.env, "service"))!.value.migration!.execution_id).toBeUndefined();
    expect((await call(setup, "apply", identity(setup), setup.candidate)).status).toBe(409);
  });

  test("candidate settlement requires the executing version's frozen bootstrap tag", async () => {
    const setup = await bootstrapFixture();
    await call(setup, "prepare-deployment", setup.bootstrapRequest);
    await call(setup, "begin-deployment", { ...identity(setup), bootstrap_id: setup.bootstrapRequest.bootstrap_id });
    const before = setup.entries.get(setup.bootstrapKey)!.data;
    for (const workerBootstrapId of [undefined, crypto.randomUUID()]) {
      const runtime = { ...setup.candidate, workerBootstrapId };
      expect((await call(setup, "settle-deployment", { ...identity(setup), settlement: setup.settlement }, runtime)).status).toBe(409);
      expect(setup.entries.get(setup.bootstrapKey)!.data).toBe(before);
      expect((await readServiceAdmission(setup.env, "service"))!.value.migration!.delivery_candidate).toBeUndefined();
    }
    expect((await call(setup, "settle-deployment", { ...identity(setup), settlement: setup.settlement }, setup.candidate)).status).toBe(200);
  });

  test("concurrent/live verification keeps its invocation token until HTTP promises settle", async () => {
    const setup = await bootstrapFixture();
    await call(setup, "prepare-deployment", setup.bootstrapRequest);
    await call(setup, "begin-deployment", { ...identity(setup), bootstrap_id: setup.bootstrapRequest.bootstrap_id });
    await call(setup, "settle-deployment", { ...identity(setup), settlement: setup.settlement }, setup.candidate);
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const runtime = { ...setup.candidate, defaultFetch: async (request: Request) => {
      started.resolve(); await ended.promise; return setup.candidate.defaultFetch!(request);
    } };
    const pending = call(setup, "verify-delivery", { ...identity(setup), maximum_assets: 1 }, runtime);
    await started.promise;
    const token = (await readServiceAdmission(setup.env, "service"))!.value.migration!.execution_id;
    expect(token).toBeDefined();
    expect((await call(setup, "verify-delivery", { ...identity(setup), maximum_assets: 1 }, setup.candidate)).status).toBe(409);
    expect((await readServiceAdmission(setup.env, "service"))!.value.migration!.execution_id).toBe(token);
    ended.resolve();
    expect((await pending).status).toBe(200);
    expect((await readServiceAdmission(setup.env, "service"))!.value.migration!.execution_id).toBeUndefined();
  });
});
