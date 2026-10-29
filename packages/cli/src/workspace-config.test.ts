import { afterEach, expect, spyOn, test } from "bun:test";
import { stringify as stringifyToml } from "@iarna/toml";
import { loadWorkspaceConfig } from "./workspace-config";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const queueConfig = { schema_version: 1 as const, service_id: "service", account_id: "a".repeat(32),
  bucket_name: "private-bucket", worker_name: "test-worker", queue_name: "test-queue", dlq_name: "test-dlq",
  public_base_url: "https://test-worker.example.workers.dev" };
const sqliteConfig = { schema_version: 2 as const, storage_layout: "show-v1" as const, publication_protocol: "sqlite-sequential-v1" as const,
  service_id: queueConfig.service_id, account_id: queueConfig.account_id, bucket_name: queueConfig.bucket_name,
  worker_name: queueConfig.worker_name, public_base_url: queueConfig.public_base_url,
  workers_dev_base_url: queueConfig.public_base_url };

function fixture(source: string | Buffer) {
  const root = mkdtempSync("/tmp/opencode/castloop-workspace-config-");
  roots.push(root);
  const file = join(root, "castloop.toml");
  writeFileSync(file, source);
  return { root, file };
}

test("workspace config accepts only strict SQLite settings and valid UTF-8 comments", async () => {
  for (const config of [sqliteConfig]) {
    const source = `${stringifyToml(config)}\n# 日本語😀\n`;
    const setup = fixture(source);
    expect(await loadWorkspaceConfig(setup.root)).toEqual(config);
    expect(readFileSync(setup.file, "utf8")).toBe(source);
    writeFileSync(setup.file, `${source}api_token = "not-allowed"\n`);
    await expect(loadWorkspaceConfig(setup.root)).rejects.toThrow();
  }
  const setup = fixture(stringifyToml(queueConfig).replace("schema_version = 1", "schema_version = 3"));
  await expect(loadWorkspaceConfig(setup.root)).rejects.toThrow();
});

test("version 1 service configs are explicitly rejected without conversion", async () => {
  for (const config of [{ schema_version: 1 }, queueConfig, { ...queueConfig, workers_dev_base_url: queueConfig.public_base_url }]) {
    const source = stringifyToml(config), setup = fixture(source);
    await expect(loadWorkspaceConfig(setup.root)).rejects.toThrow("use a compatible v0.5.x CLI/Worker");
    expect(readFileSync(setup.file, "utf8")).toBe(source);
    expect(readdirSync(setup.root)).toEqual(["castloop.toml"]);
  }
});

test("workspace config refuses symbolic links without following or modifying their targets", async () => {
  const setup = fixture(stringifyToml(queueConfig));
  const target = join(setup.root, "target.toml");
  writeFileSync(target, readFileSync(setup.file));
  rmSync(setup.file);
  symlinkSync(target, setup.file);
  await expect(loadWorkspaceConfig(setup.root)).rejects.toThrow("Cannot read castloop.toml");
  expect(readFileSync(target, "utf8")).toBe(stringifyToml(queueConfig));
});

test("formal CLI rejects old service settings before network, build or local state changes", () => {
  const allCommands = [["init"], ["init", "--publication-protocol", "sqlite-sequential-v1"], ["init", "--service-id", "different"],
    ["service-status"], ["preview-show-lifecycle", "daily", "unpublish"],
    ["deploy"], ["create-show", "daily", "--site-url", "https://example.com"], ["preview-show", "daily"], ["publish-show", "daily"],
    ["list-shows"], ["target-show", "daily"], ["publish-rss-import", "missing-import"]];
  const entrypointCommands = [["init"], ["service-status"], ["publish-rss-import", "missing-import"]];
  for (const [old, commands] of [
    [{ schema_version: 1 }, entrypointCommands],
    [queueConfig, allCommands],
    [{ ...queueConfig, workers_dev_base_url: queueConfig.public_base_url }, entrypointCommands],
  ] as const) {
    const setup = fixture(stringifyToml(old));
    const state = join(setup.root, ".castloop"); mkdirSync(state);
    const retained = join(state, "retained.json"); writeFileSync(retained, "private retained journal");
    const preload = join(setup.root, "deny-io.ts");
    writeFileSync(preload, `globalThis.fetch = async () => { console.error("UNEXPECTED_IO"); throw new Error("Forbidden network"); };
Bun.build = async () => { console.error("UNEXPECTED_IO"); throw new Error("Forbidden build"); };`);
    const before = readdirSync(setup.root).sort(), source = readFileSync(setup.file);
    for (const args of commands) {
      const result = Bun.spawnSync([process.execPath, "--preload", preload, join(import.meta.dir, "index.ts"), ...args], {
        cwd: setup.root, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: queueConfig.account_id, CLOUDFLARE_API_TOKEN: "test-token" }, timeout: 5000,
      });
      expect(result.exitCode, `${args.join(" ")} with ${JSON.stringify(old)}`).toBe(1); expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("use a compatible v0.5.x CLI/Worker");
      expect(result.stderr.toString()).not.toContain("UNEXPECTED_IO");
      expect(readdirSync(setup.root).sort()).toEqual(before);
      expect(readdirSync(state)).toEqual(["retained.json"]);
      expect(readFileSync(retained, "utf8")).toBe("private retained journal");
      expect(readFileSync(setup.file)).toEqual(source);
    }
  }
}, 15000);

test("workspace config enforces the byte budget before parsing otherwise valid TOML", async () => {
  const source = `${stringifyToml(sqliteConfig)}\n#`;
  const setup = fixture(source.padEnd(16384, "x"));
  expect(await loadWorkspaceConfig(setup.root)).toEqual(sqliteConfig);
  for (const bytes of [Buffer.from(source.padEnd(16385, "x")), Buffer.alloc(0)]) {
    writeFileSync(setup.file, bytes);
    await expect(loadWorkspaceConfig(setup.root)).rejects.toThrow("Cannot read castloop.toml");
    expect(readFileSync(setup.file)).toEqual(bytes);
  }
});

test("legacy SQLite layouts fail before network, bundle building or local journal creation", () => {
  const { storage_layout, ...legacy } = sqliteConfig;
  const setup = fixture(stringifyToml(legacy));
  const preload = join(setup.root, "deny-layout-io.ts");
  writeFileSync(preload, `globalThis.fetch = async () => { throw new Error("UNEXPECTED_IO"); };
Bun.build = async () => { throw new Error("UNEXPECTED_BUILD"); };`);
  const before = readdirSync(setup.root).sort(), source = readFileSync(setup.file);
  for (const args of [["init"], ["service-status"], ["preview-show-lifecycle", "daily", "unpublish"], ["deploy"]]) {
    const result = Bun.spawnSync([process.execPath, "--preload", preload, join(import.meta.dir, "index.ts"), ...args], { cwd: setup.root, timeout: 5000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Legacy service layouts cannot be updated or migrated");
    expect(result.stderr.toString()).not.toContain("UNEXPECTED_");
    expect(readdirSync(setup.root).sort()).toEqual(before);
    expect(readFileSync(setup.file)).toEqual(source);
  }
});

test("workspace config rejects invalid UTF-8 even inside ignored TOML comments", async () => {
  const source = Buffer.concat([Buffer.from(`${stringifyToml(queueConfig)}\n# `), Buffer.from([0xff])]);
  const setup = fixture(source);
  await expect(loadWorkspaceConfig(setup.root)).rejects.toThrow("Cannot read castloop.toml");
  expect(readFileSync(setup.file)).toEqual(source);
});

test("workspace config rejects missing files, directories and FIFOs without waiting for writers", async () => {
  const setup = fixture("");
  rmSync(setup.file);
  await expect(loadWorkspaceConfig(setup.root)).rejects.toThrow("Cannot read castloop.toml");
  mkdirSync(setup.file);
  await expect(loadWorkspaceConfig(setup.root)).rejects.toThrow("Cannot read castloop.toml");
  rmSync(setup.file, { recursive: true });
  expect(Bun.spawnSync(["mkfifo", setup.file]).exitCode).toBe(0);
  await expect(loadWorkspaceConfig(setup.root)).rejects.toThrow("Cannot read castloop.toml");
}, 3000);

test("workspace config rejects growth, truncation and same-size changes and closes its descriptor", async () => {
  const originalOpen = fsPromises.open;
  for (const change of ["grow", "truncate", "same-size", "oversize", "read-error"] as const) {
    const setup = fixture(`${stringifyToml(queueConfig)}\n# before\n`);
    const handles: FileHandle[] = [];
    const open = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      handles.push(handle);
      const snapshot = await handle.stat({ bigint: true });
      spyOn(handle, "stat").mockResolvedValueOnce(snapshot);
      if (change === "grow") appendFileSync(setup.file, "# later\n");
      else if (change === "truncate") writeFileSync(setup.file, "");
      else if (change === "oversize") appendFileSync(setup.file, "x".repeat(16384));
      else if (change === "read-error") spyOn(handle, "read").mockRejectedValueOnce(new Error("Injected read failure"));
      else {
        writeFileSync(setup.file, `${stringifyToml(queueConfig)}\n# after!\n`);
        utimesSync(setup.file, new Date(0), new Date(0));
      }
      return handle;
    });
    try {
      let failure: unknown;
      try { await loadWorkspaceConfig(setup.root); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error) || !(failure.cause instanceof Error)) throw new Error("Expected a bounded-read failure");
      expect(failure.cause.message).toContain(change === "oversize" ? "exceeds its size limit" :
        change === "read-error" ? "Injected read failure" : "changed during validation");
      expect(handles).toHaveLength(1);
      expect(handles[0]!.fd).toBe(-1);
    } finally { open.mockRestore(); }
  }
});

test("formal CLI rejects an unsafe workspace before network requests or local state creation", () => {
  const setup = fixture(stringifyToml(queueConfig));
  const target = join(setup.root, "target.toml");
  writeFileSync(target, readFileSync(setup.file));
  rmSync(setup.file); symlinkSync(target, setup.file);
  const preload = join(setup.root, "deny-network.ts");
  writeFileSync(preload, 'globalThis.fetch = async () => { console.error("UNEXPECTED_NETWORK_REQUEST"); throw new Error("Network forbidden in this test"); };\n');
  const before = readdirSync(setup.root).sort();
  for (const args of [["service-status"], ["init"], ["init", "--publication-protocol", "sqlite-sequential-v1"], ["publish-rss-import", "import"]]) {
    const result = Bun.spawnSync([process.execPath, "--preload", preload, join(import.meta.dir, "index.ts"), ...args], {
      cwd: setup.root, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: queueConfig.account_id, CLOUDFLARE_API_TOKEN: "test-token" }, timeout: 5000,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("Cannot read castloop.toml");
    expect(result.stderr.toString()).not.toContain("UNEXPECTED_NETWORK_REQUEST");
    expect(readdirSync(setup.root).sort()).toEqual(before);
  }
  expect(readFileSync(target, "utf8")).toBe(stringifyToml(queueConfig));
});
