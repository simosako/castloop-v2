import { afterEach, expect, test } from "bun:test";
import { sqliteAvailabilityRequestSchema } from "../../shared/src/sqlite-availability";
import { sqliteAvailabilityResponseSchema } from "../../shared/src/sqlite-service-api";
import { serveSqliteGateway } from "../../../src/sqlite-gateway";
import { serveCachedLifecycleAsset } from "../../../src/lifecycle-cache";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { SqliteServiceClient } from "./sqlite-service-client";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { administratorKey } from "./administrator-key";
import { diagnoseLocal } from "./doctor";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtures: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of fixtures.splice(0)) value.close(); });
async function fixture() {
  const value = await sqliteServiceFixture(); fixtures.push(value);
  await initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, { attempts: 2, delay: async () => {} });
  const command = (name: string, args: string[] = []) => runSqliteCommand(value.root, value.config, name, args,
    { transport: value.transport, cloudflare: value.options, workerSource: async () => "updated worker source" });
  await command("create-show", ["daily", "https://example.com"]);
  await command("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(value.root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  await command("update-show", ["daily"]); await command("publish-show", ["daily"]);
  const node = () => value.nodes.get("daily")!;
  const client = new SqliteServiceClient(value.config, administratorKey(value.root), value.transport);
  const cacheEnv = {
    CASTLOOP_BUCKET: value.bucket as unknown as Pick<R2Bucket, "head" | "get">,
    renderFeed: (showId: string, props: Parameters<typeof serveCachedLifecycleAsset>[2]) =>
      node().service.content.renderFeed(showId, value.config.public_base_url, props),
  };
  const read = (path = "/podcasts/daily/feed.xml", method = "GET", headers: HeadersInit = {}, origin = value.config.public_base_url,
    cached = (input: Request, props: Parameters<typeof serveCachedLifecycleAsset>[2]) =>
      serveCachedLifecycleAsset(input, cacheEnv, props)) =>
    serveSqliteGateway(new Request(`${origin}${path}`, { method, headers }), value.config.workers_dev_base_url,
      { fetch: (input) => node().service.fetch(input), delivery: async (input) => node().service.delivery(input) }, cached, value.config.public_base_url);
  return { ...value, command, node, client, read, cacheEnv };
}

test("admission stop serves approved Feed, cover and audio with HTTP conditions and refuses uploads", async () => {
  const value = await fixture();
  await value.command("create-episode", ["daily", "first"]);
  writeFileSync(join(value.root, "daily", "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await value.command("update-episode", ["daily", "first"]); await value.command("update-episode-audio", ["daily", "first", "audio.mp3"]);
  await value.command("publish-episode", ["daily", "first"]);
  const audioPath = new URL(value.content.episodes("daily")[0].enclosure_url).pathname;
  const paths = ["/podcasts/daily/feed.xml", "/podcasts/daily/cover.jpg", audioPath];
  const old = await Promise.all(paths.map(async (path) => { const response = await value.read(path); return new Uint8Array(await response.arrayBuffer()); }));
  await value.command("show-admission-pause", ["daily", crypto.randomUUID()]);
  expect(value.node().service.health()).toMatchObject({ state: "admission_paused", admission_state: "closed", delivery_policy: "enabled" });
  expect(await new SqlitePublicationClient(value.config, administratorKey(value.root), value.transport).describe("daily")).toMatchObject({ state: "admission_paused" });
  expect(await value.command("list-episodes", ["daily"])).toMatchObject({ state: "admission_paused" });
  for (const [index, path] of paths.entries()) {
    const response = await value.read(path), etag = response.headers.get("ETag")!;
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(old[index]);
    const head = await value.read(path, "HEAD"); expect(head.status).toBe(200); expect(await head.text()).toBe("");
    expect((await value.read(path, "GET", { Range: "bytes=0-1" })).status).toBe(206);
    expect((await value.read(path, "GET", { "If-None-Match": etag })).status).toBe(304);
    expect((await value.read(path, "GET", { "If-Modified-Since": head.headers.get("Last-Modified")! })).status).toBe(304);
  }
  const puts = value.bucketCalls.filter((call) => call.method === "PUT").length;
  const publicOrigin = "https://podcast.example.com";
  const alternate = (path: string, origin: string) => serveSqliteGateway(new Request(`${origin}${path}`), value.config.workers_dev_base_url,
    { fetch: (input) => value.node().service.fetch(input), delivery: async (input) => value.node().service.delivery(input) },
    (input, props) => serveCachedLifecycleAsset(input, value.cacheEnv, props), publicOrigin);
  for (const path of paths) {
    expect((await alternate(path, publicOrigin)).status).toBe(200);
    const redirected = await alternate(path, value.config.workers_dev_base_url);
    expect(redirected.status).toBe(path.endsWith("feed.xml") ? 301 : 307); expect(redirected.headers.get("Location")).toBe(`${publicOrigin}${path}`);
  }
  await expect(value.command("update-show", ["daily"])).rejects.toThrow();
  expect(value.bucketCalls.filter((call) => call.method === "PUT")).toHaveLength(puts);
  expect((await value.read("/staging/uploads/daily/private.mp3")).status).toBe(404);
  const stop = crypto.randomUUID(); await value.command("show-pause", ["daily", stop]);
  for (const path of paths) for (const origin of [publicOrigin, value.config.workers_dev_base_url]) {
    const stopped = await alternate(path, origin); expect(stopped.status).toBe(503); expect(stopped.headers.has("Location")).toBe(false);
  }
  for (const path of paths) {
    for (const method of ["GET", "HEAD"]) {
      const response = await value.read(path, method, { Range: "bytes=0-1", "If-None-Match": "*" });
      expect(response.status).toBe(503); expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  }
  await value.command("show-admission-pause", ["daily", crypto.randomUUID()]); expect((await value.read()).status).toBe(503);
  await value.command("show-delivery-resume", ["daily", crypto.randomUUID()]);
  expect((await value.read()).status).toBe(200); expect(value.node().service.health().admission_state).toBe("closed");
  value.restart(); expect((await value.read()).status).toBe(200);
  expect(await value.command("show-control-status", ["daily", stop])).toMatchObject({ state: "admission_paused", control: { result: { state: "paused" } } });
});

test("repeated pause invalidates an earlier resume and recorded results never override later state", async () => {
  const value = await fixture(); await value.command("show-pause", ["daily", crypto.randomUUID()]);
  const health = value.node().service.health();
  const stale = sqliteAvailabilityRequestSchema.parse({ ...value.queue.identity(), operation_id: crypto.randomUUID(), show_id: "daily", action: "resume",
    expected_availability_version: health.availability_version, admission_window_id: crypto.randomUUID() });
  await value.command("show-pause", ["daily", crypto.randomUUID()]);
  await expect(value.client.control(stale)).rejects.toThrow();
  const delivery = crypto.randomUUID(); await value.command("show-delivery-resume", ["daily", delivery]);
  await value.command("show-pause", ["daily", crypto.randomUUID()]); value.calls.length = 0;
  expect(await value.command("show-delivery-resume", ["daily", delivery])).toMatchObject({ state: "paused", control: { result: { state: "admission_paused" } } });
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
});

test("missing control outcomes are observed without retrying the POST or opening admission", async () => {
  const value = await fixture(), id = crypto.randomUUID(); let writes = 0;
  await expect(runSqliteCommand(value.root, value.config, "show-admission-pause", ["daily", id], {
    transport: async (input, init) => {
      if (init?.method === "POST") { writes++; throw new Error("Injected request outcome unknown"); }
      return value.transport(input, init);
    }, cloudflare: value.options,
  })).rejects.toThrow();
  expect(writes).toBe(1); value.calls.length = 0;
  await expect(value.command("show-admission-pause", ["daily", id])).rejects.toThrow();
  expect(value.calls.length).toBeGreaterThan(0); expect(value.calls.every((call) => call.method === "GET")).toBe(true);
  expect(value.node().service.health().state).toBe("open");
  value.calls.length = 0;
  const diagnosis = await diagnoseLocal(value.root, {});
  expect(diagnosis.checks.find((check) => check.id === "show-controls")).toMatchObject({ status: "warn", code: "show_control_pending" });
  expect(value.calls).toEqual([]);
});

test("late cache fills cannot bypass a newer explicit pause", async () => {
  const value = await fixture(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0; const cache = new Map<string, Response>();
  const cached = async (input: Request, props: Parameters<typeof serveCachedLifecycleAsset>[2]) => {
    calls++; const key = JSON.stringify(props), old = cache.get(key); if (old) return old.clone();
    enter(); await released;
    const response = await serveCachedLifecycleAsset(input, value.cacheEnv, props);
    cache.set(key, response.clone()); return response;
  };
  const pending = value.read(undefined, "GET", {}, undefined, cached); await entered;
  try { await value.command("show-pause", ["daily", crypto.randomUUID()]); } finally { release(); }
  expect((await pending).status).toBe(200);
  expect((await value.read(undefined, "GET", {}, undefined, cached)).status).toBe(503); expect(calls).toBe(1);
  await value.command("show-delivery-resume", ["daily", crypto.randomUUID()]);
  expect((await value.read(undefined, "GET", {}, undefined, cached)).status).toBe(200); expect(calls).toBe(2);
});

test("mixed service state, separate Shows, deploy refusal and maintenance pause remain distinct", async () => {
  const value = await fixture(); await value.command("create-show", ["other", "https://example.com"]);
  await value.command("show-resume", ["other", crypto.randomUUID()]);
  await value.command("show-admission-pause", ["daily", crypto.randomUUID()]);
  expect(await value.command("service-status")).toMatchObject({ state: "open", open_shows: 1, admission_paused_shows: 1, paused_shows: 0 });
  await value.command("show-pause", ["other", crypto.randomUUID()]);
  expect(await value.command("service-status")).toMatchObject({ state: "admission_paused", open_shows: 0, admission_paused_shows: 1, paused_shows: 1 });
  await expect(value.command("update-service", [crypto.randomUUID()])).rejects.toThrow("pause and drain every Show");
  const request = { ...value.queue.identity(), operation_id: crypto.randomUUID(), namespace_id: "b".repeat(32),
    worker_source_sha256: "a".repeat(64), worker_metadata_sha256: "a".repeat(64) };
  expect(() => value.node().service.prepareUpdate(request)).toThrow("paused");
  await value.command("show-pause", ["daily", crypto.randomUUID()]);
  value.node().service.prepareUpdate(request);
  const stopped = sqliteAvailabilityResponseSchema.parse(await value.command("show-pause", ["daily", crypto.randomUUID()]));
  expect(stopped.publication_ready).toBe(false); expect((await value.read()).status).toBe(503);
  await expect(value.command("show-delivery-resume", ["daily", crypto.randomUUID()])).rejects.toThrow();
});

test("control endpoints reject unauthenticated, wrong Show, stale runtime and unversioned requests", async () => {
  const value = await fixture();
  const before = value.node().service.health().availability_version;
  for (const body of [{ ...value.queue.identity(), operation_id: crypto.randomUUID() },
    { ...value.queue.identity(), operation_id: crypto.randomUUID(), action: "pause", expected_availability_version: before, show_id: "other" }]) {
    const response = await value.node().service.fetch(new Request(`${value.config.workers_dev_base_url}/admin/sqlite-service/pause`, {
      method: "POST", headers: { "X-Castloop-Key": administratorKey(value.root), "X-Castloop-Show-Id": "daily", "Content-Type": "application/json" }, body: JSON.stringify(body),
    })); expect(response.status).toBe(409);
  }
  const unauthorized = await value.node().service.fetch(new Request(`${value.config.workers_dev_base_url}/admin/sqlite-service/controls/${crypto.randomUUID()}`,
    { headers: { "X-Castloop-Show-Id": "daily" } })); expect(unauthorized.status).toBe(401);
  expect(value.node().service.health().availability_version).toBe(before);
  value.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'blocked'");
  expect((await value.read()).status).toBe(503);
});

test("CLI rejects missing availability capabilities before sending controls", async () => {
  const value = await fixture();
  for (const field of ["availability_controls", "availability_version", "admission_state", "delivery_policy"]) {
    value.calls.length = 0;
    await expect(runSqliteCommand(value.root, value.config, "show-pause", ["daily", crypto.randomUUID()], {
      transport: async (input, init) => {
        const response = await value.transport(input, init);
        const body = await response.json() as Record<string, unknown>; delete body[field];
        return Response.json(body, { headers: { "Cache-Control": "no-store" } });
      }, cloudflare: value.options,
    })).rejects.toThrow();
    expect(value.calls.length).toBeGreaterThan(0); expect(value.calls.every((call) => call.method === "GET")).toBe(true);
    expect(value.node().service.health().state).toBe("open");
  }
});

test("a CLI killed after server application can reconcile using only GET with its process lock released", async () => {
  const value = await fixture(), id = crypto.randomUUID(); let applied!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { applied = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const target = request.headers.get("X-Castloop-Test-Target");
    if (!target || new URL(target).origin !== value.config.workers_dev_base_url) return new Response(null, { status: 400 });
    const headers = new Headers(request.headers); headers.delete("X-Castloop-Test-Target"); headers.delete("Host");
    const response = await value.transport(target, { method: request.method, headers,
      ...(request.method === "GET" ? {} : { body: request.body }) });
    if (target.endsWith("/admission-pause") && response.ok) { applied(); await released; }
    return response;
  } });
  const preload = fileURLToPath(new URL("./test-support/sqlite-cli-preload.ts", import.meta.url).href);
  const cli = fileURLToPath(new URL("./index.ts", import.meta.url).href);
  const child = Bun.spawn([process.execPath, "--preload", preload, cli, "show-admission-pause", "daily", id, "--json"], {
    cwd: value.root, env: { ...process.env, CASTLOOP_TEST_LOOPBACK_ORIGIN: `http://127.0.0.1:${server.port}` },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    await Promise.race([entered, child.exited.then(() => { throw new Error("Control CLI exited before reaching its application checkpoint"); })]);
    const version = value.node().service.health().availability_version;
    child.kill("SIGKILL"); await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    release(); value.calls.length = 0;
    expect(await value.command("show-admission-pause", ["daily", id])).toMatchObject({ state: "admission_paused", availability_version: version });
    expect(value.calls.every((call) => call.method === "GET")).toBe(true);
  } finally { release(); child.kill(); await child.exited; server.stop(true); }
}, 15000);
