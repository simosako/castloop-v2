import { describe, expect, test } from "bun:test";
import { migrationInitializationRequestSchema, migrationQuiescenceSchema, migrationSetupClientStateSchema, serviceAdmissionSchema } from "@castloop/shared";
import type { MigrationInitializationResult } from "@castloop/shared";
import { migrationPayloadHash } from "./migration-deployment";
import { createMigrationSetupJournal, readLocalMigrationSetup, validateMigrationSetupState } from "./migration-setup-journal";
import { inspectMigrationSetup, runMigrationSetupClaim, runMigrationSetupInitializationStep, runMigrationSetupPause,
  runMigrationSetupQuiescence } from "./migration-setup";
import { migrationSetupFixture } from "./test-support/migration-setup";
import { SERVICE_ADMISSION_KEY } from "../../../src/service-admission";
import { readFileSync } from "node:fs";

async function initializedSetup() {
  const setup = await migrationSetupFixture();
  try {
    await runMigrationSetupPause(setup.journal, setup.effects);
    await runMigrationSetupClaim(setup.journal, setup.effects);
    await runMigrationSetupQuiescence(setup.journal, setup.effects, migrationQuiescenceSchema.parse({
      schema_version: 1, service_id: "service", migration_id: setup.request.migration_id,
      request_sha256: migrationPayloadHash(setup.journal.load().claim!), bridge_worker_version_id: setup.bridgeVersion,
      confirmed_at: "2026-10-02T13:00:00Z", old_admin_clients_stopped: true, old_worker_invocations_settled: true,
      old_rest_puts_settled: true, no_more_legacy_writes: true,
    }));
    return setup;
  } catch (error) { setup.dispose(); throw error; }
}

describe("durable bounded initialization without deploy or automatic step loops", () => {
  test("explicit steps initialize Episode before Show and stop at runtime while preserving payloads", async () => {
    const setup = await initializedSetup();
    try {
      const payloads = [...setup.entries].filter(([key]) => key.startsWith("public/") || key.startsWith("system/shows/"));
      const start = setup.writes.length;
      expect(await runMigrationSetupInitializationStep(setup.journal, setup.effects, 1)).toEqual({ state: "pending", phase: "applying" });
      expect(setup.journal.load().initialization?.step).toBe(1);
      expect(setup.journal.load().initialization?.before).toBeNull();
      expect(setup.journal.load().initialization?.after?.next_target).toBe(1);
      expect(setup.writes.slice(start)).toContain("system/episode-lifecycle/daily/first.toml");
      expect(setup.writes.slice(start)).not.toContain("system/show-publications/daily.json");
      const first = setup.journal.load().initialization!.after;
      expect(await runMigrationSetupInitializationStep(setup.journal, setup.effects, 2)).toEqual({ state: "pending", phase: "verifying" });
      expect(setup.journal.load().initialization?.before).toEqual(first);
      expect(setup.journal.load().initialization?.step).toBe(2);
      expect(await runMigrationSetupInitializationStep(setup.journal, setup.effects, 1)).toEqual({ state: "pending", phase: "runtime" });
      expect(setup.journal.load().phase).toBe("controls_initialized");
      expect(setup.journal.load().initialization?.step).toBe(3);
      const observed = await inspectMigrationSetup(setup.journal, setup.effects);
      expect(observed.server_status.admission?.state).toBe("migrating");
      expect(observed.server_status.admission?.mode).toBe("legacy");
      expect(observed.server_status.admission?.readiness).toBeUndefined();
      expect(observed.server_status.admission?.migration?.execution_id).toBeUndefined();
      expect(observed.server_status.bootstrap).toBeNull();
      expect(observed.server_status.m6_ready).toBe(false);
      expect(readLocalMigrationSetup(setup.root, setup.config).client_state?.phase).toBe("controls_initialized");
      expect([...setup.entries].filter(([key]) => key.startsWith("public/") || key.startsWith("system/shows/"))).toEqual(payloads);
      const posts = setup.calls.filter((http) => http.method === "POST" && http.url.endsWith("/apply"));
      expect(posts).toHaveLength(3);
      expect(migrationInitializationRequestSchema.parse(await posts[0]!.json())).toEqual({
        schema_version: 1, service_id: "service", migration_id: setup.request.migration_id, maximum_targets: 1,
      });
      const before = setup.calls.length;
      await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects)).rejects.toThrow("already initialized");
      expect(setup.calls).toHaveLength(before);
      const journal = readFileSync(setup.file, "utf8");
      for (const text of ["private-key", "Private episode", "Private description", "publication_routes_verified", "cutover_verified"]) expect(journal).not.toContain(text);
    } finally { setup.dispose(); }
  });

  test("lost apply response retains a frozen step even when GET observes successful controls", async () => {
    const setup = await initializedSetup();
    try {
      setup.setLostRoute("apply");
      await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects, 1)).rejects.toThrow("Response lost");
      const before = readFileSync(setup.file, "utf8");
      const observed = await inspectMigrationSetup(setup.journal, setup.effects);
      expect(observed.client_state.phase).toBe("initialization_requested");
      expect(observed.client_state.initialization?.maximum_targets).toBe(1);
      expect(observed.client_state.initialization?.result).toBeUndefined();
      expect(observed.server_status.progress?.next_target).toBe(1);
      expect(observed.server_status.admission?.migration?.execution_id).toBeUndefined();
      setup.setLostRoute();
      const other = createMigrationSetupJournal(setup.root, setup.request);
      await expect(runMigrationSetupInitializationStep(other, setup.effects, 100)).rejects.toThrow("unknown");
      expect(readFileSync(setup.file, "utf8")).toBe(before);
      expect(setup.calls.filter((http) => http.method === "POST" && http.url.endsWith("/apply"))).toHaveLength(1);
    } finally { setup.dispose(); }
  });

  test("preflight failure is retryable only before the requested record and sends no POST", async () => {
    const setup = await initializedSetup();
    try {
      const effects = { ...setup.effects, status: async () => { throw new Error("Preflight unavailable"); } };
      await expect(runMigrationSetupInitializationStep(setup.journal, effects)).rejects.toThrow("Preflight unavailable");
      expect(setup.journal.load().phase).toBe("quiesced");
      expect(setup.calls.some((http) => http.url.endsWith("/apply"))).toBe(false);
      await runMigrationSetupInitializationStep(setup.journal, setup.effects, 1);
      expect(setup.journal.load().initialization?.step).toBe(1);
    } finally { setup.dispose(); }
  });

  test("successful POST followed by GET failure remains requested and cannot be replayed", async () => {
    const setup = await initializedSetup();
    try {
      let reads = 0;
      const effects = { ...setup.effects, status: async () => {
        if (++reads === 2) throw new Error("Post-apply inspection lost");
        return setup.effects.status();
      } };
      await expect(runMigrationSetupInitializationStep(setup.journal, effects, 1)).rejects.toThrow("inspection lost");
      expect(setup.journal.load().phase).toBe("initialization_requested");
      expect((await inspectMigrationSetup(setup.journal, setup.effects)).server_status.progress?.next_target).toBe(1);
      await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects)).rejects.toThrow("unknown");
      expect(setup.calls.filter((http) => http.method === "POST" && http.url.endsWith("/apply"))).toHaveLength(1);
    } finally { setup.dispose(); }
  });

  test("failure to save requested/successful progress never releases unknown steps or copies exceptions", async () => {
    for (const phase of ["initialization_requested", "initialization_pending"] as const) {
      const setup = await initializedSetup();
      try {
        const journal = { ...setup.journal, save: (state: Parameters<typeof setup.journal.save>[0]) => {
          if (state.phase === phase) throw new Error("Sensitive local failure");
          setup.journal.save(state);
        } };
        await expect(runMigrationSetupInitializationStep(journal, setup.effects, 1)).rejects.toThrow("Sensitive local failure");
        expect(setup.journal.load().phase).toBe(phase === "initialization_requested" ? "quiesced" : "initialization_requested");
        expect(setup.calls.filter((http) => http.method === "POST" && http.url.endsWith("/apply"))).toHaveLength(phase === "initialization_requested" ? 0 : 1);
        expect(readFileSync(setup.file, "utf8")).not.toContain("Sensitive local failure");
        if (phase === "initialization_pending") await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects)).rejects.toThrow("unknown");
      } finally { setup.dispose(); }
    }
  });

  test("unacknowledged remote progress prevents another step rather than silently adopting it", async () => {
    for (const acknowledged of [false, true]) {
      const setup = await initializedSetup();
      try {
        if (acknowledged) await runMigrationSetupInitializationStep(setup.journal, setup.effects, 1);
        await setup.client.initializeMigrationStep(setup.bridge, setup.request.migration_id, 1);
        const before = readFileSync(setup.file, "utf8");
        const posts = setup.calls.filter((http) => http.method === "POST").length;
        await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects, 1)).rejects.toThrow("differs from the last acknowledged");
        expect(readFileSync(setup.file, "utf8")).toBe(before);
        expect(setup.calls.filter((http) => http.method === "POST")).toHaveLength(posts);
      } finally { setup.dispose(); }
    }
  });

  test("invalid limit, foreign version and changed quiescence are refused before POST", async () => {
    const setup = await initializedSetup();
    try {
      const before = setup.calls.length;
      for (const maximum of [0, 101, 1.5, NaN]) await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects, maximum)).rejects.toThrow();
      expect(setup.calls).toHaveLength(before);
      setup.runtime.workerBridgeId = crypto.randomUUID();
      await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects)).rejects.toThrow("expected bridge");
      setup.runtime.workerBridgeId = setup.bridge.bridge_id;
      const key = `system/lifecycle-migrations/${setup.request.migration_id}/quiescence.json`;
      await setup.bucket.put(key, JSON.stringify({ ...setup.journal.load().quiescence, confirmed_at: "2026-10-02T14:00:00Z" }));
      await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects)).rejects.toThrow("frozen quiescence");
      expect(setup.journal.load().phase).toBe("quiesced");
      expect(setup.calls.some((http) => http.method === "POST" && http.url.endsWith("/apply"))).toBe(false);
    } finally { setup.dispose(); }
  });

  test("forged completion or phase responses leave requested without inferring M6 readiness", async () => {
    for (const response of [{ state: "completed", phase: "finished" }, { state: "pending", phase: "runtime" }]) {
      const setup = await initializedSetup();
      try {
        const effects = { ...setup.effects, initializeStep: async (maximum: number) => {
          await setup.effects.initializeStep(maximum);
          return response as MigrationInitializationResult;
        } };
        await expect(runMigrationSetupInitializationStep(setup.journal, effects, 1)).rejects.toThrow();
        expect(setup.journal.load().phase).toBe("initialization_requested");
        await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects)).rejects.toThrow("unknown");
      } finally { setup.dispose(); }
    }
  });

  test("live apply excludes other clients through the final status check and durable receipt", async () => {
    const setup = await initializedSetup();
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    try {
      setup.holdRoute({ route: "apply", started: () => started.resolve(), ended: ended.promise });
      const pending = runMigrationSetupInitializationStep(setup.journal, setup.effects, 1);
      await started.promise;
      const observed = readLocalMigrationSetup(setup.root, setup.config);
      expect(observed.lock_present).toBe(true);
      expect(observed.client_state?.initialization?.maximum_targets).toBe(1);
      const other = createMigrationSetupJournal(setup.root, setup.request);
      await expect(runMigrationSetupInitializationStep(other, setup.effects)).rejects.toThrow("EEXIST");
      ended.resolve();
      await pending;
      expect(readLocalMigrationSetup(setup.root, setup.config).lock_present).toBe(false);
      expect(other.load().phase).toBe("initialization_pending");
    } finally { ended.resolve(); setup.dispose(); }
  });

  test("after-POST progress corruption, foreign ownership or a new token never acknowledges the step", async () => {
    for (const change of ["budget", "phase", "plan", "token", "version", "quiescence"] as const) {
      const setup = await initializedSetup();
      try {
        if (change === "plan") await runMigrationSetupInitializationStep(setup.journal, setup.effects, 1);
        let reads = 0;
        const effects = { ...setup.effects, status: async () => {
          const status = await setup.effects.status();
          if (++reads !== 2) return status;
          if (change === "budget") return { ...status, progress: { ...status.progress!, next_target: 2 } };
          if (change === "phase") return { ...status, progress: { ...status.progress!, phase: "runtime" as const } };
          if (change === "plan") return { ...status, progress: { ...status.progress!, plan_sha256: "f".repeat(64) } };
          if (change === "token") return { ...status, admission: { ...status.admission!, migration: {
            ...status.admission!.migration!, execution_id: crypto.randomUUID(),
          } } };
          if (change === "version") return { ...status, worker_version_id: crypto.randomUUID() };
          return { ...status, quiescence: { ...status.quiescence!, confirmed_at: "2026-10-02T14:00:00Z" } };
        } };
        await expect(runMigrationSetupInitializationStep(setup.journal, effects, 1)).rejects.toThrow();
        expect(setup.journal.load().phase).toBe("initialization_requested");
        await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects)).rejects.toThrow("unknown");
        expect(setup.journal.load().initialization?.after).toBeUndefined();
      } finally { setup.dispose(); }
    }
  });

  test("empty inventories still require explicit verification and do not skip to completion", async () => {
    const setup = await initializedSetup();
    try {
      for (const key of [...setup.entries.keys()]) {
        if (!key.startsWith("system/lifecycle-migrations/") && key !== SERVICE_ADMISSION_KEY && key !== "system/service.toml") {
          setup.entries.delete(key);
        }
      }
      expect(await runMigrationSetupInitializationStep(setup.journal, setup.effects, 1)).toEqual({ state: "pending", phase: "verifying" });
      expect(setup.journal.load().initialization?.after?.next_target).toBe(0);
      expect(setup.journal.load().phase).toBe("initialization_pending");
      expect(await runMigrationSetupInitializationStep(setup.journal, setup.effects, 1)).toEqual({ state: "pending", phase: "runtime" });
      expect(setup.journal.load().phase).toBe("controls_initialized");
      expect((await setup.effects.status()).admission?.mode).toBe("legacy");
      expect(setup.calls.filter((http) => http.method === "POST" && http.url.endsWith("/apply"))).toHaveLength(2);
    } finally { setup.dispose(); }
  });

  test("unknown migration token remains held after acquisition response loss", async () => {
    const setup = await initializedSetup();
    try {
      const original = setup.env.CASTLOOP_BUCKET.put.bind(setup.env.CASTLOOP_BUCKET);
      setup.env.CASTLOOP_BUCKET.put = (async (key: string, value: string, options?: R2PutOptions) => {
        const written = await original(key, value, options);
        if (key === SERVICE_ADMISSION_KEY && serviceAdmissionSchema.parse(JSON.parse(value)).migration?.execution_id) {
          throw new Error("Acquisition response lost");
        }
        return written;
      }) as typeof setup.env.CASTLOOP_BUCKET.put;
      await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects, 1)).rejects.toThrow("HTTP 409");
      const observed = await inspectMigrationSetup(setup.journal, setup.effects);
      expect(observed.client_state.phase).toBe("initialization_requested");
      expect(observed.server_status.admission?.migration?.execution_id).toBeDefined();
      expect(observed.server_status.progress).toBeNull();
      await expect(runMigrationSetupInitializationStep(setup.journal, setup.effects)).rejects.toThrow("unknown");
    } finally { setup.dispose(); }
  });

  test("strict evidence and journal transitions reject changed input, hashes, counters and skipped POSTs", async () => {
    const setup = await initializedSetup();
    try {
      await runMigrationSetupInitializationStep(setup.journal, setup.effects, 1);
      const saved = setup.journal.load();
      const step = saved.initialization!;
      for (const change of [
        { ...step, step: 2 }, { ...step, maximum_targets: 0 }, { ...step, result: { state: "completed", phase: "finished" } },
        { ...step, after: { ...step.after, plan_sha256: "not-a-hash" } },
        { ...step, after: { ...step.after, request_sha256: "f".repeat(64) } },
        { ...step, after: { ...step.after, next_target: 2 } }, { ...step, after: { ...step.after, next_target: 0 } },
        { ...step, after: { ...step.after, reason_code: "migration_apply_failed" } },
        { ...step, unexpected: "private" },
      ]) expect(migrationSetupClientStateSchema.safeParse({ ...saved, initialization: change }).success).toBe(false);
      await setup.journal.exclusively(async () => {
        expect(() => setup.journal.save({ ...saved, initialization: { ...step, maximum_targets: 2 } })).toThrow("cannot change");
        const runtime = validateMigrationSetupState({ ...saved, phase: "controls_initialized", initialization: {
          step: 2, maximum_targets: 1, before: { ...step.after, phase: "verifying" }, result: { state: "pending", phase: "runtime" },
          after: { ...step.after, phase: "runtime" },
        } });
        expect(() => setup.journal.save(runtime)).toThrow("skip phases");
        const next = { ...saved, phase: "initialization_requested" as const,
          initialization: { step: 3, maximum_targets: 1, before: step.after! } };
        expect(() => setup.journal.save(next)).toThrow("frozen step");
        expect(() => setup.journal.save({ ...next, initialization: { ...next.initialization, step: 2,
          before: { ...step.after!, plan_sha256: "f".repeat(64) } } })).toThrow("frozen step");
      });
    } finally { setup.dispose(); }
  });
});
