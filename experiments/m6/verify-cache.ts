import { strict as assert } from "node:assert";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");

const name = `castloop-m6-cache-${crypto.randomUUID().slice(0, 8)}`;
const directory = resolve("/tmp/opencode", name);
const secret = crypto.randomUUID() + crypto.randomUUID();
const apiRoot = `https://api.cloudflare.com/client/v4/accounts/${account}`;
type ApiEnvelope = { success: boolean; result: Record<string, unknown>; errors?: unknown[] };
type Observation = { path: string; method: string; status: number; bytes: number;
  gateway: string | null; inner: string | null; cache: string | null; range: string | null;
  contentRange: string | null; colo: string | undefined; elapsedMs: number };
const observations: Observation[] = [];
const checks: string[] = [];
let baseUrl = "";
let createdBucket = false;
let createdWorker = false;
let healthy = false;
const cleanupAttempts: Array<{ path: string; attempt: number; error?: string }> = [];

async function api(method: string, path: string, body?: BodyInit, optional = false): Promise<ApiEnvelope | null> {
  const response = await fetch(apiRoot + path, { method, body,
    headers: { Authorization: `Bearer ${token}`, ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}) },
    signal: AbortSignal.timeout(60000) });
  if (optional && response.status === 404) return null;
  const data = await response.json() as ApiEnvelope;
  if (!response.ok || !data.success) throw new Error(`Cloudflare ${method} ${path}: ${response.status} ${JSON.stringify(data.errors)}`);
  return data;
}

async function admin(action: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await fetch(baseUrl + "/admin", { method: "POST", headers: {
    "X-M6-Key": secret, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...fields }),
    signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `Admin ${action}: ${await response.clone().text()}`);
  return response.json();
}

async function get(path: string, method = "GET", range?: string, headers: Record<string, string> = {}) {
  const start = Date.now();
  const response = await fetch(baseUrl + path, { method, headers: { ...headers, ...(range ? { Range: range } : {}) },
    signal: AbortSignal.timeout(40000) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  observations.push({ path, method, status: response.status, bytes: bytes.length,
    gateway: response.headers.get("X-Gateway-ID"), inner: response.headers.get("X-Inner-ID"),
    cache: response.headers.get("X-Inner-Cache"), range: response.headers.get("X-Inner-Range"),
    contentRange: response.headers.get("Content-Range"), colo: response.headers.get("Cf-Ray")?.split("-").at(-1),
    elapsedMs: Date.now() - start });
  return { response, bytes };
}

async function warm(path: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await get(path);
    assert.equal(result.response.status, 200);
    if (result.response.headers.get("X-Inner-Cache") === "HIT") return result;
    await Bun.sleep(200);
  }
  throw new Error(`Internal cache did not HIT: ${path}`);
}

function passed(name: string): void {
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function deleteResource(path: string): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await api("DELETE", path, undefined, true);
      assert.equal(await api("GET", path.startsWith("/workers/scripts/") ? `${path}/settings` : path,
        undefined, true), null, "Resource still exists after deletion");
      cleanupAttempts.push({ path, attempt });
      return;
    } catch (error) {
      cleanupAttempts.push({ path, attempt, error: String(error) });
      if (attempt === 4) throw error;
      await Bun.sleep(1000 * 2 ** (attempt - 1));
    }
  }
}

await mkdir(directory, { mode: 0o700 });
await writeFile(`${directory}/manifest.json`, JSON.stringify({ name, account, secret }), { mode: 0o600 });
await chmod(directory, 0o700);
let failure: string | undefined;
let cleanupError: string | undefined;
let settings: unknown;
try {
  const subdomain = await api("GET", "/workers/subdomain");
  assert.equal(typeof subdomain?.result.subdomain, "string");
  baseUrl = `https://${name}.${subdomain!.result.subdomain}.workers.dev`;
  assert.equal(await api("GET", `/workers/scripts/${name}/settings`, undefined, true), null, "Worker name collision");
  assert.equal(await api("GET", `/r2/buckets/${name}`, undefined, true), null, "Bucket name collision");
  createdBucket = true;
  await api("POST", "/r2/buckets", JSON.stringify({ name }));
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "cache-worker.ts")],
    target: "browser", format: "esm", external: ["cloudflare:*"], minify: false });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  assert.equal(build.outputs.length, 1);
  const metadata = { main_module: "worker.js", compatibility_date: "2026-09-30",
    cache_options: { enabled: true, cross_version_cache: false },
    exports: { default: { type: "worker", cache: { enabled: false } },
      CachedMedia: { type: "worker", cache: { enabled: true } } },
    bindings: [{ type: "r2_bucket", name: "CASTLOOP_BUCKET", bucket_name: name },
      { type: "secret_text", name: "M6_SECRET", text: secret }],
    observability: { enabled: true, head_sampling_rate: 1,
      logs: { enabled: true }, traces: { enabled: true, head_sampling_rate: 1 } } };
  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.set("worker.js", new Blob([await build.outputs[0].text()], { type: "application/javascript+module" }), "worker.js");
  createdWorker = true;
  const upload = await api("PUT", `/workers/scripts/${name}`, form);
  await api("POST", `/workers/scripts/${name}/subdomain`, JSON.stringify({ enabled: true, previews_enabled: false }));
  const result = await api("GET", `/workers/scripts/${name}/settings`);
  settings = { cache_options: result?.result.cache_options, uploadedExports: upload?.result.exports,
    requestedExports: metadata.exports, compatibility_date: result?.result.compatibility_date,
    observability: result?.result.observability, usage_model: result?.result.usage_model };
  await writeFile(`${directory}/settings.json`, JSON.stringify(settings, null, 2));
  assert.deepEqual(result?.result.cache_options, metadata.cache_options);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl + "/health", { signal: AbortSignal.timeout(5000) });
      if (response.ok && (await response.json() as { probe?: string }).probe === "m6-cache-v1") { healthy = true; break; }
    } catch {}
    await Bun.sleep(1000);
  }
  assert.ok(healthy, "Worker health did not converge within 120 seconds");
  passed("REST deploy with per-entrypoint cache metadata");
  await admin("seed");
  const root = "/podcasts/probe/";
  const feed = root + "feed.xml";
  const cover = root + "cover.png";
  const audio = root + "episodes/first/r1.mp3";
  const paused = root + "episodes/first/r2.mp3";
  const first = await warm(feed);
  const expectedBytes = Uint8Array.from({ length: 65536 }, (_, index) => index % 251);
  assert.deepEqual(first.bytes, expectedBytes);
  const second = await get(feed);
  assert.equal(second.response.headers.get("X-Inner-Cache"), "HIT");
  assert.equal(first.response.headers.get("X-Inner-ID"), second.response.headers.get("X-Inner-ID"));
  assert.notEqual(first.response.headers.get("X-Gateway-ID"), second.response.headers.get("X-Gateway-ID"));
  assert.equal(second.response.headers.get("Cache-Control"), "no-store");
  passed("gateway runs on internal cache HIT; client cache is no-store");
  const coldRange = await get(audio, "GET", "bytes=0-9");
  assert.equal(coldRange.response.status, 206);
  assert.equal(coldRange.response.headers.get("Content-Range"), "bytes 0-9/65536");
  assert.deepEqual(coldRange.bytes, Uint8Array.from({ length: 10 }, (_, index) => index));
  assert.equal(coldRange.response.headers.get("X-Inner-Range"), "absent");
  await warm(audio);
  const hotRange = await get(audio, "GET", "bytes=250-259");
  assert.equal(hotRange.response.status, 206);
  assert.equal(hotRange.response.headers.get("X-Inner-Cache"), "HIT");
  assert.deepEqual(hotRange.bytes, Uint8Array.from({ length: 10 }, (_, index) => (250 + index) % 251));
  const suffix = await get(audio, "GET", "bytes=-10");
  assert.equal(suffix.response.status, 206);
  assert.deepEqual(suffix.bytes, Uint8Array.from({ length: 10 }, (_, index) => (65526 + index) % 251));
  const invalid = await get(audio, "GET", "bytes=65536-");
  assert.equal(invalid.response.status, 416);
  const head = await get(audio, "HEAD");
  assert.equal(head.response.status, 200);
  assert.equal(head.bytes.length, 0);
  assert.equal(head.response.headers.get("Content-Length"), "65536");
  passed("cold/hot Range, suffix, 416 and HEAD delivery");
  await warm(cover);
  await admin("episode", { lifecycle: "unpublished" });
  for (const method of ["GET", "HEAD"]) {
    assert.equal((await get(audio, method, "bytes=0-9")).response.status, 404);
  }
  assert.equal((await get(audio + "?generation=0&bypass=true", "GET", undefined,
    { "If-None-Match": hotRange.response.headers.get("ETag")! })).response.status, 404);
  assert.equal((await get(feed)).response.status, 200);
  assert.equal((await get(cover)).response.status, 200);
  await admin("episode", { lifecycle: "deleted" });
  assert.equal((await get(audio)).response.status, 410);
  await admin("episode", { lifecycle: "active" });
  await admin("show", { lifecycle: "unpublished" });
  for (const path of [feed, cover, audio]) {
    assert.equal((await get(path)).response.status, 404);
    assert.equal((await get(path, "HEAD")).response.status, 404);
    assert.equal((await get(path, "GET", "bytes=0-9")).response.status, 404);
    assert.equal((await get(path + "?generation=0", "GET", undefined, { "If-None-Match": "*" })).response.status, 404);
  }
  await admin("show", { lifecycle: "deleted" });
  assert.equal((await get(feed)).response.status, 410);
  await admin("show", { lifecycle: "active" });
  passed("warm-cache Episode and parent Show gates without purge");
  await admin("payload", { byte: 123 });
  assert.deepEqual((await get(feed)).bytes, first.bytes);
  const outerPurge = await admin("purge-outer");
  assert.deepEqual((await get(feed)).bytes, first.bytes);
  const innerPurge = await admin("purge-inner");
  assert.equal(innerPurge.success, true);
  let fresh = await get(feed);
  for (let attempt = 0; fresh.bytes[0] !== 123 && attempt < 15; attempt += 1) {
    await Bun.sleep(200);
    fresh = await get(feed);
  }
  assert.equal(fresh.bytes[0], 123);
  assert.deepEqual(fresh.bytes, new Uint8Array(65536).fill(123));
  assert.notEqual(fresh.response.headers.get("X-Inner-ID"), first.response.headers.get("X-Inner-ID"));
  await writeFile(`${directory}/purge.json`, JSON.stringify({ outerPurge, innerPurge }, null, 2));
  passed("outer purge leaves inner cache intact; inner RPC tag purge refreshes it");
  const coldHead = await get(cover, "HEAD");
  assert.equal(coldHead.response.status, 200);
  assert.equal(coldHead.bytes.length, 0);
  assert.equal(coldHead.response.headers.get("Content-Length"), "65536");
  assert.deepEqual((await get(cover)).bytes, expectedBytes);
  passed("cold HEAD does not poison the shared GET cache entry");
  const oldAudio = await warm(audio);
  const oldCover = await warm(cover);
  assert.equal((await admin("purge-prefix")).success, true);
  let newAudio = await get(audio);
  for (let attempt = 0; newAudio.response.headers.get("X-Inner-ID") === oldAudio.response.headers.get("X-Inner-ID") &&
    attempt < 15; attempt += 1) {
    await Bun.sleep(200);
    newAudio = await get(audio);
  }
  assert.notEqual(newAudio.response.headers.get("X-Inner-ID"), oldAudio.response.headers.get("X-Inner-ID"));
  assert.equal((await get(cover)).response.headers.get("X-Inner-ID"), oldCover.response.headers.get("X-Inner-ID"));
  passed("inner path-prefix purge invalidates tagless audio without purging cover");
  await warm(feed);
  await admin("corrupt");
  assert.equal((await get(feed)).response.status, 503);
  await admin("seed");
  passed("corrupt control record fails closed despite warm cache");
  const pause = await admin("pause");
  const inflight = get(paused);
  let started = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await admin("started", { token: pause.token })).started === true) { started = true; break; }
    await Bun.sleep(100);
  }
  assert.ok(started, "Paused inner request did not start");
  await admin("show", { lifecycle: "unpublished", bump: true });
  assert.equal((await get(paused)).response.status, 404);
  await admin("release", { token: pause.token });
  const old = await inflight;
  assert.equal(old.response.status, 200);
  assert.equal((await get(paused)).response.status, 404);
  await admin("show", { lifecycle: "active", bump: true });
  const restored = await get(paused);
  assert.equal(restored.response.status, 200);
  assert.equal(restored.response.headers.get("X-Inner-Generation"), "2");
  assert.notEqual(old.response.headers.get("X-Inner-ID"), restored.response.headers.get("X-Inner-ID"));
  await warm(paused);
  passed("old in-flight cache fill cannot bypass stop or restored generation");
  for (const path of ["/system/show-publications/probe.json", "/staging/audio.mp3", "/admin", "/CachedMedia"]) {
    assert.equal((await get(path)).response.status, 404);
  }
  const unauthorized = await fetch(baseUrl + "/admin", { method: "POST", body: JSON.stringify({ action: "seed" }) });
  assert.equal(unauthorized.status, 401);
  passed("private paths and unauthenticated probe administration are blocked");
} catch (error) {
  failure = String(error);
  console.error(failure);
} finally {
  const errors: string[] = [];
  if (healthy) {
    try { await admin("cleanup"); } catch (error) { errors.push(String(error)); }
  }
  for (const path of [createdWorker ? `/workers/scripts/${name}` : "", createdBucket ? `/r2/buckets/${name}` : ""]) {
    if (!path) continue;
    try { await deleteResource(path); } catch (error) { errors.push(String(error)); }
  }
  if (errors.length) { cleanupError = errors.join("\n"); console.error(`Cleanup failed: ${cleanupError}`); }
  await writeFile(`${directory}/results.json`, JSON.stringify({ name, baseUrl, settings, checks, observations,
    failure, cleanupError, cleanupAttempts, cleanedUp: !cleanupError, finishedAt: new Date().toISOString() }, null, 2));
  console.log(`Results: ${directory}/results.json`);
}
if (failure || cleanupError) process.exitCode = 1;
