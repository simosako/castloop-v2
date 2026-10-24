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
    try {
      const response = await f.transport(target, { method: request.method, headers, ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) });
      if (request.method === "PUT" && new URL(target).pathname.endsWith("/workers/domains")) {
        const body = await response.json() as { result: object };
        return Response.json({ success: true, errors: null, result: { ...body.result, environment: "" } });
      }
      return response;
    }
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
    expect(readSqliteDomainJournal(f.root, f.config, id)).toMatchObject({ attachment_acknowledgement: { environment: "" }, connection: { environment: "production" } });
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

test("formal domain CLI emits safe receipt-stage diagnostics to stderr and preserves unknown attachments without retry", async () => {
  const f = await sqliteServiceFixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = request.headers.get("X-Castloop-Test-Target");
    if (!target || !["api.cloudflare.com", "test-worker.example.workers.dev"].includes(new URL(target).hostname)) return new Response(null, { status: 400 });
    const headers = new Headers(request.headers); headers.delete("X-Castloop-Test-Target"); headers.delete("Host");
    const response = await f.transport(target, { method: request.method, headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) });
    if (request.method === "PUT" && new URL(target).pathname.endsWith("/workers/domains")) {
      const body = await response.json() as { result: object };
      return Response.json({ success: true, errors: null, result: { ...body.result, environment: null } });
    }
    return response;
  } });
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: f.config.account_id, CLOUDFLARE_API_TOKEN: "private-token",
    CASTLOOP_TEST_LOOPBACK_ORIGIN: `http://127.0.0.1:${server.port}` };
  const invoke = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "test-support/sqlite-cli-preload.ts"),
      join(import.meta.dir, "index.ts"), ...args, "--workspace", f.root, "--non-interactive", "--json"],
    { cwd: "/tmp/opencode", env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { result: resultEnvelopeSchema.parse(JSON.parse(stdout)), stderr, exit };
  };
  try {
    expect((await invoke(["init", "--operation-id", crypto.randomUUID()])).exit).toBe(0);
    const id = crypto.randomUUID(), result = await invoke(["domain", "add", "podcasts.example.com", "--zone-id", "c".repeat(32), "--operation-id", id]);
    expect(result.exit).toBe(1);
    expect(result.result).toMatchObject({ ok: false, result: { phase: "connection_requested" }, error: { code: "domain_connection_unverified", outcome: "unknown" } });
    const diagnostics = result.stderr.trim().split("\n").map((line) => JSON.parse(line));
    expect(diagnostics).toContainEqual({ event: "sqlite_domain_cloudflare", api_operation: "domain_attach", method: "PUT",
       reason_code: "connection_schema_unverified", http_status: 200, response_kind: "object", environment_kind: "null", expected_environment: "empty_or_production",
      fields: [{ path: ["environment"], code: "invalid_value" }], will_retry: false });
    expect(result.stderr).not.toContain("private-token"); expect(result.stderr).not.toContain("podcasts.example.com");
    expect(f.calls.filter((call) => call.method === "PUT" && call.path === "/workers/domains")).toHaveLength(1);
    const calls = f.calls.length;
    expect((await invoke(["domain", "continue", id])).exit).toBe(1);
    expect(f.calls).toHaveLength(calls);
    expect(readSqliteDomainJournal(f.root, await loadWorkspaceConfig(f.root), id)?.phase).toBe("connection_requested");
  } finally { server.stop(true); f.close(); }
}, 30000);
