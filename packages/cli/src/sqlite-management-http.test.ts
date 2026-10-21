import { describe, expect, test } from "bun:test";
import { readSqliteManagementGet, readSqliteManagementJson } from "./sqlite-management-http";
import type { SqliteManagementReadDiagnostic } from "./sqlite-management-http";
import type { R2RestTransport } from "./verified-r2-put";

const id = "11111111-1111-4111-8111-111111111111";
const url = new URL(`https://test-worker.example.workers.dev/admin/sqlite-publication/jobs/${id}`);
const headers = { "X-Castloop-Key": "private-administrator-key" };
const json = (value: unknown = { state: "running" }) => Response.json(value, { headers: { "Cache-Control": "no-store" } });
function fixture(transport: R2RestTransport) {
  let clock = 0;
  const diagnostics: SqliteManagementReadDiagnostic[] = [], waits: number[] = [], requests: Request[] = [];
  const options = { transport: async (input: Parameters<R2RestTransport>[0], init?: RequestInit) => {
    requests.push(new Request(input, init)); return transport(input, init);
  }, now: () => clock, delay: async (ms: number) => { waits.push(ms); clock += ms; }, onDiagnostic: (row: SqliteManagementReadDiagnostic) => { diagnostics.push(row); } };
  return { options, diagnostics, waits, requests, setClock: (value: number) => { clock = value; } };
}

describe("bounded SQLite management GET", () => {
  test("retries transport failures, retaining the exact GET and bounded backoff", async () => {
    let calls = 0;
    const f = fixture(async () => { if (++calls < 3) throw new Error("private-administrator-key private response text"); return json(); });
    expect(await readSqliteManagementGet(url, headers, f.options)).toEqual({ state: "running" });
    expect(calls).toBe(3); expect(f.waits).toEqual([250, 500]);
    expect(f.requests.every((request) => request.method === "GET" && request.url === url.href && request.headers.get("X-Castloop-Key") === headers["X-Castloop-Key"])).toBe(true);
    expect(f.diagnostics.map((row) => row.outcome)).toEqual(["retry", "retry"]);
    const recorded = JSON.stringify(f.diagnostics);
    expect(recorded).not.toContain("private"); expect(recorded).not.toContain(id); expect(recorded).not.toContain(url.origin);
  });
  test("stops after three failed requests", async () => {
    const f = fixture(async () => { throw new Error("private transport message"); });
    await expect(readSqliteManagementGet(url, headers, f.options)).rejects.toThrow("attempt=3");
    expect(f.requests.length).toBe(3); expect(f.waits).toEqual([250, 500]); expect(f.diagnostics.at(-1)?.outcome).toBe("failed");
  });
  for (const status of [408, 429, 500, 502, 503, 504]) test(`retries temporary HTTP ${status}`, async () => {
    let calls = 0;
    const f = fixture(async () => ++calls === 1 ? new Response("private error", { status, headers: { "Retry-After": "1" } }) : json());
    expect(await readSqliteManagementGet(url, headers, f.options)).toEqual({ state: "running" });
    expect(f.requests.length).toBe(2); expect(f.waits).toEqual([1000]); expect(f.diagnostics[0]?.http_status).toBe(status);
  });
  for (const status of [400, 401, 403, 404, 409, 422, 501]) test(`does not retry permanent HTTP ${status}`, async () => {
    const f = fixture(async () => new Response("private error", { status }));
    await expect(readSqliteManagementGet(url, headers, f.options)).rejects.toThrow(`http_status=${status}`);
    expect(f.requests.length).toBe(1); expect(f.waits).toEqual([]);
  });
  test("a verified missing publication is not retried or confused with JSON null", async () => {
    const missing = fixture(async () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } }));
    expect(await readSqliteManagementGet(url, headers, { ...missing.options, allowMissing: true })).toBeNull();
    expect(missing.requests.length).toBe(1);
    const invalid = fixture(async () => json(null));
    await expect(readSqliteManagementGet(url, headers, { ...invalid.options, allowMissing: true })).rejects.toThrow("invalid_response");
    expect(invalid.requests.length).toBe(1);
  });
  test("retries body transport errors, never malformed JSON or UTF-8", async () => {
    let calls = 0;
    const f = fixture(async () => ++calls === 1 ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("private body fault")); } }),
      { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } }) : json());
    expect(await readSqliteManagementGet(url, headers, f.options)).toEqual({ state: "running" }); expect(calls).toBe(2);
    for (const body of ["{private-invalid-json", new Uint8Array([255])]) {
      const invalid = fixture(async () => new Response(body, { headers: { "Cache-Control": "no-store", "Content-Type": "application/json" } }));
      await expect(readSqliteManagementGet(url, headers, invalid.options)).rejects.toThrow("not verified");
      expect(invalid.requests.length).toBe(1); expect(JSON.stringify(invalid.diagnostics)).not.toContain("private");
    }
  });
  test("retries an incomplete Content-Length but respects decoded compression", async () => {
    let calls = 0;
    const f = fixture(async () => ++calls === 1 ? new Response("{}", { headers: { "Cache-Control": "no-store", "Content-Type": "application/json", "Content-Length": "10" } }) : json());
    expect(await readSqliteManagementGet(url, headers, f.options)).toEqual({ state: "running" }); expect(calls).toBe(2);
    const compressed = fixture(async () => new Response('{"state":"running"}', { headers: { "Cache-Control": "no-store", "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": "2" } }));
    expect(await readSqliteManagementGet(url, headers, compressed.options)).toEqual({ state: "running" }); expect(compressed.requests.length).toBe(1);
  });
  test("refuses invalid envelope headers and oversized responses without retry", async () => {
    for (const response of [() => new Response("{}"), () => new Response("{}", { headers: { "Cache-Control": "no-store", "Content-Type": "application/json", "Content-Range": "bytes 0-1/2" } }),
      () => new Response("{}", { headers: { "Cache-Control": "no-store", "Content-Type": "application/json", "Content-Length": "70000" } }), () => json({ value: "x".repeat(17000) })]) {
      const f = fixture(async () => response());
      await expect(readSqliteManagementGet(url, headers, f.options)).rejects.toThrow(); expect(f.requests.length).toBe(1);
    }
  });
  test("never starts another request before cleanup settles, and cleanup failure stops retries", async () => {
    let release!: () => void, calls = 0;
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture(async () => ++calls === 1 ? new Response(new ReadableStream({ cancel: () => cleanup }), { status: 503 }) : json());
    const pending = readSqliteManagementGet(url, headers, f.options);
    await Bun.sleep(1); expect(calls).toBe(1); expect(f.waits).toEqual([]);
    release(); expect(await pending).toEqual({ state: "running" }); expect(calls).toBe(2);
    const failed = fixture(async () => new Response(new ReadableStream({ cancel() { throw new Error("private cleanup fault"); } }), { status: 503 }));
    await expect(readSqliteManagementGet(url, headers, failed.options)).rejects.toThrow("cleanup_failed"); expect(failed.requests.length).toBe(1);
  });
  test("deadline and Retry-After cannot extend the new-attempt budget", async () => {
    const elapsed = fixture(async () => { elapsed.setClock(30001); throw new Error("disconnected"); });
    await expect(readSqliteManagementGet(url, headers, elapsed.options)).rejects.toThrow(); expect(elapsed.requests.length).toBe(1);
    const long = fixture(async () => new Response(null, { status: 429, headers: { "Retry-After": "60" } }));
    await expect(readSqliteManagementGet(url, headers, long.options)).rejects.toThrow(); expect(long.requests.length).toBe(1); expect(long.waits).toEqual([]);
    const delayed = fixture(async () => { throw new Error("disconnected"); });
    await expect(readSqliteManagementGet(url, headers, { ...delayed.options, timeoutMs: 1000, delay: async () => { delayed.setClock(1000); } })).rejects.toThrow("deadline_exceeded");
    expect(delayed.requests.length).toBe(1);
  });
  test("a timed out request is awaited rather than abandoned or overlapped", async () => {
    let settle!: () => void;
    const f = fixture(async () => { await new Promise<void>((resolve) => { settle = resolve; }); throw new Error("settled disconnect"); });
    const pending = readSqliteManagementGet(url, headers, f.options);
    await Bun.sleep(1); f.setClock(30001); await Bun.sleep(1); expect(f.requests.length).toBe(1); expect(f.waits.length).toBe(0);
    settle(); await expect(pending).rejects.toThrow(); expect(f.requests.length).toBe(1);
  });
  test("bounds and clears the actual request abort timer", async () => {
    let signal: AbortSignal | null | undefined;
    const f = fixture(async (_url, init) => { signal = init?.signal; return json(); });
    // Generous budget so scheduler stalls on loaded CI cannot cross the deadline before the attempt starts.
    expect(await readSqliteManagementGet(url, headers, { ...f.options, timeoutMs: 250 })).toEqual({ state: "running" });
    await Bun.sleep(300); expect(signal?.aborted).toBe(false);
    let calls = 0;
    await expect(readSqliteManagementGet(url, headers, { timeoutMs: 250, onDiagnostic: () => {}, transport: async (_input, init) => {
      calls++; await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); return json();
    } })).rejects.toThrow("observation_timeout"); expect(calls).toBe(1);
  });
  test("rejects mutation paths and unbounded targets before any network request", async () => {
    const f = fixture(async () => json());
    for (const target of [new URL("http://test.invalid/admin/sqlite-service/health"), new URL("https://test.invalid/admin/sqlite-service/resume"),
      new URL(`${url}?secret=private`), new URL("https://private@test.invalid/admin/sqlite-service/health")]) {
      await expect(readSqliteManagementGet(target, headers, f.options)).rejects.toThrow("Invalid");
    }
    expect(f.requests.length).toBe(0);
  });
});

test("SQLite JSON reader releases a complete stream without canceling, but cancels unfinished rejected input", async () => {
  let cancels = 0, reads = 0, releases = 0;
  const response = { headers: new Headers({ "Cache-Control": "no-store", "Content-Type": "application/json" }), body: { getReader: () => ({
    read: async () => ++reads === 1 ? { done: false, value: new TextEncoder().encode("{}") } : { done: true, value: undefined },
    cancel: async () => { cancels++; }, releaseLock: () => { releases++; },
  }) } } as unknown as Response;
  expect(await readSqliteManagementJson(response)).toEqual({}); expect(cancels).toBe(0); expect(releases).toBe(1);
  reads = 0; await expect(readSqliteManagementJson(response, 1)).rejects.toThrow("size_limit"); expect(cancels).toBe(1); expect(releases).toBe(2);
});
