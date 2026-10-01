import { describe, expect, test } from "bun:test";
import { migrationQuiescenceSchema, migrationSetupClientStateSchema, serviceAdmissionSchema } from "@castloop/shared";
import { migrationPayloadHash } from "./migration-deployment";
import { createMigrationSetupJournal, validateMigrationSetupState } from "./migration-setup-journal";
import { createMigrationSetupEffects, inspectMigrationSetup, resumeMigrationSetupPause, runMigrationSetupClaim,
  runMigrationSetupPause, runMigrationSetupQuiescence } from "./migration-setup";
import { migrationSetupFixture } from "./test-support/migration-setup";
import { acquireServiceInvocation, releaseServiceInvocation, SERVICE_ADMISSION_KEY } from "../../../src/service-admission";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function confirmation(setup: Awaited<ReturnType<typeof migrationSetupFixture>>) {
  return migrationQuiescenceSchema.parse({ schema_version: 1, service_id: "service", migration_id: setup.request.migration_id,
    request_sha256: migrationPayloadHash(setup.journal.load().claim!), bridge_worker_version_id: setup.bridgeVersion,
    confirmed_at: "2026-10-02T13:00:00Z", old_admin_clients_stopped: true, old_worker_invocations_settled: true,
    old_rest_puts_settled: true, no_more_legacy_writes: true });
}

describe("durable pause/claim/quiescence setup without automatic retry", () => {
  test("freezes IDs/generation/explicit declaration with private records and stops before initialization/deploy", async () => {
    const setup = await migrationSetupFixture();
    try {
      expect(statSync(setup.file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(setup.file)).mode & 0o777).toBe(0o700);
      await runMigrationSetupPause(setup.journal, setup.effects);
      expect(setup.journal.load().phase).toBe("paused");
      await runMigrationSetupClaim(setup.journal, setup.effects);
      expect(setup.journal.load().claim?.migration_id).toBe(setup.request.migration_id);
      await runMigrationSetupQuiescence(setup.journal, setup.effects, confirmation(setup));
      const before = readFileSync(setup.file, "utf8");
      const inspected = await inspectMigrationSetup(setup.journal, setup.effects);
      expect(inspected.client_state.phase).toBe("quiesced");
      expect(inspected.server_status.admission?.state).toBe("migrating");
      expect(inspected.server_status.admission?.mode).toBe("legacy");
      expect(inspected.server_status.quiescence).toEqual(confirmation(setup));
      expect(inspected.server_status.progress).toBeNull();
      expect(inspected.server_status.bootstrap).toBeNull();
      expect(inspected.server_status.m6_ready).toBe(false);
      expect(readFileSync(setup.file, "utf8")).toBe(before);
      expect(setup.calls.filter((http) => http.method === "POST").map((http) => new URL(http.url).pathname.split("/").at(-1)))
        .toEqual(["initialize-admission", "pause", "claim", "quiescence"]);
      for (const privateValue of ["private-key", "Private episode", "Private description", "old_cache_purged", "cutover_verified"]) expect(before).not.toContain(privateValue);
      expect(() => createMigrationSetupJournal(setup.root, { ...setup.request, migration_id: crypto.randomUUID() })).toThrow("different frozen");
    } finally { setup.dispose(); }
  });

  test("live mutating invocations retain the pause and refuse claim before its generation is frozen", async () => {
    const setup = await migrationSetupFixture();
    try {
      await setup.client.initializeAdmission(setup.bridge);
      const invocation = await acquireServiceInvocation(setup.env, "service", "legacy_admin");
      await runMigrationSetupPause(setup.journal, setup.effects);
      await expect(runMigrationSetupClaim(setup.journal, setup.effects)).rejects.toThrow("live mutating");
      expect(setup.journal.load().phase).toBe("paused");
      expect(setup.journal.load().claim).toBeUndefined();
      expect(setup.calls.some((http) => http.url.endsWith("/claim"))).toBe(false);
      await releaseServiceInvocation(setup.env, invocation);
      await runMigrationSetupClaim(setup.journal, setup.effects);
      expect(setup.journal.load().phase).toBe("claimed");
    } finally { setup.dispose(); }
  });

  test("lost initialization/pause/claim/quiescence response preserves requested phase even when GET shows success", async () => {
    const phases = { "initialize-admission": "admission_requested", pause: "pause_requested", claim: "claim_requested", quiescence: "quiescence_requested" } as const;
    for (const route of Object.keys(phases) as Array<keyof typeof phases>) {
      const setup = await migrationSetupFixture();
      try {
        if (route === "claim" || route === "quiescence") await runMigrationSetupPause(setup.journal, setup.effects);
        if (route === "quiescence") await runMigrationSetupClaim(setup.journal, setup.effects);
        setup.setLostRoute(route);
        const run = () => route === "claim" ? runMigrationSetupClaim(setup.journal, setup.effects) : route === "quiescence" ?
          runMigrationSetupQuiescence(setup.journal, setup.effects, confirmation(setup)) : runMigrationSetupPause(setup.journal, setup.effects);
        await expect(run()).rejects.toThrow("Response lost");
        expect(setup.journal.load().phase).toBe(phases[route]);
        const before = setup.calls.length;
        await expect(run()).rejects.toThrow();
        await expect(resumeMigrationSetupPause(setup.journal, setup.effects)).rejects.toThrow();
        expect(setup.calls).toHaveLength(before);
        setup.setLostRoute();
        const observed = await inspectMigrationSetup(setup.journal, setup.effects);
        expect(observed.client_state.phase).toBe(phases[route]);
        expect(observed.server_status.admission?.state).toBe(route === "initialize-admission" ? "open" : route === "pause" ? "paused" : "migrating");
        if (route === "quiescence") expect(observed.server_status.quiescence).toEqual(confirmation(setup));
        expect(setup.calls.filter((http) => http.method === "POST" && http.url.endsWith(`/${route}`))).toHaveLength(1);
      } finally { setup.dispose(); }
    }
  });

  test("a live request excludes concurrent clients until all promises settle; leftover locks are never stolen", async () => {
    const setup = await migrationSetupFixture();
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    try {
      setup.holdRoute({ route: "pause", started: () => started.resolve(), ended: ended.promise });
      const pending = runMigrationSetupPause(setup.journal, setup.effects);
      await started.promise;
      expect(setup.journal.load().phase).toBe("pause_requested");
      const other = createMigrationSetupJournal(setup.root, setup.request);
      await expect(runMigrationSetupPause(other, setup.effects)).rejects.toThrow("EEXIST");
      await expect(inspectMigrationSetup(other, setup.effects)).rejects.toThrow("EEXIST");
      ended.resolve();
      await pending;
      writeFileSync(`${setup.file}.lock`, "", { mode: 0o600 });
      await expect(runMigrationSetupClaim(other, setup.effects)).rejects.toThrow("EEXIST");
      expect(setup.journal.load().phase).toBe("paused");
    } finally { ended.resolve(); setup.dispose(); }
  });

  test("saving requested or successful claim phase fails closed and never sends a second POST", async () => {
    for (const phase of ["claim_requested", "claimed"] as const) {
      const setup = await migrationSetupFixture();
      try {
        await runMigrationSetupPause(setup.journal, setup.effects);
        const journal = { ...setup.journal, save: (state: Parameters<typeof setup.journal.save>[0]) => {
          if (state.phase === phase) throw new Error("Private disk error");
          setup.journal.save(state);
        } };
        await expect(runMigrationSetupClaim(journal, setup.effects)).rejects.toThrow("Private disk");
        expect(setup.journal.load().phase).toBe(phase === "claim_requested" ? "paused" : "claim_requested");
        expect(setup.calls.filter((http) => http.method === "POST" && http.url.endsWith("/claim"))).toHaveLength(phase === "claim_requested" ? 0 : 1);
        expect(readFileSync(setup.file, "utf8")).not.toContain("Private disk");
        if (phase === "claimed") await expect(runMigrationSetupClaim(setup.journal, setup.effects)).rejects.toThrow("unknown");
      } finally { setup.dispose(); }
    }
  });

  test("explicit resume only accepts admission_ready where no pause POST was started", async () => {
    const setup = await migrationSetupFixture();
    try {
      let reads = 0;
      const effects = { ...setup.effects, status: async () => {
        if (++reads === 2) throw new Error("Pre-pause GET failed");
        return setup.effects.status();
      } };
      await expect(runMigrationSetupPause(setup.journal, effects)).rejects.toThrow("Pre-pause GET");
      expect(setup.journal.load().phase).toBe("admission_ready");
      expect(setup.calls.some((http) => http.url.endsWith("/pause"))).toBe(false);
      await resumeMigrationSetupPause(setup.journal, setup.effects);
      expect(setup.journal.load().phase).toBe("paused");
      expect(setup.calls.filter((http) => http.method === "POST" && http.url.endsWith("/initialize-admission"))).toHaveLength(1);
    } finally { setup.dispose(); }
  });

  test("foreign setup effects/bridge and altered or unconfirmed declarations are rejected without POST", async () => {
    const setup = await migrationSetupFixture();
    try {
      await expect(runMigrationSetupPause(setup.journal, { ...setup.effects, request: { ...setup.request, pause_id: crypto.randomUUID() } })).rejects.toThrow("frozen request");
      expect(setup.calls).toHaveLength(0);
      setup.runtime.workerBridgeId = crypto.randomUUID();
      await expect(runMigrationSetupPause(setup.journal, setup.effects)).rejects.toThrow("expected bridge");
      expect(setup.journal.load().phase).toBe("prepared");
      setup.runtime.workerBridgeId = setup.bridge.bridge_id;
      await runMigrationSetupPause(setup.journal, setup.effects);
      await runMigrationSetupClaim(setup.journal, setup.effects);
      const before = setup.calls.length;
      const wrong = { ...confirmation(setup), request_sha256: "f".repeat(64) };
      await expect(runMigrationSetupQuiescence(setup.journal, setup.effects, wrong)).rejects.toThrow("frozen migration");
      expect(migrationQuiescenceSchema.safeParse({ ...confirmation(setup), old_rest_puts_settled: false }).success).toBe(false);
      expect(setup.calls).toHaveLength(before);
      expect(() => createMigrationSetupEffects({ ...setup.config, worker_name: "foreign-worker" }, setup.request, "private-key")).toThrow("another service");
    } finally { setup.dispose(); }
  });

  test("token acquisition response loss remains held, despite inspection finding a small partial record", async () => {
    const setup = await migrationSetupFixture();
    try {
      await runMigrationSetupPause(setup.journal, setup.effects);
      await runMigrationSetupClaim(setup.journal, setup.effects);
      const original = setup.env.CASTLOOP_BUCKET.put.bind(setup.env.CASTLOOP_BUCKET);
      setup.env.CASTLOOP_BUCKET.put = (async (key: string, value: string, options?: R2PutOptions) => {
        const result = await original(key, value, options);
        if (key === SERVICE_ADMISSION_KEY && serviceAdmissionSchema.parse(JSON.parse(value)).migration?.execution_id) throw new Error("Unknown token response lost");
        return result;
      }) as typeof setup.env.CASTLOOP_BUCKET.put;
      await expect(runMigrationSetupQuiescence(setup.journal, setup.effects, confirmation(setup))).rejects.toThrow("HTTP 409");
      const observation = await inspectMigrationSetup(setup.journal, setup.effects);
      expect(observation.client_state.phase).toBe("quiescence_requested");
      expect(observation.server_status.admission?.migration?.execution_id).toBeDefined();
      expect(observation.server_status.quiescence).toBeNull();
    } finally { setup.dispose(); }
  });

  test("journals reject phase skips, changed IDs/declarations, bad hashes and corrupt/oversized data", async () => {
    const setup = await migrationSetupFixture();
    try {
      expect(() => setup.journal.save(setup.journal.load())).toThrow("exclusive");
      await setup.journal.exclusively(async () => {
        expect(() => setup.journal.save({ ...setup.journal.load(), phase: "paused" })).toThrow("skip phases");
      });
      await runMigrationSetupPause(setup.journal, setup.effects);
      await runMigrationSetupClaim(setup.journal, setup.effects);
      await runMigrationSetupQuiescence(setup.journal, setup.effects, confirmation(setup));
      const saved = setup.journal.load();
      expect(migrationSetupClientStateSchema.safeParse({ ...saved, claim: { ...saved.claim, pause_id: crypto.randomUUID() } }).success).toBe(false);
      expect(() => validateMigrationSetupState({ ...saved, quiescence: { ...saved.quiescence, request_sha256: "0".repeat(64) } })).toThrow("claim hash");
      await setup.journal.exclusively(async () => {
        expect(() => setup.journal.save({ ...saved, quiescence: { ...saved.quiescence!, confirmed_at: "2026-10-02T14:00:00Z" } })).toThrow("cannot change");
      });
      writeFileSync(setup.file, "x".repeat(17000));
      expect(() => setup.journal.load()).toThrow("budget");
      writeFileSync(setup.file, "{");
      expect(() => setup.journal.load()).toThrow();
    } finally { setup.dispose(); }
  });
});
