import { describe, expect, test } from "bun:test";
import { migrationSetupClientStateSchema, stringifyToml } from "@castloop/shared";
import { readLocalMigrationSetup } from "./migration-setup-journal";
import { migrationSetupFixture } from "./test-support/migration-setup";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

describe("offline read-only migration setup inspection", () => {
  test("missing records create no files, while an orphan lock is reported without being removed", async () => {
    const setup = await migrationSetupFixture();
    const root = mkdtempSync("/tmp/opencode/castloop-setup-empty-");
    try {
      expect(readLocalMigrationSetup(root, setup.config)).toEqual({ client_state: null, lock_present: false, remote_state_checked: false });
      expect(readdirSync(root)).toEqual([]);
      const before = readFileSync(setup.file, "utf8");
      rmSync(setup.file);
      writeFileSync(`${setup.file}.lock`, "", { mode: 0o600 });
      expect(readLocalMigrationSetup(setup.root, setup.config)).toEqual({ client_state: null, lock_present: true, remote_state_checked: false });
      expect(existsSync(`${setup.file}.lock`)).toBe(true);
      expect(before).toContain('"phase":"prepared"');
    } finally { setup.dispose(); rmSync(root, { recursive: true }); }
  });

  test("a live lock does not prevent observation or license phase changes, token release or HTTP", async () => {
    const setup = await migrationSetupFixture();
    try {
      await setup.journal.exclusively(async () => {
        setup.journal.save({ ...setup.journal.load(), phase: "admission_requested" });
        const before = readFileSync(setup.file, "utf8");
        const result = readLocalMigrationSetup(setup.root, setup.config);
        expect(result.client_state?.phase).toBe("admission_requested");
        expect(result.lock_present).toBe(true);
        expect(result.remote_state_checked).toBe(false);
        expect(readFileSync(setup.file, "utf8")).toBe(before);
        expect(setup.calls).toEqual([]);
      });
    } finally { setup.dispose(); }
  });

  test("foreign identity, corrupt schema and oversized local records are refused", async () => {
    const setup = await migrationSetupFixture();
    try {
      expect(() => readLocalMigrationSetup(setup.root, { ...setup.config, account_id: "b".repeat(32) })).toThrow("another service");
      writeFileSync(setup.file, JSON.stringify({ ...setup.journal.load(), secret: "not-allowed" }));
      expect(() => readLocalMigrationSetup(setup.root, setup.config)).toThrow();
      writeFileSync(setup.file, "x".repeat(17000));
      expect(() => readLocalMigrationSetup(setup.root, setup.config)).toThrow("budget");
      writeFileSync(setup.file, "{");
      expect(() => readLocalMigrationSetup(setup.root, setup.config)).toThrow();
    } finally { setup.dispose(); }
  });

  test("migration-status --local needs no secrets or Cloudflare credentials and never attempts fetch", async () => {
    const setup = await migrationSetupFixture();
    try {
      writeFileSync(join(setup.root, "castloop.toml"), stringifyToml(setup.config));
      const preload = join(setup.root, "no-network.js");
      writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("NETWORK_NOT_ALLOWED"); };');
      const before = readFileSync(setup.file, "utf8");
      writeFileSync(`${setup.file}.lock`, "", { mode: 0o600 });
      const run = (args: string[]) => Bun.spawnSync([process.execPath, "--preload", preload, join(import.meta.dir, "index.ts"), ...args], {
        cwd: setup.root, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" },
      });
      const result = run(["migration-status", "--local"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      const output: unknown = JSON.parse(result.stdout.toString());
      if (!output || typeof output !== "object" || !("client_state" in output) || !("lock_present" in output) || !("remote_state_checked" in output)) {
        throw new Error("Invalid local migration inspection output");
      }
      expect(migrationSetupClientStateSchema.parse(output.client_state).phase).toBe("prepared");
      expect(output.lock_present).toBe(true);
      expect(output.remote_state_checked).toBe(false);
      expect(existsSync(join(setup.root, ".castloop", "secrets.json"))).toBe(false);
      expect(readFileSync(setup.file, "utf8")).toBe(before);
      expect(existsSync(`${setup.file}.lock`)).toBe(true);
      for (const args of [["migration-status", "--local", "--local"], ["migration-status", "--local", "true"], ["migration-status", "--repair", "true"]]) {
        const invalid = run(args);
        expect(invalid.exitCode).toBe(1);
        expect(invalid.stderr.toString()).not.toContain("NETWORK_NOT_ALLOWED");
      }
    } finally { setup.dispose(); }
  });
});
