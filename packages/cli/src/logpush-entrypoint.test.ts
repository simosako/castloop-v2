import { expect, test } from "bun:test";
import { resultEnvelopeSchema } from "./agent-schema";
import { commandHelp, describeCommand } from "./help";
import { logpushConfigurationStorage, readLogpushConfiguration } from "./logpush-config";
import { logpushFixture } from "./test-support/logpush";
import { forwardLoopback, loopbackTarget } from "./test-support/loopback";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("formal Logpush CLI routes setup/status/enable/disable, retains interrupted settings, and emits only safe JSON", async () => {
  const f = await logpushFixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = loopbackTarget(request);
    if (!target) return new Response(null, { status: 400 });
    try { return await forwardLoopback(request, target, f.transport); }
    catch { return new Response("private-token private@example.com", { status: 503 }); }
  } });
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: f.config.account_id, CLOUDFLARE_API_TOKEN: "private-token",
    CASTLOOP_TEST_LOOPBACK_ORIGIN: `http://127.0.0.1:${server.port}` };
  const invoke = async (action: string, success = true) => {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "test-support/sqlite-cli-preload.ts"),
      join(import.meta.dir, "index.ts"), "logpush", action, "--zone-id", f.zoneId,
      ...(action === "setup" ? ["--bucket-name", "access-logs"] : []), "--workspace", f.root, "--json", "--non-interactive"],
    { cwd: "/tmp/opencode", env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(success ? 0 : 1); expect(stderr).toBe("");
    for (const secret of ["private-token", "private@example.com", "destination-secret", "destination_conf"]) expect(stdout).not.toContain(secret);
    return resultEnvelopeSchema.parse(JSON.parse(stdout));
  };
  try {
    expect((await invoke("setup")).result).toMatchObject({ result: "logpush-configured", retention_days: 400, private: true });
    const file = logpushConfigurationStorage(f.root, f.config).path, saved = readFileSync(file, "utf8");
    f.calls.length = 0;
    expect((await invoke("status")).result).toMatchObject({ configuration_matches: true, job_enabled: true });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true); expect(readFileSync(file, "utf8")).toBe(saved);
    expect((await invoke("disable")).result).toMatchObject({ settings: { enabled: false } });
    f.faults.lost = "update";
    expect((await invoke("enable", false)).error?.outcome).toBe("unknown");
    expect(readLogpushConfiguration(f.root, f.config)?.zones[0]?.settings.enabled).toBe(true);
    f.faults.lost = undefined;
    expect((await invoke("status")).result).toMatchObject({ configuration_matches: true });
    expect((await invoke("enable")).ok).toBe(true); expect(f.jobs).toHaveLength(1); expect(f.tokens).toHaveLength(1);
    f.faults.failStatus = 403;
    expect((await invoke("status", false)).error?.outcome).toBe("not_started");
  } finally { server.stop(true); f.close(); }
}, 30000);

test("Logpush help/describe and malformed or legacy CLI inputs work without remote requests or local state changes", () => {
  const root = mkdtempSync("/tmp/opencode/castloop-logpush-arguments-");
  try {
    const description = describeCommand("logpush");
    expect(description.options).toMatchObject({ "zone-id": "string", "bucket-name": "string" });
    expect(description.positional_counts).toEqual([1]); expect(description.effects.publication).toBe(false);
    expect(commandHelp("logpush")).toContain("status is read-only");
    for (const args of [["logpush"], ["logpush", "setup"], ["logpush", "setup", "--zone-id", "c".repeat(32)],
      ["logpush", "status", "--zone-id", "c".repeat(32), "--bucket-name", "access-logs"],
      ["logpush", "setup", "--zone-id", "invalid", "--bucket-name", "access-logs"],
      ["logpush", "setup", "--zone-id", "c".repeat(32), "--bucket-name", "invalid/bucket"],
      ["logpush", "remove", "--zone-id", "c".repeat(32)], ["logpush", "enable", "extra", "--zone-id", "c".repeat(32)]]) {
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "index.ts"), ...args, "--json"], { cwd: root });
      expect(result.exitCode).toBe(1);
      expect(resultEnvelopeSchema.parse(JSON.parse(result.stdout.toString())).error?.outcome).toBe("not_started");
      expect(readdirSync(root)).toEqual([]);
    }
    writeFileSync(join(root, "castloop.toml"), 'schema_version = 1\n');
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "index.ts"), "logpush", "setup", "--zone-id", "c".repeat(32),
      "--bucket-name", "access-logs", "--workspace", root, "--json"], { cwd: "/tmp/opencode" });
    expect(result.exitCode).toBe(1);
    expect(resultEnvelopeSchema.parse(JSON.parse(result.stdout.toString())).error?.outcome).toBe("not_started");
    expect(readdirSync(root)).toEqual(["castloop.toml"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
