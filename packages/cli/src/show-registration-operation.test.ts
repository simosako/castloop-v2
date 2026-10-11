import { describe, expect, test } from "bun:test";
import { stringifyToml } from "@castloop/shared";
import { readLocalOperationStatus } from "./local-operation-status";
import { createShowRegistrationJournal, readLocalShowRegistration, validateShowRegistrationState } from "./show-registration-journal";
import type { ShowRegistrationJournal } from "./show-registration-journal";
import { createShowRegistrationEffects, inspectShowRegistrationOperation, runShowRegistration } from "./show-registration-operation";
import { handleM6ShowRegistrationAdmin } from "../../../src/show-registration-admin";
import { stagingAdminFixture } from "../../../src/test-support/staging-admin";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

async function fixture() {
  const setup = await stagingAdminFixture("show");
  const root = mkdtempSync("/tmp/opencode/castloop-show-registration-");
  const request = { schema_version: 1 as const, service_id: "service", show_id: "new-show", reservation_id: crypto.randomUUID(), action: "reserve" as const };
  const calls: Request[] = [];
  let lost = false;
  const effects = createShowRegistrationEffects(setup.config, "private-secret", async (input, init) => {
    const http = new Request(input, init);
    calls.push(http.clone());
    const response = await handleM6ShowRegistrationAdmin(http, setup.env, setup.bindings);
    if (!response) throw new Error("Unexpected registration route");
    if (lost) { await response.body?.cancel(); throw new Error("private transport exception"); }
    return response;
  });
  const journal = createShowRegistrationJournal(root, setup.config, request);
  const file = join(root, ".castloop", "show-registrations", "service", "new-show.json");
  return { ...setup, root, request, effects, journal, file, calls, setLost: (value: boolean) => { lost = value; },
    dispose: () => rmSync(root, { recursive: true, force: true }) };
}

describe("durable Show registration without unknown-outcome replay", () => {
  test("freezes private identity/request before HTTP, persists requested before send and saves only a matching receipt", async () => {
    const setup = await fixture();
    try {
      expect(setup.calls).toHaveLength(0);
      expect(setup.journal.load().phase).toBe("prepared");
      expect(statSync(setup.file).mode & 0o777).toBe(0o600);
      for (const directory of [dirname(setup.file), dirname(dirname(setup.file)), join(setup.root, ".castloop")]) {
        expect(statSync(directory).mode & 0o777).toBe(0o700);
      }
      await runShowRegistration(setup.journal, { ...setup.effects, reserve: async (request) => {
        expect(setup.journal.load().phase).toBe("reserve_requested");
        expect(existsSync(`${setup.file}.lock`)).toBe(true);
        return setup.effects.reserve(request);
      } });
      expect(setup.calls).toHaveLength(1);
      expect(setup.journal.load()).toMatchObject({ phase: "registered", reserve: setup.request,
        receipt: { result: "reserved", reservation_id: setup.request.reservation_id, control_ready: true } });
      expect(existsSync(`${setup.file}.lock`)).toBe(false);
      expect(readFileSync(setup.file, "utf8")).not.toContain("private-secret");
      expect(readFileSync(setup.file, "utf8")).not.toContain("private transport");
      const before = readFileSync(setup.file);
      expect(await inspectShowRegistrationOperation(setup.journal, setup.effects)).toMatchObject({ state: "reserved", authorizes_registration: false });
      expect(readFileSync(setup.file)).toEqual(before);
      await runShowRegistration(setup.journal, setup.effects);
      expect(setup.calls).toHaveLength(2);
      expect(readLocalShowRegistration(setup.root, setup.config, "new-show")).toMatchObject({ lock_present: false, remote_state_checked: false });
    } finally { setup.dispose(); }
  });

  test("lost HTTP outcome stays requested despite remote reserved status and is never automatically resent or promoted", async () => {
    const setup = await fixture();
    try {
      setup.setLost(true);
      await expect(runShowRegistration(setup.journal, setup.effects)).rejects.toThrow("outcome is unknown");
      expect(setup.journal.load().phase).toBe("reserve_requested");
      expect(setup.calls).toHaveLength(1);
      setup.setLost(false);
      const before = readFileSync(setup.file);
      expect(await inspectShowRegistrationOperation(setup.journal, setup.effects)).toMatchObject({ state: "reserved", authorizes_registration: false });
      expect(readFileSync(setup.file)).toEqual(before);
      await expect(runShowRegistration(setup.journal, setup.effects)).rejects.toThrow("do not replay");
      expect(setup.calls).toHaveLength(2);
      expect(readFileSync(setup.file, "utf8")).not.toContain("private transport");
    } finally { setup.dispose(); }
  });

  test("requested-save failure is unsent, while receipt-save failure is requested and cannot be retried", async () => {
    for (const failedPhase of ["reserve_requested", "registered"] as const) {
      const setup = await fixture();
      try {
        const journal: ShowRegistrationJournal = { ...setup.journal, save: (state) => {
          if (state.phase === failedPhase) throw new Error("private disk exception");
          setup.journal.save(state);
        } };
        await expect(runShowRegistration(journal, setup.effects)).rejects.toThrow("disk exception");
        expect(setup.journal.load().phase).toBe(failedPhase === "registered" ? "reserve_requested" : "prepared");
        expect(setup.calls).toHaveLength(failedPhase === "registered" ? 1 : 0);
        if (failedPhase === "registered") {
          await expect(runShowRegistration(setup.journal, setup.effects)).rejects.toThrow("do not replay");
          expect(setup.calls).toHaveLength(1);
        } else {
          await runShowRegistration(setup.journal, setup.effects);
          expect(setup.calls).toHaveLength(1);
        }
        expect(readFileSync(setup.file, "utf8")).not.toContain("private disk");
      } finally { setup.dispose(); }
    }
  });

  test("wrong effect identities fail before HTTP and forged receipts retain requested state", async () => {
    const setup = await fixture();
    try {
      await expect(runShowRegistration(setup.journal, { ...setup.effects,
        identity: { ...setup.effects.identity, worker_name: "another-worker" } })).rejects.toThrow("another service");
      expect(setup.calls).toHaveLength(0);
      expect(setup.journal.load().phase).toBe("prepared");
      await expect(runShowRegistration(setup.journal, { ...setup.effects, reserve: async () => ({ schema_version: 1,
        service_id: "service", show_id: "another-show", reservation_id: setup.request.reservation_id, result: "reserved", control_ready: true }) })).rejects.toThrow("differs");
      expect(setup.journal.load().phase).toBe("reserve_requested");
      await expect(runShowRegistration(setup.journal, setup.effects)).rejects.toThrow("do not replay");
      expect(setup.calls).toHaveLength(0);
    } finally { setup.dispose(); }
  });

  test("identity/request/phase cannot change, skip or regress; unlocked writes are rejected", async () => {
    const setup = await fixture();
    try {
      const prepared = setup.journal.load();
      expect(() => setup.journal.save(prepared)).toThrow("exclusive client lock");
      expect(() => createShowRegistrationJournal(setup.root, setup.config, { ...setup.request, reservation_id: crypto.randomUUID() })).toThrow("different frozen");
      expect(() => createShowRegistrationJournal(setup.root, { ...setup.config, worker_name: "another-worker", workers_dev_base_url: "https://another-worker.example.workers.dev" }, setup.request)).toThrow("different frozen");
      await setup.journal.exclusively(async () => {
        expect(() => setup.journal.save({ ...prepared, phase: "registered", receipt: { schema_version: 1, service_id: "service",
          show_id: "new-show", reservation_id: setup.request.reservation_id, result: "reserved", control_ready: true } })).toThrow("skip phases");
        expect(() => setup.journal.save({ ...prepared, phase: "reserve_requested",
          reserve: { ...prepared.reserve, reservation_id: crypto.randomUUID() } })).toThrow("cannot change");
        setup.journal.save({ ...prepared, phase: "reserve_requested" });
        expect(() => setup.journal.save(prepared)).toThrow("cannot change");
      });
      expect(() => validateShowRegistrationState({ ...prepared, arbitrary: "private" })).toThrow();
      expect(() => validateShowRegistrationState({ ...prepared, phase: "registered" })).toThrow("inconsistent");
    } finally { setup.dispose(); }
  });

  test("exclusive lock covers live HTTP and result persistence; leftover locks are observed but never removed or expired", async () => {
    const setup = await fixture();
    let continueRequest!: () => void;
    let started!: () => void;
    const pendingRequest = new Promise<void>((resolve) => { continueRequest = resolve; });
    const requestStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = runShowRegistration(setup.journal, { ...setup.effects, reserve: async (request) => {
      started(); await pendingRequest; return setup.effects.reserve(request);
    } });
    try {
      try {
        await requestStarted;
        expect(readLocalShowRegistration(setup.root, setup.config, "new-show").lock_present).toBe(true);
        await expect(runShowRegistration(setup.journal, setup.effects)).rejects.toThrow();
        expect(setup.calls).toHaveLength(0);
      } finally { continueRequest(); await pending; }
      writeFileSync(`${setup.file}.lock`, "keep unknown lock", { mode: 0o600 });
      const before = readFileSync(setup.file);
      await expect(runShowRegistration(setup.journal, setup.effects)).rejects.toThrow();
      expect(readFileSync(`${setup.file}.lock`, "utf8")).toBe("keep unknown lock");
      expect(readFileSync(setup.file)).toEqual(before);
      expect(readLocalOperationStatus(setup.root, setup.config, "show-registration", "new-show")).toMatchObject({ lock_present: true,
        remote_state_checked: false, authorizes_mutation: false, authorizes_recovery: false });
    } finally { setup.dispose(); }
  });

  test("offline missing lookup creates no records and foreign/symlink/corrupt journals are not adopted or overwritten", async () => {
    const setup = await fixture();
    try {
      const before = readdirSync(dirname(setup.file)).sort();
      expect(readLocalShowRegistration(setup.root, setup.config, "other-show")).toEqual({ client_state: null, lock_present: false, remote_state_checked: false });
      expect(readdirSync(dirname(setup.file)).sort()).toEqual(before);
      expect(() => readLocalShowRegistration(setup.root, { ...setup.config, workers_dev_base_url: "https://test-worker.foreign.workers.dev" }, "new-show")).toThrow("another service");
      const original = readFileSync(setup.file);
      symlinkSync(setup.file, join(dirname(setup.file), "linked-show.json"));
      expect(() => readLocalOperationStatus(setup.root, setup.config, "show-registration", "linked-show")).toThrow("could not be verified");
      expect(readFileSync(setup.file)).toEqual(original);
      writeFileSync(setup.file, "private invalid json");
      expect(() => readLocalOperationStatus(setup.root, setup.config, "show-registration", "new-show")).toThrow("could not be verified");
      expect(() => createShowRegistrationJournal(setup.root, setup.config, setup.request)).toThrow();
      expect(readFileSync(setup.file, "utf8")).toBe("private invalid json");
    } finally { setup.dispose(); }
  });

  test("offline source CLI reports Show registration state and lock without credentials, admin secrets, network or file changes", async () => {
    const setup = await fixture();
    try {
      writeFileSync(join(setup.root, "castloop.toml"), stringifyToml(setup.config));
      writeFileSync(`${setup.file}.lock`, "keep lock", { mode: 0o600 });
      const before = [readFileSync(setup.file), readFileSync(`${setup.file}.lock`), readFileSync(join(setup.root, "castloop.toml"))];
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "index.ts"), "local-operation-status", "show-registration", "new-show"], {
        cwd: setup.root, env: { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" }, stdout: "pipe", stderr: "pipe", timeout: 15000,
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({ family: "show-registration", operation_id: "new-show",
        client_state: { phase: "prepared", reserve: setup.request }, lock_present: true, remote_state_checked: false,
        authorizes_mutation: false, authorizes_recovery: false });
      expect([readFileSync(setup.file), readFileSync(`${setup.file}.lock`), readFileSync(join(setup.root, "castloop.toml"))]).toEqual(before);
      expect(setup.calls).toHaveLength(0);
    } finally { setup.dispose(); }
  });
});
