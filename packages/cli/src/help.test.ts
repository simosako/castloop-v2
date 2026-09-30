import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmdirSync } from "node:fs";
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
