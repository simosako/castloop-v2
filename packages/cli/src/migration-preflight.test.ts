import { describe, expect, test } from "bun:test";
import { legacyWorkerInspectionSchema, stringifyToml } from "@castloop/shared";
import { bridgeDeploymentFixture } from "./test-support/migration-bridge";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const entrypoint = join(import.meta.dir, "index.ts");
const preload = join(import.meta.dir, "test-support", "migration-preflight-fetch.ts");
const versionId = "5a2601ec-9d1a-497e-90f8-fdb1d2096cfd";

function runPreflight(scenario: string, args: string[] = [versionId], customOrigin = false) {
  const root = mkdtempSync("/tmp/opencode/castloop-preflight-cli-");
  const setup = bridgeDeploymentFixture();
  const config = { ...setup.config, ...(customOrigin ? { public_base_url: "https://podcast.example.com" } : {}) };
  writeFileSync(join(root, "castloop.toml"), stringifyToml(config));
  mkdirSync(join(root, ".castloop"), { mode: 0o700 });
  for (const name of ["secrets.json", "state.json"]) writeFileSync(join(root, ".castloop", name), "not valid JSON", { mode: 0o600 });
  const files = ["castloop.toml", ".castloop/secrets.json", ".castloop/state.json"];
  const snapshot = files.map((name) => ({ name, bytes: readFileSync(join(root, name)), stat: statSync(join(root, name)) }));
  try {
    const result = Bun.spawnSync([process.execPath, "--preload", preload, entrypoint, "migration-preflight", ...args], {
      cwd: root, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.account_id,
        CLOUDFLARE_API_TOKEN: "fake-preflight-token", CASTLOOP_TEST_PREFLIGHT: scenario },
      stdout: "pipe", stderr: "pipe", timeout: 15000,
    });
    for (const file of snapshot) {
      expect(readFileSync(join(root, file.name))).toEqual(file.bytes);
      expect(statSync(join(root, file.name)).mtimeMs).toBe(file.stat.mtimeMs);
    }
    expect(readdirSync(root).sort()).toEqual([".castloop", "castloop.toml"]);
    expect(readdirSync(join(root, ".castloop")).sort()).toEqual(["secrets.json", "state.json"]);
    const stderr = result.stderr.toString();
    const trace = stderr.split("\n").find((line) => line.startsWith("PREFLIGHT_TEST_REQUESTS "));
    expect(trace).toBeDefined();
    const requests = JSON.parse(trace!.slice("PREFLIGHT_TEST_REQUESTS ".length)) as string[];
    expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr, requests, config };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("read-only migration-preflight CLI", () => {
  test("accepts observed legacy omissions through ten GETs without reading admin secrets or changing local state", () => {
    const result = runPreflight("stable");
    expect(result.exitCode).toBe(0);
    const report = legacyWorkerInspectionSchema.parse(JSON.parse(result.stdout));
    expect(report).toMatchObject({ service_id: "probe", worker_name: "probe-worker", legacy_worker_version_id: versionId,
      legacy_cross_version_cache: "disabled", legacy_previews_enabled: false, snapshot_only: true,
      authorizes_deployment: false, authorizes_mutation: false, authorizes_recovery: false, authorizes_migration_completion: false });
    expect(result.requests).toHaveLength(10);
    expect(result.requests.filter((request) => request.endsWith("/scripts/probe-worker"))).toHaveLength(2);
    for (const privateValue of [result.config.account_id, "private@example.com", "private-source", "fake-preflight-token", "namespace_id", "original-kv"]) {
      expect(result.stdout).not.toContain(privateValue);
    }
  });

  test("rejects source/settings drift and unknown exports without creating journals or exposing source", () => {
    for (const scenario of ["script-drift", "settings-drift", "named-export"]) {
      const result = runPreflight(scenario);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(scenario === "named-export" ? "no deployment is authorized" : "changed");
      expect(result.stderr).not.toContain("private-source");
    }
  });

  test("rejects wrong versions, invalid arguments and unsupported origins before any mutation", () => {
    const wrongVersion = runPreflight("stable", [crypto.randomUUID()]);
    expect(wrongVersion.exitCode).toBe(1);
    expect(wrongVersion.requests).toHaveLength(1);
    for (const args of [["invalid"], [versionId, "--force", "true"], [versionId, "extra"], []]) {
      const result = runPreflight("stable", args);
      expect(result.exitCode).toBe(1);
      expect(result.requests).toHaveLength(0);
    }
    const origin = runPreflight("stable", [versionId], true);
    expect(origin.exitCode).toBe(1);
    expect(origin.requests).toHaveLength(0);
  });
});
