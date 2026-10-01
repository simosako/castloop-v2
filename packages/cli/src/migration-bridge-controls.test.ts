import { describe, expect, test } from "bun:test";
import { migrationBridgeDeploymentEvidenceSchema, parseServiceConfig } from "@castloop/shared";
import { MigrationAdminClient } from "./migration-client";
import { bootstrapFixture } from "../../../src/test-support/bootstrap";
import { handleMigrationAdmin } from "../../../src/migration-admin";
import { acquireServiceMigrationExecution, SERVICE_ADMISSION_KEY } from "../../../src/service-admission";

async function fixture() {
  const setup = await bootstrapFixture(false);
  const config = parseServiceConfig(setup.entries.get("system/service.toml")!.data);
  const runtime = { ...setup.bridge, workerBridgeId: crypto.randomUUID() };
  const evidence = migrationBridgeDeploymentEvidenceSchema.parse({ schema_version: 1, service_id: config.service_id,
    account_id: config.account_id, worker_name: config.worker_name, bridge_id: runtime.workerBridgeId,
    deployment_id: crypto.randomUUID(), worker_version_id: setup.bridgeVersion, compatibility_date: "2026-10-01", traffic_percentage: 100,
    default_cache_disabled: true, cross_version_cache_disabled: true, version_metadata_binding_verified: true,
    service_bindings_verified: true, observability_enabled: true, workers_dev_previews_disabled: true });
  const calls: Request[] = [];
  let loseRoute: string | undefined;
  let malformedResponse: object | undefined;
  const transport = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const request = new Request(input, init);
    calls.push(request.clone());
    expect(init?.redirect).toBe("error");
    const response = await handleMigrationAdmin(request, setup.env, runtime);
    if (!response) throw new Error("Unexpected route");
    if (request.method === "POST" && request.url.endsWith(`/${loseRoute}`)) throw new Error("Operation response lost after server finished");
    if (request.method === "POST" && malformedResponse) return Response.json(malformedResponse, { headers: { "Cache-Control": "no-store" } });
    return response;
  }, { preconnect: () => {} });
  const client = new MigrationAdminClient(config, "private-key", transport);
  return { ...setup, config, runtime, evidence, calls, client, setLostRoute: (route?: string) => { loseRoute = route; },
    setResponse: (response?: object) => { malformedResponse = response; } };
}

describe("explicit expected-bridge migration administration client", () => {
  test("initialize/pause/claim/quiescence/bounded apply reaches runtime but never completes or reopens service", async () => {
    const setup = await fixture();
    setup.entries.delete(SERVICE_ADMISSION_KEY);
    await setup.client.initializeAdmission(setup.evidence);
    const pauseId = crypto.randomUUID();
    await setup.client.pauseAdmission(setup.evidence, pauseId);
    const status = await setup.client.status();
    const migrationId = crypto.randomUUID();
    const request = { schema_version: 1 as const, service_id: setup.config.service_id, migration_id: migrationId,
      pause_id: pauseId, expected_service_generation: status.admission!.generation, created_at: "2026-10-02T12:00:00Z" };
    await setup.client.claimMigration(setup.evidence, request);
    const owner = await setup.client.status();
    await setup.client.confirmQuiescence(setup.evidence, { schema_version: 1, service_id: setup.config.service_id, migration_id: migrationId,
      request_sha256: owner.admission!.migration!.request_sha256, bridge_worker_version_id: setup.bridgeVersion,
      confirmed_at: "2026-10-02T12:00:00Z", old_admin_clients_stopped: true, old_worker_invocations_settled: true,
      old_rest_puts_settled: true, no_more_legacy_writes: true });
    expect(await setup.client.initializeMigrationStep(setup.evidence, migrationId, 1)).toEqual({ state: "pending", phase: "applying" });
    expect(await setup.client.initializeMigrationStep(setup.evidence, migrationId, 1)).toEqual({ state: "pending", phase: "verifying" });
    expect(await setup.client.initializeMigrationStep(setup.evidence, migrationId, 1)).toEqual({ state: "pending", phase: "runtime" });
    const before = setup.calls.length;
    expect(await setup.client.initializeMigrationStep(setup.evidence, migrationId, 1)).toEqual({ state: "pending", phase: "runtime" });
    expect(setup.calls.slice(before).map((call) => call.method)).toEqual(["GET", "POST"]);
    const result = await setup.client.status();
    expect(result.admission?.state).toBe("migrating");
    expect(result.admission?.mode).toBe("legacy");
    expect(result.admission?.readiness).toBeUndefined();
    expect(result.progress?.runtime).toBeUndefined();
    expect(result.m6_ready).toBe(false);
    await expect(setup.client.resumeLegacyAdmission(setup.evidence, pauseId)).rejects.toThrow("HTTP 409");
    await expect(setup.client.abortUnstartedMigration(setup.evidence, migrationId)).rejects.toThrow("HTTP 409");
    expect(setup.calls.some((call) => call.url.endsWith("/complete"))).toBe(false);
  });

  test("limited abort/resume is explicit and only available before initialization plan exists", async () => {
    const setup = await fixture();
    await setup.client.abortUnstartedMigration(setup.evidence, setup.migrationId);
    expect((await setup.client.status()).admission?.state).toBe("paused");
    await setup.client.resumeLegacyAdmission(setup.evidence, setup.pauseId);
    expect((await setup.client.status()).admission?.state).toBe("open");
    expect((await setup.client.status()).m6_ready).toBe(false);
  });

  test("foreign receipt/request and invalid step limits are rejected before any HTTP", async () => {
    const setup = await fixture();
    await expect(setup.client.initializeAdmission({ ...setup.evidence, worker_name: "another-worker" })).rejects.toThrow("another service");
    await expect(setup.client.pauseAdmission(setup.evidence, "invalid")).rejects.toThrow();
    await expect(setup.client.claimMigration(setup.evidence, { schema_version: 1, service_id: "another", migration_id: crypto.randomUUID(),
      pause_id: setup.pauseId, expected_service_generation: 0, created_at: "2026-10-02T12:00:00Z" })).rejects.toThrow("another service");
    for (const maximum of [0, 101, 1.5]) await expect(setup.client.initializeMigrationStep(setup.evidence, setup.migrationId, maximum)).rejects.toThrow();
    await expect(setup.client.confirmQuiescence(setup.evidence, { ...setup.quiescence, schema_version: 1,
      old_admin_clients_stopped: true, old_worker_invocations_settled: true, old_rest_puts_settled: true, no_more_legacy_writes: true,
      bridge_worker_version_id: crypto.randomUUID() })).rejects.toThrow("another bridge version");
    expect(setup.calls).toEqual([]);
  });

  test("different executing bridge version/tag or an active migration token prevents POST", async () => {
    for (const change of ["version", "tag", "token"] as const) {
      const setup = await fixture();
      if (change === "version") setup.runtime.workerVersionId = crypto.randomUUID();
      else if (change === "tag") setup.runtime.workerBridgeId = crypto.randomUUID();
      else await acquireServiceMigrationExecution(setup.env, "service", setup.migrationId);
      await expect(setup.client.initializeMigrationStep(setup.evidence, setup.migrationId, 1)).rejects.toThrow("expected executing version");
      expect(setup.calls.map((call) => call.method)).toEqual(["GET"]);
    }
  });

  test("lost pause or claim response is never replayed; inspection preserves paused/migrating state", async () => {
    for (const route of ["pause", "claim"] as const) {
      const setup = await fixture();
      setup.entries.delete(SERVICE_ADMISSION_KEY);
      await setup.client.initializeAdmission(setup.evidence);
      const pauseId = crypto.randomUUID();
      if (route === "claim") await setup.client.pauseAdmission(setup.evidence, pauseId);
      const status = await setup.client.status();
      setup.setLostRoute(route);
      const before = setup.calls.length;
      const operation = route === "pause" ? setup.client.pauseAdmission(setup.evidence, pauseId) : setup.client.claimMigration(setup.evidence, {
        schema_version: 1, service_id: "service", migration_id: crypto.randomUUID(), pause_id: pauseId,
        expected_service_generation: status.admission!.generation, created_at: "2026-10-02T12:00:00Z" });
      await expect(operation).rejects.toThrow("response lost");
      expect(setup.calls.slice(before).map((call) => call.method)).toEqual(["GET", "POST"]);
      setup.setLostRoute();
      expect((await setup.client.status()).admission?.state).toBe(route === "pause" ? "paused" : "migrating");
    }
  });

  test("a fabricated completion/readiness result never turns bounded initialization into migration completion", async () => {
    const setup = await fixture();
    for (const response of [{ state: "completed", phase: "finished" }, { state: "pending", phase: "runtime", m6_ready: true }]) {
      setup.setResponse(response);
      await expect(setup.client.initializeMigrationStep(setup.evidence, setup.migrationId, 1)).rejects.toThrow();
    }
    expect((await setup.client.status()).m6_ready).toBe(false);
  });
});
