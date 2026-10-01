import { describe, expect, test } from "bun:test";
import { migrationBridgeClientStateSchema, migrationBridgeDeploymentRequestSchema } from "@castloop/shared";
import { createMigrationBridgeJournal, resumeMigrationBridgeInspection, runMigrationBridgeDeployment } from "./migration-bridge-journal";
import { bridgeDeploymentFixture } from "./test-support/migration-bridge";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function fixture() {
  const setup = bridgeDeploymentFixture();
  const prepared = await setup.prepare();
  const request = migrationBridgeDeploymentRequestSchema.parse({ schema_version: 1, preparation: prepared.request,
    administrator_writes_stopped: true, other_deployers_stopped: true });
  const root = mkdtempSync("/tmp/opencode/castloop-bridge-journal-");
  const file = join(root, ".castloop", "bridge-deployments", "probe.json");
  const journal = createMigrationBridgeJournal(root, request);
  const versionId = crypto.randomUUID();
  const evidence = { schema_version: 1 as const, service_id: setup.config.service_id, account_id: setup.config.account_id,
    worker_name: setup.config.worker_name, bridge_id: setup.bridgeId, deployment_id: crypto.randomUUID(), worker_version_id: versionId,
    compatibility_date: "2026-10-01" as const, traffic_percentage: 100 as const, default_cache_disabled: true as const,
    cross_version_cache_disabled: true as const, version_metadata_binding_verified: true as const, service_bindings_verified: true as const,
    observability_enabled: true as const, workers_dev_previews_disabled: true as const };
  const calls: string[] = [];
  const effects = { preflight: async () => { calls.push("preflight"); }, deploy: async () => { calls.push("deploy"); return versionId; },
    inspect: async () => { calls.push("inspect"); return evidence; } };
  return { ...setup, ...prepared, request, root, file, journal, versionId, evidence, calls, effects, dispose: () => rmSync(root, { recursive: true }) };
}

describe("durable service-scoped one-time initial bridge driver", () => {
  test("private durable phases freeze one service request and only reach verified after inspection", async () => {
    const setup = await fixture();
    try {
      expect(statSync(setup.file).mode & 0o777).toBe(0o600);
      expect(statSync(join(setup.root, ".castloop", "bridge-deployments")).mode & 0o777).toBe(0o700);
      await runMigrationBridgeDeployment(setup.journal, setup.effects, setup.source, setup.metadata);
      expect(setup.calls).toEqual(["preflight", "deploy", "inspect"]);
      expect(setup.journal.load().phase).toBe("verified");
      await resumeMigrationBridgeInspection(setup.journal, setup.effects);
      expect(setup.calls).toHaveLength(3);
      expect(() => createMigrationBridgeJournal(setup.root, { ...setup.request,
        preparation: { ...setup.request.preparation, bridge_id: crypto.randomUUID() } })).toThrow("different frozen");
      for (const secret of [setup.source, "original-kv", "private@example.com"]) expect(readFileSync(setup.file, "utf8")).not.toContain(secret);
    } finally { setup.dispose(); }
  });

  test("payload or external acknowledgement errors cannot begin network effects", async () => {
    const setup = await fixture();
    try {
      await expect(runMigrationBridgeDeployment(setup.journal, setup.effects, "wrong source", setup.metadata)).rejects.toThrow("frozen");
      expect(setup.calls).toEqual([]);
      for (const input of [{ ...setup.request, other_deployers_stopped: false }, { ...setup.request, administrator_writes_stopped: false }]) {
        expect(migrationBridgeDeploymentRequestSchema.safeParse(input).success).toBe(false);
      }
      expect(setup.journal.load().phase).toBe("prepared");
    } finally { setup.dispose(); }
  });

  test("a live deploy excludes another client and unknown outcome remains uploading without replay", async () => {
    const setup = await fixture();
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    try {
      const effects = { ...setup.effects, deploy: async () => { started.resolve(); await ended.promise; throw new Error("Lost PUT response"); } };
      const pending = runMigrationBridgeDeployment(setup.journal, effects, setup.source, setup.metadata);
      await started.promise;
      const other = createMigrationBridgeJournal(setup.root, setup.request);
      await expect(runMigrationBridgeDeployment(other, setup.effects, setup.source, setup.metadata)).rejects.toThrow("EEXIST");
      expect(setup.journal.load().phase).toBe("uploading");
      ended.resolve();
      await expect(pending).rejects.toThrow("Lost PUT");
      await expect(runMigrationBridgeDeployment(other, setup.effects, setup.source, setup.metadata)).rejects.toThrow("replay PUT");
      await expect(resumeMigrationBridgeInspection(other, setup.effects)).rejects.toThrow("unknown");
      expect(setup.calls).toEqual(["preflight"]);
    } finally { ended.resolve(); setup.dispose(); }
  });

  test("rest_settled recovery performs inspection only, refusing foreign evidence", async () => {
    const setup = await fixture();
    try {
      await expect(runMigrationBridgeDeployment(setup.journal, { ...setup.effects, inspect: async () => { throw new Error("GET failed"); } },
        setup.source, setup.metadata)).rejects.toThrow("GET failed");
      expect(setup.journal.load().phase).toBe("rest_settled");
      await expect(resumeMigrationBridgeInspection(setup.journal, { ...setup.effects, inspect: async () => ({ ...setup.evidence, bridge_id: crypto.randomUUID() }) })).rejects.toThrow();
      expect(setup.journal.load().phase).toBe("rest_settled");
      await resumeMigrationBridgeInspection(setup.journal, setup.effects);
      expect(setup.calls).toEqual(["preflight", "deploy", "inspect"]);
      expect(setup.journal.load().phase).toBe("verified");
    } finally { setup.dispose(); }
  });

  test("save failure before or after upload prevents further effects and never licenses retry", async () => {
    for (const phase of ["uploading", "rest_settled"] as const) {
      const setup = await fixture();
      try {
        const journal = { ...setup.journal, save: (state: Parameters<typeof setup.journal.save>[0]) => {
          if (state.phase === phase) throw new Error("Disk failure");
          setup.journal.save(state);
        } };
        await expect(runMigrationBridgeDeployment(journal, setup.effects, setup.source, setup.metadata)).rejects.toThrow("Disk failure");
        expect(setup.calls).toEqual(phase === "uploading" ? ["preflight"] : ["preflight", "deploy"]);
        expect(setup.journal.load().phase).toBe(phase === "uploading" ? "prepared" : "uploading");
        if (phase === "rest_settled") await expect(resumeMigrationBridgeInspection(setup.journal, setup.effects)).rejects.toThrow("unknown");
      } finally { setup.dispose(); }
    }
  });

  test("stale lock, corruption and oversized journal fail closed", async () => {
    const setup = await fixture();
    try {
      await setup.journal.exclusively(async () => {
        expect(() => setup.journal.save({ ...setup.journal.load(), phase: "rest_settled", worker_version_id: setup.versionId })).toThrow("skip phases");
      });
      writeFileSync(`${setup.file}.lock`, "", { mode: 0o600 });
      await expect(runMigrationBridgeDeployment(setup.journal, setup.effects, setup.source, setup.metadata)).rejects.toThrow("EEXIST");
      expect(setup.calls).toEqual([]);
      expect(() => setup.journal.save(setup.journal.load())).toThrow("exclusive");
      expect(migrationBridgeClientStateSchema.safeParse({ ...setup.journal.load(), phase: "verified" }).success).toBe(false);
      writeFileSync(setup.file, "x".repeat(17000));
      expect(() => setup.journal.load()).toThrow("budget");
      writeFileSync(setup.file, "{");
      expect(() => setup.journal.load()).toThrow();
    } finally { setup.dispose(); }
  });
});
