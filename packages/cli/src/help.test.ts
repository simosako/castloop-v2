import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_HELP } from "./help";
import { PUBLICATION_SERVICE_TEXT } from "../../../src/test-support/publication";

const entrypoint = join(import.meta.dir, "index.ts");

test("every subcommand displays help without a workspace or credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "castloop-help-"));
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
  } finally {
    rmdirSync(directory);
  }
});

test("help works after positional arguments, with -h, and with help COMMAND", () => {
  for (const args of [["create-show", "daily", "--help"], ["init", "--service-id", "daily", "--help"],
    ["create-episode", "-h"], ["help", "init"], ["-h"]]) {
    const result = Bun.spawnSync([process.execPath, entrypoint, ...args]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Usage: castloop");
    expect(result.stderr.toString()).toBe("");
  }
});

test("unknown commands and missing ordinary option values still fail", () => {
  for (const args of [["unknown", "--help"], ["help", "unknown"], ["init", "--service-id"]]) {
    const result = Bun.spawnSync([process.execPath, entrypoint, ...args]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(args.includes("unknown") ? "Unknown command" : "Invalid or missing value");
  }
});

test("list commands reject missing Show IDs, excess arguments and invalid flags before workspace access", () => {
  for (const args of [["list-episodes"], ["list-episodes", "--json"], ["list-shows", "unexpected"],
    ["list-episodes", "daily", "extra"], ["list-shows", "--cursor"], ["list-shows", "--local", "true"]]) {
    const result = Bun.spawnSync([process.execPath, entrypoint, ...args], { cwd: "/tmp/opencode" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).not.toContain("ENOENT");
    if (args[0] === "list-episodes") expect(result.stderr.toString()).toContain("Usage: castloop list-episodes SHOW_ID");
  }
});

test("formal list commands pass options, format text/JSON and leave workspace state unchanged", () => {
  const directory = mkdtempSync("/tmp/opencode/castloop-list-entrypoint-");
  const state = join(directory, ".castloop");
  const preload = join(directory, "mock-fetch.ts");
  const secret = JSON.stringify({ CASTLOOP_ADMIN_KEY: "private-secret" });
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, "secrets.json"), secret, { mode: 0o600 });
  writeFileSync(join(directory, "castloop.toml"), PUBLICATION_SERVICE_TEXT);
  writeFileSync(preload, `import assert from "node:assert/strict";
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), "https://current.example/admin/catalog");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["X-Castloop-Key"], "private-secret");
  assert.deepEqual(JSON.parse(init.body), JSON.parse(process.env.CASTLOOP_TEST_REQUEST));
  return Response.json(JSON.parse(process.env.CASTLOOP_TEST_RESPONSE), { headers: { "Cache-Control": "no-store" } });
};
`);
  const common = { schema_version: 1, result: "catalog", snapshot_only: true, authorizes_operation: false,
    admission_state: "open", next_cursor: null };
  const show = { show_id: "daily", lifecycle: "active", unfinished_operation: false,
    title: "Title\n\u001b[31m", feed_url: "https://current.example/podcasts/daily/feed.xml" };
  const episode = { episode_id: "first", lifecycle: "active", title: "First Episode", published_at: "2026-10-04T12:00:00Z" };
  try {
    for (const args of [["list-shows"], ["list-episodes", "daily"],
      ["list-shows", "--include-deleted", "--cursor", "next-page", "--json"], ["list-episodes", "daily", "--json"]]) {
      const listingShows = args[0] === "list-shows";
      const request = { schema_version: 1, service_id: "service", include_deleted: args.includes("--include-deleted"),
        ...(args.includes("--cursor") ? { cursor: "next-page" } : {}),
        ...(listingShows ? { kind: "show" } : { kind: "episode", show_id: "daily" }) };
      const response = listingShows ? { ...common, request, shows: [show] } : { ...common, request,
        show: { show_id: "daily", lifecycle: "active", unfinished_operation: false }, episodes: [episode] };
      const result = Bun.spawnSync([process.execPath, "--preload", preload, entrypoint, ...args], {
        cwd: directory, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "",
          CASTLOOP_TEST_REQUEST: JSON.stringify(request), CASTLOOP_TEST_RESPONSE: JSON.stringify(response) },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      if (args.includes("--json")) expect(JSON.parse(result.stdout.toString())).toEqual(response);
      else {
        expect(result.stdout.toString()).toContain(listingShows ? "SHOW_ID\tSTATE" : "EPISODE_ID\tSTATE");
        expect(result.stdout.toString()).not.toContain("\u001b");
        if (listingShows) expect(result.stdout.toString()).toContain("Title\\n\\u001b[31m");
      }
    }
    expect(readdirSync(state)).toEqual(["secrets.json"]);
    expect(readFileSync(join(state, "secrets.json"), "utf8")).toBe(secret);
    expect(readFileSync(join(directory, "castloop.toml"), "utf8")).toBe(PUBLICATION_SERVICE_TEXT);
    expect(readdirSync(directory).sort()).toEqual([".castloop", "castloop.toml", "mock-fetch.ts"]);
  } finally {
    unlinkSync(join(state, "secrets.json"));
    rmdirSync(state);
    unlinkSync(join(directory, "castloop.toml"));
    unlinkSync(preload);
    rmdirSync(directory);
  }
});

test("formal commands reject test-only faults and malformed mutations without creating local state", () => {
  const directory = mkdtempSync(join(tmpdir(), "castloop-entrypoint-"));
  try {
    for (const args of [["update-service-drop-completion", "id"], ["deploy", "--force", "true"],
      ["lifecycle-execute", "plan.json", "hash"], ["service-resume"],
      ["publish-episode", "first", "one.mp3", "two.mp3"], ["init", "--__proto__", "value"]]) {
      const result = Bun.spawnSync([process.execPath, entrypoint, ...args], { cwd: directory });
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
    }
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmdirSync(directory); }
});

test("formal initialization does not convert a legacy workspace or create administrator credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "castloop-legacy-entrypoint-"));
  const stateDirectory = join(directory, ".castloop");
  const state = join(stateDirectory, "state.json");
  mkdirSync(stateDirectory);
  writeFileSync(state, "retained legacy state");
  try {
    const result = Bun.spawnSync([process.execPath, entrypoint, "init"], { cwd: directory });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Legacy workspaces are not converted");
    expect(readFileSync(state, "utf8")).toBe("retained legacy state");
    expect(readdirSync(stateDirectory)).toEqual(["state.json"]);
    expect(readdirSync(directory)).toEqual([".castloop"]);
  } finally { unlinkSync(state); rmdirSync(stateDirectory); rmdirSync(directory); }
});
