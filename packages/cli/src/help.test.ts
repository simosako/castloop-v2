import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_HELP } from "./help";

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
