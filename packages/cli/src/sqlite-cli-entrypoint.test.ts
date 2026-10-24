import { expect, test } from "bun:test";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { sqliteLifecyclePlanSchema } from "./sqlite-lifecycle";
import { loadWorkspaceConfig } from "./workspace-config";
import { resultEnvelopeSchema } from "./agent-schema";
import { operationCleanupPlanSchema, operationListSchema, operationResultSchema } from "../../shared/src/sqlite-operations";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("formal CLI entrypoint initializes paused and publishes through the SQLite route under a local-only transport", async () => {
  const setup = await sqliteServiceFixture();
  const preload = fileURLToPath(new URL("./test-support/sqlite-cli-preload.ts", import.meta.url).href);
  const cli = fileURLToPath(new URL("./index.ts", import.meta.url).href);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = request.headers.get("X-Castloop-Test-Target");
    if (!target || !["api.cloudflare.com", "test-worker.example.workers.dev"].includes(new URL(target).hostname)) return new Response(null, { status: 400 });
    const headers = new Headers(request.headers); headers.delete("X-Castloop-Test-Target"); headers.delete("Host");
    return setup.transport(target, { method: request.method, headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) });
  } });
  const environment = { ...process.env, CASTLOOP_TEST_LOOPBACK_ORIGIN: `http://127.0.0.1:${server.port}`,
    CLOUDFLARE_ACCOUNT_ID: setup.config.account_id, CLOUDFLARE_API_TOKEN: "private-token" };
  async function command(args: string[], cwd = setup.root) {
    if (args[0]?.startsWith("operation-") && !args.includes("--local")) args = [...args, "--show", "daily"];
    const child = Bun.spawn([process.execPath, "--preload", preload, cli, ...args], { cwd, env: environment,
      stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Local CLI ${args[0]} failed: ${stderr}`);
    const output = JSON.parse(stdout) as Record<string, unknown>;
    return args.includes("--json") ? resultEnvelopeSchema.parse(output).result as Record<string, unknown> : output;
  }
  try {
    expect(await command(["init", ".", "--operation-id", crypto.randomUUID()])).toMatchObject({ phase: "ready" });
    expect(setup.runtime.health().state).toBe("paused");
    const show = Bun.spawn([process.execPath, "--preload", preload, cli, "create-show", "daily", "--site-url", "https://example.com/podcast"], {
      cwd: setup.root, env: environment, stdout: "pipe", stderr: "pipe" });
    const [showOutput, showError, showCode] = await Promise.all([new Response(show.stdout).text(), new Response(show.stderr).text(), show.exited]);
    expect(showCode, showError).toBe(0); expect(showOutput).toContain("show.toml");
    await command(["show-resume", "daily", crypto.randomUUID()]);
    const directory = join(setup.root, "daily");
    writeFileSync(join(directory, "cover.jpg"), Buffer.from([255, 216, 255, 2]));
    await command(["update-show", "daily"]); expect(await command(["publish-show", "daily"])).toMatchObject({ state: "succeeded" });
    const episode = Bun.spawn([process.execPath, "--preload", preload, cli, "create-episode", "first"], { cwd: directory,
      env: environment, stdout: "pipe", stderr: "pipe" });
    const [episodeError, episodeCode] = await Promise.all([new Response(episode.stderr).text(), episode.exited]);
    await new Response(episode.stdout).text(); expect(episodeCode, episodeError).toBe(0);
    writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
    await command(["update-episode", "first", "--workspace", setup.root, "--show", "daily", "--non-interactive", "--json"], "/tmp/opencode");
    await command(["update-episode-audio", "first", "audio.mp3", "--workspace", setup.root, "--show", "daily", "--json"], "/tmp/opencode");
    const preview = await command(["preview-episode", "first", "--workspace", setup.root, "--show", "daily", "--json"], "/tmp/opencode");
    expect(preview.inputs_match_staged).toBe(true);
    const publication = await command(["publish-episode", "first", "--workspace", setup.root, "--show", "daily", "--expect-preview", String(preview.input_fingerprint), "--json"], "/tmp/opencode"); expect(publication).toMatchObject({ state: "succeeded" });
    expect(await command(["job-status", String(publication.job_id)])).toMatchObject({ status: { state: "succeeded" } });
    expect(await command(["list-shows", "--json"])).toMatchObject({ shows: [{ show_id: "daily", lifecycle: "published" }] });
    expect(await command(["list-episodes", "daily", "--json"])).toMatchObject({ episodes: [{ episode_id: "first", lifecycle: "published" }] });
    for (const action of ["unpublish", "restore"]) {
      const plan = sqliteLifecyclePlanSchema.parse(await command(["preview-episode-lifecycle", "daily", "first", action]));
      const file = join(setup.root, "reviewed-plan.json"); writeFileSync(file, JSON.stringify(plan));
      expect(await command(["lifecycle-execute", file, plan.request_sha256, "confirm"])).toMatchObject({ state: "queued" });
      expect(await command(["job-status", plan.request.job_id])).toMatchObject({ status: { state: "succeeded" } });
    }
    const staged = await command(["update-show", "daily"]);
    const operations = operationListSchema.parse(await command(["operation-list", "--remote"]));
    const upload = operations.operations.find((operation) => operation.kind === "upload" && operation.job_id === staged.job_id)!;
    expect(upload).toBeDefined();
    expect(await command(["operation-status", "upload", upload.operation_id, "--local"])).toMatchObject({ source: "local" });
    expect(await command(["operation-status", "upload", upload.operation_id, "--remote"])).toMatchObject({ operation: { state: "succeeded" } });
    await command(["operation-cancel", "upload", upload.operation_id]);
    const cleanup = operationCleanupPlanSchema.parse(await command(["operation-cleanup-preview", "upload", upload.operation_id]));
    const cleaned = operationResultSchema.parse(await command(["operation-cleanup", "upload", upload.operation_id, cleanup.plan_sha256, "confirm"]));
    expect(cleaned.operation.state).toBe("succeeded");
    expect(await command(["operation-status", "cleanup", cleaned.operation.operation_id])).toMatchObject({ operation: { state: "succeeded" } });
    const admissionStop = crypto.randomUUID();
    expect(await command(["show-admission-pause", "daily", admissionStop, "--json"])).toMatchObject({ state: "admission_paused", admission_state: "closed" });
    expect(await command(["show-control-status", "daily", admissionStop, "--json"])).toMatchObject({ control: { result: { state: "admission_paused" } } });
    await command(["show-pause", "daily", crypto.randomUUID()]);
    expect(await command(["show-delivery-resume", "daily", crypto.randomUUID(), "--json"])).toMatchObject({ state: "admission_paused", delivery_policy: "enabled" });
    await command(["show-pause", "daily", crypto.randomUUID()]);
    expect(await command(["service-status"])).toMatchObject({ state: "paused", drained: true });
    expect(await command(["deploy", "--operation-id", crypto.randomUUID()])).toMatchObject({ phase: "ready" });
    expect(await command(["service-status"])).toMatchObject({ publication_ready: true, state: "paused", runtime_update: { state: "completed" } });
    expect(await command(["operation-status", "publication", String(publication.job_id), "--remote"])).toMatchObject({ operation: { state: "succeeded" } });
    expect(setup.calls.some((call) => /queues|event_notifications/.test(call.path))).toBe(false);
  } finally { server.stop(true); setup.close(); }
}, 45000);

for (const explicit of [false, true]) {
  test(`formal fresh init generates schema version 2 ${explicit ? "with" : "without"} the optional protocol flag`, async () => {
    const root = mkdtempSync("/tmp/opencode/castloop-fresh-cli-"), workspace = join(root, "workspace");
    mkdirSync(workspace);
    let fixture: Promise<Awaited<ReturnType<typeof sqliteServiceFixture>>> | undefined;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      fixture ??= loadWorkspaceConfig(workspace).then((config) => sqliteServiceFixture(config, workspace));
      const setup = await fixture;
      const target = request.headers.get("X-Castloop-Test-Target");
      if (!target || !["https://api.cloudflare.com", setup.config.workers_dev_base_url].includes(new URL(target).origin)) return new Response(null, { status: 400 });
      const headers = new Headers(request.headers); headers.delete("X-Castloop-Test-Target"); headers.delete("Host");
      return setup.transport(target, { method: request.method, headers,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) });
    } });
    const preload = join(root, "preload.ts");
    writeFileSync(preload, `import { loadWorkspaceConfig } from ${JSON.stringify(join(import.meta.dir, "workspace-config.ts"))};
const transport = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
  const config = await loadWorkspaceConfig(process.cwd());
  const request = new Request(input, init), url = new URL(request.url);
  if (!["https://api.cloudflare.com", config.workers_dev_base_url].includes(url.origin)) throw new Error("External access forbidden");
  const headers = new Headers(request.headers); headers.set("X-Castloop-Test-Target", request.url);
  return transport(${JSON.stringify(`http://127.0.0.1:${server.port}`)}, { method: request.method, headers, redirect: "error", signal: request.signal,
    ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) });
}, { preconnect: transport.preconnect });`);
    try {
      const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "index.ts"), "init", ".",
        "--service-id", "service", "--bucket-name", "private-bucket", "--workers-subdomain", "example",
        ...(explicit ? ["--publication-protocol", "sqlite-sequential-v1"] : [])], { cwd: workspace,
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "private-token" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, stderr).toBe(0); expect(JSON.parse(stdout)).toMatchObject({ phase: "ready" });
      expect(await loadWorkspaceConfig(workspace)).toMatchObject({ schema_version: 2, publication_protocol: "sqlite-sequential-v1" });
      const setup = await fixture!;
      expect(setup.runtime.health()).toMatchObject({ state: "paused", drained: true, publication_ready: true });
      expect(setup.calls.some((call) => /queues|event_notifications/.test(call.path))).toBe(false);
    } finally { server.stop(true); (await fixture)?.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30000);
}
