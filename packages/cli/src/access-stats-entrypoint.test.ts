import { expect, test } from "bun:test";
import { resultEnvelopeSchema } from "./agent-schema";
import { describeCommand } from "./help";
import { runSqliteCommand } from "./sqlite-commands";
import { accessStatsFixture } from "./test-support/access-stats";
import { forwardLoopback, loopbackTarget } from "./test-support/loopback";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

test("formal access-statistics CLI refreshes, navigates, exports gzip-backed logs and preserves legacy Show command names", async () => {
  const f = await accessStatsFixture();
  f.putLogs("a.gz", [f.record("individual-request-id"), f.record("individual-request-id")]);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = loopbackTarget(request);
    if (!target) return new Response(null, { status: 400 });
    try { return await forwardLoopback(request, target, f.transport); }
    catch { return new Response("private-token private@example.com", { status: 503 }); }
  } });
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: f.config.account_id, CLOUDFLARE_API_TOKEN: "private-token",
    CASTLOOP_TEST_LOOPBACK_ORIGIN: `http://127.0.0.1:${server.port}` };
  const invoke = async (args: string[], json = true, success = true) => {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "test-support/sqlite-cli-preload.ts"),
      join(import.meta.dir, "index.ts"), ...args, "--workspace", f.root, "--non-interactive", ...(json ? ["--json"] : [])],
    { cwd: "/tmp/opencode", env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr || stdout).toBe(success ? 0 : 1);
    expect(stdout).not.toContain("private-token"); expect(stdout).not.toContain("private@example.com");
    expect(stdout).not.toContain("individual-request-id"); expect(stderr).not.toContain("individual-request-id");
    return stdout;
  };
  const dates = ["--from", f.date(2), "--to", f.date(0)];
  try {
    const refresh = resultEnvelopeSchema.parse(JSON.parse(await invoke(["stats", "refresh", "daily", "--source", f.source.source_id, ...dates])));
    expect(refresh.target.show_id).toBe("daily"); expect(refresh.result).toMatchObject({ changed: 6, format: "access-daily-v1" });
    expect(JSON.parse(await invoke(["stats", "access", "daily"])).result).toMatchObject({ view: "sources" });
    expect(JSON.parse(await invoke(["stats", "access", "daily", "--source", f.source.source_id])).result).toMatchObject({ view: "resources" });
    const query = ["stats", "access", "daily", "--source", f.source.source_id, "--resource", f.audio.resource_path, ...dates];
    expect(await invoke(query, false)).toContain("GET_200\tGET_206\tHEAD");
    const before = f.requests.length;
    expect(JSON.parse(await invoke(query)).result).toMatchObject({ period: { get_200_requests: 1 } });
    expect(f.requests.slice(before).every((request) => request.method === "GET" && new URL(request.url).hostname !== "api.cloudflare.com")).toBe(true);
    const output = join(f.root, "logs.ndjson");
    expect(JSON.parse(await invoke(["stats", "logs", "daily", "--source", f.source.source_id, "--output", output, ...dates])).result)
      .toMatchObject({ record_count: 2, output });
    expect(readFileSync(output, "utf8").trim().split("\n")).toHaveLength(2);
    for (const show of ["access", "refresh", "logs"]) {
      await runSqliteCommand(f.root, f.config, "create-show", [show, "https://example.com"], { transport: f.transport });
      expect(JSON.parse(await invoke(["stats", show])).result).toMatchObject({ show_id: show, collection_mode: "best_effort_non_blocking", episodes: [] });
    }
  } finally { server.stop(true); f.close(); }
}, 30000);

test("describe exposes access-log effects and malformed selections fail before workspace discovery or file creation", () => {
  const root = mkdtempSync("/tmp/opencode/castloop-access-stats-arguments-");
  try {
    const spec = describeCommand("stats");
    expect(spec.options).toMatchObject({ source: "string", resource: "string", output: "string" });
    expect(spec.positional_counts).toEqual([1, 2]); expect(spec.effects.publication).toBe(false);
    expect(spec.effects.remote).toBe("may_mutate");
    for (const args of [["stats", "unknown", "daily"], ["stats", "refresh", "daily"], ["stats", "logs", "daily", "--source", "id"],
      ["stats", "access", "daily", "--resource", "/path"], ["stats", "access", "daily", "--from", "2026-01-01"],
      ["stats", "refresh", "daily", "--source", "id", "--to", "invalid"], ["stats", "access", "daily", "--episode", "first"],
      ["stats", "logs", "daily", "--source", "id", "--output", "out.ndjson", "--cursor", "next"],
      ["stats", "daily", "--source", "id"]]) {
      const child = Bun.spawnSync([process.execPath, join(import.meta.dir, "index.ts"), ...args, "--json"], { cwd: root });
      expect(child.exitCode, args.join(" ")).toBe(1);
      expect(resultEnvelopeSchema.parse(JSON.parse(child.stdout.toString())).error?.outcome).toBe("not_started");
      expect(readdirSync(root)).toEqual([]); expect(existsSync(join(root, "out.ndjson"))).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
