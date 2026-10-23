import { expect, test } from "bun:test";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { resultEnvelopeSchema } from "./agent-schema";
import { readSqliteDomainJournal } from "./sqlite-domain-journal";
import { loadWorkspaceConfig } from "./workspace-config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("formal domain CLI supports JSON, explicit workspaces, interrupted TLS observation and cutover without leaking credentials", async () => {
  const f = await sqliteServiceFixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = request.headers.get("X-Castloop-Test-Target");
    if (!target || !["api.cloudflare.com", "test-worker.example.workers.dev", "podcasts.example.com"].includes(new URL(target).hostname)) return new Response(null, { status: 400 });
    const headers = new Headers(request.headers); headers.delete("X-Castloop-Test-Target"); headers.delete("Host");
    try { return await f.transport(target, { method: request.method, headers, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) }); }
    catch { return new Response(null, { status: 503 }); }
  } });
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: f.config.account_id, CLOUDFLARE_API_TOKEN: "private-token",
    CASTLOOP_TEST_LOOPBACK_ORIGIN: `http://127.0.0.1:${server.port}` };
  const invoke = async (args: string[], success = true) => {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "test-support/sqlite-cli-preload.ts"),
      join(import.meta.dir, "index.ts"), ...args, "--workspace", f.root, "--non-interactive", "--json"],
    { cwd: "/tmp/opencode", env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, stderr).toBe(success ? 0 : 1); expect(stdout).not.toContain("private-token");
    return resultEnvelopeSchema.parse(JSON.parse(stdout));
  };
  try {
    await invoke(["init", "--operation-id", crypto.randomUUID()]);
    await invoke(["create-show", "daily", "--site-url", "https://example.com"]);
    await invoke(["show-resume", "daily", crypto.randomUUID()]);
    writeFileSync(join(f.root, "daily", "cover.jpg"), Uint8Array.of(255, 216, 255));
    await invoke(["update-show", "daily"]); await invoke(["publish-show", "daily"]); await invoke(["show-pause", "daily", crypto.randomUUID()]);
    const id = crypto.randomUUID(); f.faults.tlsPending = true;
    const failed = await invoke(["domain", "add", "podcasts.example.com", "--zone-id", "c".repeat(32), "--operation-id", id], false);
    expect(failed.result).toMatchObject({ operation_id: id, phase: "connected" });
    expect(failed.next_actions.some((action) => action.command === "domain" && action.args?.[0] === "status")).toBe(true);
    f.faults.tlsPending = false;
    expect((await invoke(["domain", "continue", id])).result).toMatchObject({ phase: "completed" });
    expect((await invoke(["domain", "list"])).result).toMatchObject({ connections_match: true });
    expect((await invoke(["domain", "status", id])).result).toMatchObject({ remote: { phase: "completed" } });
    const custom = await loadWorkspaceConfig(f.root);
    await invoke(["show-resume", "daily", crypto.randomUUID()]);
    expect((await invoke(["domain", "status", id])).result).toMatchObject({ remote: { phase: "completed" } });
    await invoke(["update-show", "daily"]); await invoke(["publish-show", "daily"]); await invoke(["show-pause", "daily", crypto.randomUUID()]);
    const removed = crypto.randomUUID();
    expect((await invoke(["domain", "remove", "--operation-id", removed])).result).toMatchObject({ phase: "completed" });
    expect(readSqliteDomainJournal(f.root, custom, removed)?.detach_acknowledged).toBe(true);
    expect(await loadWorkspaceConfig(f.root)).toEqual(f.config);
  } finally { server.stop(true); f.close(); }
}, 45000);
