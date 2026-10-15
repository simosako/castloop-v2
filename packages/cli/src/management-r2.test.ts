import { expect, test } from "bun:test";
import { m6ServiceConfigHash, serviceConfigSchema, stringifyToml } from "@castloop/shared";
import { ManagementR2Reader, readManagementRuntime } from "./management-r2";
import type { ManagementR2Options, ManagementReadDiagnostic } from "./management-r2";

const config = serviceConfigSchema.parse({ schema_version: 1, service_id: "test", account_id: "a".repeat(32),
  bucket_name: "test-bucket", worker_name: "test-worker", queue_name: "test-queue", dlq_name: "test-dlq",
  public_base_url: "https://test-worker.example.workers.dev" });
const object = () => new Response("verified", { headers: { ETag: '"etag"' } });

function fixture(responses: Array<Response | Error>, overrides: Partial<ManagementR2Options> = {}) {
  const diagnostics: ManagementReadDiagnostic[] = [], calls: Array<{ url: string; init?: RequestInit }> = [], waits: number[] = [];
  let clock = 0;
  const reader = new ManagementR2Reader(config, { accountId: config.account_id, apiToken: "private-token",
    onDiagnostic: (row) => diagnostics.push(row), now: () => clock, delay: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; },
    transport: async (url, init) => {
      calls.push({ url: String(url), init });
      const value = responses[calls.length - 1];
      if (value instanceof Error) throw value;
      if (!value) throw new Error("Unexpected fixture request");
      return value;
    }, ...overrides });
  return { reader, diagnostics, calls, waits };
}

test("management reads keep bounded full-object GET, exact ETag and no cache", async () => {
  const setup = fixture([object()]);
  expect(await setup.reader.read("system/service.toml")).toEqual({ source: "verified", etag: '"etag"' });
  expect(setup.calls.length).toBe(1); expect(setup.diagnostics.length).toBe(0);
  const call = setup.calls[0]!;
  expect(call.init?.method).toBe("GET"); expect(call.init?.cache).toBe("no-store"); expect(call.init?.redirect).toBe("error");
  expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer private-token");
});

for (const status of [408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]) {
  test(`transient HTTP ${status} retries only GET and validates the successful response`, async () => {
    const setup = fixture([new Response("untrusted error body", { status, headers: { "CF-Ray": "0123456789abcdef-NRT" } }), object()]);
    expect((await setup.reader.read("system/service.toml"))?.source).toBe("verified");
    expect(setup.calls.map((call) => call.init?.method)).toEqual(["GET", "GET"]);
    expect(setup.waits).toEqual([500]);
    expect(setup.diagnostics[0]).toMatchObject({ outcome: "retry", reason_code: "http_error", http_status: status,
      cf_ray: "0123456789abcdef-NRT", key_family: "service_config", attempt: 1 });
    expect(setup.calls[0]!.init?.signal).toBe(setup.calls[1]!.init?.signal);
  });
}

test("network read failures are retried without leaking exception messages", async () => {
  const setup = fixture([new Error("private-token arbitrary sensitive exception"), object()]);
  expect((await setup.reader.read("system/service.toml"))?.source).toBe("verified");
  expect(setup.diagnostics[0]?.reason_code).toBe("transport_error");
  expect(JSON.stringify(setup.diagnostics)).not.toContain("private-token");
});

test("transient failures stop after three attempts", async () => {
  const setup = fixture([502, 502, 502].map((status) => new Response("secret-body", { status })));
  await expect(setup.reader.read("system/service.toml")).rejects.toThrow("http_status=502, attempt=3");
  expect(setup.calls.length).toBe(3); expect(setup.waits).toEqual([500, 1000]);
  expect(setup.diagnostics.map((row) => row.outcome)).toEqual(["retry", "retry", "failed"]);
});

for (const status of [400, 401, 403, 409, 416, 501]) {
  test(`HTTP ${status} fails closed without retry`, async () => {
    const setup = fixture([new Response("untrusted-secret", { status })]);
    await expect(setup.reader.read("system/service.toml")).rejects.toThrow(`http_status=${status}, attempt=1`);
    expect(setup.calls.length).toBe(1); expect(setup.waits.length).toBe(0);
  });
}

test("404 remains an absent object rather than a retry or publication success", async () => {
  const setup = fixture([new Response(null, { status: 404 })]);
  expect(await setup.reader.read("system/management-requests/absent/result.json")).toBeNull();
  expect(setup.calls.length).toBe(1); expect(setup.diagnostics.length).toBe(0);
});

for (const [reason, response, maximum] of [
  ["missing_body", () => new Response(null, { headers: { ETag: '"etag"' } }), 16384],
  ["missing_etag", () => new Response("object"), 16384],
  ["partial_response", () => new Response("object", { headers: { ETag: '"etag"', "Content-Range": "bytes 0-5/20" } }), 16384],
  ["size_limit", () => new Response("too long", { headers: { ETag: '"etag"' } }), 2],
  ["empty_object", () => new Response("", { headers: { ETag: '"etag"' } }), 16384],
  ["invalid_utf8", () => new Response(new Uint8Array([0xff]), { headers: { ETag: '"etag"' } }), 16384],
] as const) {
  test(`${reason} is diagnosed without retrying invalid data`, async () => {
    const setup = fixture([response()]);
    await expect(setup.reader.read("public/episodes/show/episode/metadata.toml", maximum)).rejects.toThrow(`reason_code=${reason}`);
    expect(setup.calls.length).toBe(1); expect(setup.diagnostics[0]?.key_family).toBe("episode_current");
  });
}

test("Retry-After is respected only within the original overall read budget", async () => {
  const setup = fixture([new Response("busy", { status: 429, headers: { "Retry-After": "2" } }), object()]);
  await setup.reader.read("system/service.toml"); expect(setup.waits).toEqual([2000]);
  const tooLong = fixture([new Response("busy", { status: 429, headers: { "Retry-After": "300" } })]);
  await expect(tooLong.reader.read("system/service.toml")).rejects.toThrow("http_status=429");
  expect(tooLong.calls.length).toBe(1); expect(tooLong.waits.length).toBe(0);
  expect(tooLong.diagnostics[0]?.retry_after_ms).toBe(300000);
});

test("read retry budget is shared, not a fresh 30 seconds per attempt", async () => {
  const setup = fixture([new Response("busy", { status: 503 }), new Response("busy", { status: 503 })], { timeoutMs: 1000 });
  await expect(setup.reader.read("system/service.toml")).rejects.toThrow("attempt=2");
  expect(setup.calls.length).toBe(2); expect(setup.waits).toEqual([500]);
});

test("an expired transport timeout does not start a retry", async () => {
  let calls = 0;
  const setup = fixture([], { timeoutMs: 5, transport: async () => { calls++; await Bun.sleep(20); throw new Error("private-token"); } });
  await expect(setup.reader.read("system/service.toml")).rejects.toThrow("reason_code=deadline_exceeded");
  expect(calls).toBe(1); expect(setup.waits.length).toBe(0);
});

test("diagnostics contain allowlisted metadata, never object keys, error bodies or credentials", async () => {
  const key = "system/private-user@example.com/title-secret";
  const setup = fixture([new Response("private-token private-user@example.com title-secret", { status: 403,
    headers: { "CF-Ray": "private-token", ETag: "title-secret", "X-Secret": "private-token" } })]);
  let error: unknown;
  try { await setup.reader.read(key); } catch (caught) { error = caught; }
  const text = JSON.stringify(setup.diagnostics) + String(error);
  for (const secret of [key, "private-token", "private-user@example.com", "title-secret", config.account_id]) expect(text).not.toContain(secret);
  expect(setup.diagnostics[0]?.key_sha256).toMatch(/^[a-f0-9]{64}$/);
});

test("the previous response cancellation settles before a GET retry starts", async () => {
  let release!: () => void, enter!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const first = new Response(new ReadableStream({ async cancel() { enter(); await released; } }), { status: 503 });
  const setup = fixture([first, object()]);
  const running = setup.reader.read("system/service.toml");
  try {
    await entered; expect(setup.calls.length).toBe(1); release();
    expect((await running)?.source).toBe("verified"); expect(setup.calls.length).toBe(2);
  } finally { release(); await running; }
});

test("GET retry does not bypass the service snapshot consistency check", async () => {
  const uuid = "11111111-1111-4111-8111-111111111111";
  const source = stringifyToml(config);
  const admission = { schema_version: 1, service_id: config.service_id, generation: 0, mode: "m6", state: "open", invocations: [],
    last_resumed_pause_id: uuid, runtime_readiness: { operation_id: uuid, deployment_id: uuid, worker_version_id: uuid,
      service_config_sha256: await m6ServiceConfigHash(config), default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets",
      cutover_verified: true, publication_routes_verified: true, management_protocol: "queue-management-v1" } };
  const setup = fixture([new Response(source, { headers: { ETag: '"before"' } }), new Response("busy", { status: 503 }),
    new Response(JSON.stringify(admission), { headers: { ETag: '"admission"' } }),
    new Response(source + "\n", { headers: { ETag: '"after"' } })]);
  await expect(readManagementRuntime(setup.reader, config)).rejects.toThrow("Service configuration changed during management inspection");
  expect(setup.calls.length).toBe(4); expect(setup.diagnostics.length).toBe(1);
});
