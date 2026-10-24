import { expect, test } from "bun:test";
import { adminConfigSchema, parseAdminConfig } from "../../shared/src/admin-config";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import { loadAdminConfig } from "./admin-config";
import { loadWorkspaceConfig } from "./workspace-config";
import { inputSchema } from "./agent-schema";
import { inputTemplate } from "./input-templates";
import { diagnoseLocal } from "./doctor";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("administrator configuration is optional, strict and separate from service identity", async () => {
  const root = mkdtempSync("/tmp/opencode/admin-config-");
  try {
    expect(await loadAdminConfig(root)).toEqual({ schema_version: 1 });
    expect(readdirSync(root)).toEqual([]);
    expect(parseAdminConfig("schema_version = 1\n")).toEqual({ schema_version: 1 });
    expect(parseAdminConfig(inputTemplate("admin-config"))).toEqual({ schema_version: 1, timezone: "Asia/Tokyo" });
    expect(inputSchema("admin-config")).toMatchObject({ additionalProperties: false, required: ["schema_version"] });
    for (const input of [{}, { schema_version: 2 }, { schema_version: 1, timezone: null }, { schema_version: 1, account_id: "private" },
      { schema_version: 1, json: true }, { schema_version: 1, default_show: "daily" }, { schema_version: 1, allow_publication: true }]) {
      expect(adminConfigSchema.safeParse(input).success).toBe(false);
    }
    const source = 'schema_version = 2\nstorage_layout = "show-v1"\npublication_protocol = "sqlite-sequential-v1"\nservice_id = "test"\n' +
      'account_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\nbucket_name = "private-bucket"\nworker_name = "test-worker"\n' +
      'public_base_url = "https://test-worker.example.workers.dev"\nworkers_dev_base_url = "https://test-worker.example.workers.dev"\n';
    writeFileSync(join(root, "castloop.toml"), source);
    const before = await sqliteServiceConfigHash(await loadWorkspaceConfig(root));
    for (const zone of ["Asia/Tokyo", "America/New_York", "UTC"]) {
      writeFileSync(join(root, "castloop-admin.toml"), `schema_version = 1\ntimezone = "${zone}"\n`);
      expect((await loadAdminConfig(root)).timezone).toBe(zone);
      expect(await sqliteServiceConfigHash(await loadWorkspaceConfig(root))).toBe(before);
    }
    expect(readdirSync(root).sort()).toEqual(["castloop-admin.toml", "castloop.toml"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid administrator configuration is not treated as an absent preference", async () => {
  const root = mkdtempSync("/tmp/opencode/admin-config-invalid-"), file = join(root, "castloop-admin.toml");
  try {
    for (const content of ["", " ".repeat(16385), Buffer.from([0xff]), 'schema_version = 1\ntimezone = "JST"\n',
      'schema_version = 1\ntimezone = "Unknown/City"\n', 'schema_version = 1\ntimezone = "Asia/Tokyo"\nsecret = "private"\n']) {
      writeFileSync(file, content); await expect(loadAdminConfig(root)).rejects.toThrow();
    }
    unlinkSync(file);
    const target = join(root, "original.toml"); writeFileSync(target, "schema_version = 1\n");
    symlinkSync(target, file); await expect(loadAdminConfig(root)).rejects.toThrow(); unlinkSync(file);
    symlinkSync(join(root, "missing"), file); await expect(loadAdminConfig(root)).rejects.toThrow(); unlinkSync(file);
    mkdirSync(file); await expect(loadAdminConfig(root)).rejects.toThrow(); rmSync(file, { recursive: true });
    execFileSync("mkfifo", [file]); await expect(loadAdminConfig(root)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor diagnoses optional administrator configuration without writes or input disclosure", async () => {
  const root = mkdtempSync("/tmp/opencode/admin-config-doctor-");
  try {
    const absent = await diagnoseLocal(root, {});
    expect(absent.checks.find((entry) => entry.id === "admin-config")).toMatchObject({ status: "pass", code: "server_timezone_default" });
    expect(readdirSync(root)).toEqual([]);
    writeFileSync(join(root, "castloop-admin.toml"), 'schema_version = 1\ntimezone = "Asia/Tokyo"\n');
    expect((await diagnoseLocal(root, {})).checks.find((entry) => entry.id === "admin-config")).toMatchObject({ status: "pass", code: "admin_timezone_configured" });
    writeFileSync(join(root, "castloop-admin.toml"), 'timezone = "private-token"\n');
    const invalid = await diagnoseLocal(root, {});
    expect(invalid.checks.find((entry) => entry.id === "admin-config")).toMatchObject({ status: "fail", code: "invalid_admin_config" });
    expect(JSON.stringify(invalid)).not.toContain("private-token");
    expect(readdirSync(root)).toEqual(["castloop-admin.toml"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
