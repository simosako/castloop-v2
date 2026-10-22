import { expect, test } from "bun:test";
import { sqliteServiceConfigHash, stringifyToml } from "@castloop/shared";
import { COMMAND_HELP, commandHelp } from "./help";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const entrypoint = join(import.meta.dir, "index.ts");

test("every subcommand displays help without a workspace or credentials", () => {
  const directory = mkdtempSync("/tmp/opencode/castloop-help-");
  try {
    for (const command of Object.keys(COMMAND_HELP)) {
      const result = Bun.spawnSync([process.execPath, entrypoint, command, "--help"], {
        cwd: directory, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(`Usage: castloop ${command}`);
      expect(result.stderr.toString()).toBe("");
    }
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true }); }
}, 15000);

test("help works after positional arguments, with -h, and with help COMMAND", () => {
  for (const args of [["create-show", "daily", "--help"], ["init", "--service-id", "daily", "--help"],
    ["create-episode", "-h"], ["help", "init"], ["-h"]]) {
    const result = Bun.spawnSync([process.execPath, entrypoint, ...args]);
    expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toContain("Usage: castloop");
    expect(result.stderr.toString()).toBe("");
  }
  expect(commandHelp("init")).toContain("no protocol option is required");
  expect(commandHelp("init")).toContain("schema_version=2");
});

test("security containment instructions name supported current commands and explicit Show pause arguments", () => {
  const policy = readFileSync(join(import.meta.dir, "../../..", "SECURITY.md"), "utf8");
  const commands = [...policy.matchAll(/`castloop ([a-z][a-z-]*)([^`]*)`/g)];
  expect(commands.length).toBeGreaterThan(0);
  for (const [, name] of commands) expect(Object.hasOwn(COMMAND_HELP, name)).toBe(true);
  expect(policy).toContain("`castloop show-pause SHOW_ID PAUSE_UUID`");
  expect(commandHelp("show-pause")).toContain("PAUSE_UUID");
  expect(policy).not.toContain("castloop service-pause");
});

test("removed commands, unsupported families and malformed arguments fail before workspace access", () => {
  const directory = mkdtempSync("/tmp/opencode/castloop-help-invalid-");
  try {
    for (const args of [["unknown", "--help"], ["help", "unknown"], ["init", "--service-id"], ["init", "--schema-version", "1"],
      ["init", "--publication-protocol", "queue-management-v1"], ["list-episodes"], ["list-episodes", "--json"],
      ["list-shows", "unexpected"], ["list-episodes", "daily", "extra"], ["list-shows", "--cursor"], ["list-shows", "--local", "true"],
      ["domain", "list"], ["retry-job", "id"], ["release-job", "id"], ["publication-retry", "id"], ["publication-release", "id"],
      ["lifecycle-retry", "id", "hash", "confirm"], ["update-service-continue", "id"], ["local-operation-status", "publication", "id"],
      ["operation-status", "publication", "id"], ["operation-status", "staging", "id"], ["operation-status", "show-registration", "id"],
      ["preview-show-lifecycle", "daily", "delete"], ["preview-episode-lifecycle", "daily", "first", "delete"],
      ["lifecycle-execute", "plan.json", "hash", "confirm-delete-retain-records"], ["update-service-drop-completion", "id"],
      ["deploy", "--force", "true"], ["service-resume"], ["publish-episode", "first", "one.mp3", "two.mp3"], ["init", "--__proto__", "value"],
      ["import-rss"], ["import-rss", "show", "https://example.com/feed"],
      ["import-rss", "show", "https://example.com/feed", "--dry-run", "--output", "dir"],
      ["import-rss", "show", "file:///etc/passwd", "--dry-run"], ["publish-rss-import"], ["publish-rss-import", "dir", "--force", "true"]]) {
      const result = Bun.spawnSync([process.execPath, entrypoint, ...args], { cwd: directory, timeout: 5000 });
      expect(result.exitCode, args.join(" ")).toBe(1);
      if (args.includes("--json")) {
        expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: false, error: { outcome: "not_started" } });
        expect(result.stderr.toString()).toBe("");
      } else expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).not.toContain("ENOENT");
    }
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true }); }
}, 15000);

test("formal list commands pass SQLite options, format text/JSON and preserve workspace state", async () => {
  const directory = mkdtempSync("/tmp/opencode/castloop-list-entrypoint-");
  const state = join(directory, ".castloop"), preload = join(directory, "mock-fetch.ts");
  const config = { schema_version: 2 as const, storage_layout: "show-v1" as const, publication_protocol: "sqlite-sequential-v1" as const,
    service_id: "service", account_id: "a".repeat(32), bucket_name: "private-bucket", worker_name: "test-worker",
    public_base_url: "https://test-worker.example.workers.dev", workers_dev_base_url: "https://test-worker.example.workers.dev" };
  const source = stringifyToml(config), secret = JSON.stringify({ CASTLOOP_ADMIN_KEY: "private-secret" });
  mkdirSync(state, { mode: 0o700 }); writeFileSync(join(state, "secrets.json"), secret, { mode: 0o600 });
  writeFileSync(join(directory, "castloop.toml"), source);
  writeFileSync(preload, `import assert from "node:assert/strict";
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://test-worker.example.workers.dev/admin/sqlite-service/catalog");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["X-Castloop-Key"], "private-secret");
  assert.deepEqual(JSON.parse(init.body), JSON.parse(process.env.CASTLOOP_TEST_REQUEST));
  return Response.json(JSON.parse(process.env.CASTLOOP_TEST_RESPONSE), { headers: { "Cache-Control": "no-store" } });
};`);
  const common = { protocol: "sqlite-sequential-v1", service_id: "service", worker_version_id: crypto.randomUUID(),
    service_config_sha256: await sqliteServiceConfigHash(config), snapshot_only: true, authorizes_recovery: false, state: "open", next_cursor: null };
  const show = { show_id: "daily", lifecycle: "published", unfinished_operation: false,
    title: "Title\n\u001b[31m", feed_url: `${config.public_base_url}/podcasts/daily/feed.xml` };
  const episode = { episode_id: "first", lifecycle: "published", title: "First Episode", published_at: "2026-10-04T12:00:00Z" };
  try {
    for (const args of [["list-shows"], ["list-episodes", "daily"],
      ["list-shows", "--include-deleted", "--cursor", "next-page", "--json"], ["list-episodes", "daily", "--json"]]) {
      const shows = args[0] === "list-shows";
      const request = { kind: shows ? "show" : "episode", ...(shows ? {} : { show_id: "daily" }),
        include_deleted: args.includes("--include-deleted"), ...(args.includes("--cursor") ? { cursor: "next-page" } : {}) };
      const response = shows ? { ...common, request, shows: [show] } : { ...common, request,
        show: { show_id: "daily", lifecycle: "published", unfinished_operation: false }, episodes: [episode] };
      const result = Bun.spawnSync([process.execPath, "--preload", preload, entrypoint, ...args], { cwd: directory,
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "",
          CASTLOOP_TEST_REQUEST: JSON.stringify(request), CASTLOOP_TEST_RESPONSE: JSON.stringify(response) } });
      expect(result.exitCode, result.stderr.toString()).toBe(0); expect(result.stderr.toString()).toBe("");
      if (args.includes("--json")) {
        const output = JSON.parse(result.stdout.toString());
        expect(output).toMatchObject({ contract_version: 1, ok: true, operation: null });
        expect(output.result).toEqual(response);
      }
      else {
        expect(result.stdout.toString()).toContain(shows ? "SHOW_ID\tSTATE" : "EPISODE_ID\tSTATE");
        expect(result.stdout.toString()).not.toContain("\u001b");
        if (shows) expect(result.stdout.toString()).toContain("Title\\n\\u001b[31m");
      }
    }
    expect(readdirSync(state)).toEqual(["secrets.json"]);
    expect(readFileSync(join(state, "secrets.json"), "utf8")).toBe(secret);
    expect(readFileSync(join(directory, "castloop.toml"), "utf8")).toBe(source);
  } finally { rmSync(directory, { recursive: true }); }
});

test("fresh initialization never adopts retained local state or creates administrator credentials", () => {
  const directory = mkdtempSync("/tmp/opencode/castloop-legacy-entrypoint-");
  const state = join(directory, ".castloop"); mkdirSync(state); writeFileSync(join(state, "state.json"), "retained legacy state");
  try {
    const result = Bun.spawnSync([process.execPath, entrypoint, "init"], { cwd: directory });
    expect(result.exitCode).toBe(1); expect(result.stderr.toString()).toContain("cannot adopt retained local state");
    expect(readFileSync(join(state, "state.json"), "utf8")).toBe("retained legacy state");
    expect(readdirSync(state)).toEqual(["state.json"]); expect(readdirSync(directory)).toEqual([".castloop"]);
  } finally { rmSync(directory, { recursive: true }); }
});
