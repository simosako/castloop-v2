import { expect, test } from "bun:test";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { resultEnvelopeSchema } from "./agent-schema";
import { readSqliteDomainJournal } from "./sqlite-domain-journal";
import { loadWorkspaceConfig } from "./workspace-config";
import { forwardLoopback, loopbackTarget, TEST_LOOPBACK_ALLOWED_ORIGINS } from "./test-support/loopback";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("formal domain CLI supports JSON, explicit workspaces, interrupted TLS observation and cutover without leaking credentials", async () => {
  const f = await sqliteServiceFixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = loopbackTarget(request, [...TEST_LOOPBACK_ALLOWED_ORIGINS, "https://podcasts.example.com"]);
    if (!target) return new Response(null, { status: 400 });
    try {
      const response = await forwardLoopback(request, target, f.transport);
      if (request.method === "PUT" && new URL(target).pathname.endsWith("/workers/domains")) {
        const body = await response.json() as { result: object };
        return Response.json({ success: true, errors: null, result: { ...body.result, environment: "" } });
      }
      if (request.method === "DELETE" && new URL(target).pathname.includes("/workers/domains/")) {
        return new Response("", { headers: { "Content-Length": "0" } });
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
    await invoke(["create-show", "daily", "--site-mode", "builtin"]);
   
    writeFileSync(join(f.root, "daily", "cover.jpg"), Uint8Array.of(255, 216, 255));
    await invoke(["publish-show", "daily"]);
    const id = crypto.randomUUID(); f.faults.tlsPending = true;
    const failed = await invoke(["domain", "add", "podcasts.example.com", "--zone-id", "c".repeat(32), "--operation-id", id], false);
    expect(failed.result).toMatchObject({ operation_id: id, phase: "connected" });
    expect(failed.error?.code).toBe("domain_tls_pending");
    expect(readSqliteDomainJournal(f.root, f.config, id)).toMatchObject({ connection: { environment: "production" } });
    expect(failed.next_actions.some((action) => action.command === "domain" && action.args?.[0] === "status")).toBe(true);
    f.faults.tlsPending = false;
    expect((await invoke(["domain", "continue", id])).result).toMatchObject({ phase: "completed" });
    const custom = await loadWorkspaceConfig(f.root);
   
    expect(f.content.renderSitePage({ kind: "listing", showId: "daily", page: 1 }, custom.public_base_url)!.html).toContain('href="https://podcasts.example.com/podcasts/daily/"');
    expect((await invoke(["domain", "list"])).result).toMatchObject({ connections_match: true });
    expect((await invoke(["domain", "status", id])).result).toMatchObject({ remote: { phase: "completed" } });
    await invoke(["publish-show", "daily"]);
    const removed = crypto.randomUUID();
    expect((await invoke(["domain", "remove", "--operation-id", removed])).result).toMatchObject({ phase: "completed" });
    expect(await loadWorkspaceConfig(f.root)).toEqual(f.config);
  } finally { server.stop(true); f.close(); }
}, 45000);

test("formal domain CLI emits safe receipt-stage diagnostics to stderr and preserves unknown attachments without retry", async () => {
  const f = await sqliteServiceFixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = loopbackTarget(request);
    if (!target) return new Response(null, { status: 400 });
    const response = await forwardLoopback(request, target, f.transport);
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
    expect(result.result).toMatchObject({ ok: false, result: { phase: "prepared" }, error: { code: "domain_connection_unverified", outcome: "unknown" } });
    const diagnostics = result.stderr.trim().split("\n").map((line) => JSON.parse(line));
    expect(diagnostics).toContainEqual({ event: "sqlite_domain_cloudflare", api_operation: "domain_attach", method: "PUT",
       reason_code: "connection_schema_unverified", http_status: 200, response_kind: "object", environment_kind: "null", expected_environment: "empty_or_production",
      fields: [{ path: ["environment"], code: "invalid_value" }], will_retry: false });
    expect(result.stderr).not.toContain("private-token"); expect(result.stderr).not.toContain("podcasts.example.com");
    expect(f.calls.filter((call) => call.method === "PUT" && call.path === "/workers/domains")).toHaveLength(1);
    expect(readSqliteDomainJournal(f.root, await loadWorkspaceConfig(f.root), id)?.phase).toBe("prepared");
  } finally { server.stop(true); f.close(); }
}, 30000);
