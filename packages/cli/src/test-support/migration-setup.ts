import { migrationBridgeDeploymentEvidenceSchema, migrationSetupRequestSchema, parseServiceConfig } from "@castloop/shared";
import { MigrationAdminClient } from "../migration-client";
import { createMigrationSetupJournal } from "../migration-setup-journal";
import { createMigrationSetupEffects } from "../migration-setup";
import { bootstrapFixture } from "../../../../src/test-support/bootstrap";
import { handleMigrationAdmin } from "../../../../src/migration-admin";
import { SERVICE_ADMISSION_KEY } from "../../../../src/service-admission";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export async function migrationSetupFixture() {
  const setup = await bootstrapFixture(false);
  setup.entries.delete(SERVICE_ADMISSION_KEY);
  const config = parseServiceConfig(setup.entries.get("system/service.toml")!.data);
  const runtime = { ...setup.bridge, workerBridgeId: crypto.randomUUID() };
  const bridge = migrationBridgeDeploymentEvidenceSchema.parse({ schema_version: 1, service_id: config.service_id, account_id: config.account_id,
    worker_name: config.worker_name, bridge_id: runtime.workerBridgeId, deployment_id: crypto.randomUUID(), worker_version_id: setup.bridgeVersion,
    compatibility_date: "2026-10-01", traffic_percentage: 100, default_cache_disabled: true, cross_version_cache_disabled: true,
    version_metadata_binding_verified: true, service_bindings_verified: true, observability_enabled: true, workers_dev_previews_disabled: true });
  const request = migrationSetupRequestSchema.parse({ schema_version: 1, bridge, pause_id: crypto.randomUUID(), migration_id: crypto.randomUUID(),
    created_at: "2026-10-02T12:00:00Z", administrator_writes_stopped: true, other_deployers_stopped: true });
  const root = mkdtempSync("/tmp/opencode/castloop-migration-setup-");
  const file = join(root, ".castloop", "migration-setups", "service.json");
  const journal = createMigrationSetupJournal(root, request);
  const calls: Request[] = [];
  let lostRoute: string | undefined;
  let hold: { route: string; started: () => void; ended: Promise<void> } | undefined;
  const transport = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const http = new Request(input, init);
    calls.push(http.clone());
    const route = new URL(http.url).pathname.split("/").at(-1)!;
    if (http.method === "POST" && hold?.route === route) { hold.started(); await hold.ended; }
    const result = await handleMigrationAdmin(http, setup.env, runtime);
    if (!result) throw new Error("Unexpected migration route");
    if (http.method === "POST" && lostRoute === route) throw new Error("Response lost after server finished");
    return result;
  }, { preconnect: () => {} });
  const client = new MigrationAdminClient(config, "private-key", transport);
  const effects = createMigrationSetupEffects(config, request, "private-key", { client });
  return { ...setup, bridge, config, runtime, request, root, file, journal, calls, client, effects,
    setLostRoute: (route?: string) => { lostRoute = route; },
    holdRoute: (value?: typeof hold) => { hold = value; }, dispose: () => rmSync(root, { recursive: true }) };
}
