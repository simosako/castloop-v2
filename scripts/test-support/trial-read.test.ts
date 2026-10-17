import { describe, expect, test } from "bun:test";
import { readTrialObject, TrialReadError } from "./trial-read";
import type { TrialReadDiagnostic } from "./trial-read";

const url = "https://private.invalid/secret-object?token=never-log";
const good = () => new Response("metadata", { headers: { ETag: "verified" } });
function fixture() {
  const diagnostics: TrialReadDiagnostic[] = [], waits: number[] = []; let time = 0;
  return { diagnostics, waits, options: { maximumBytes: 32, requireEtag: true,
    onDiagnostic: (value: TrialReadDiagnostic) => { diagnostics.push(value); }, now: () => time,
    delay: async (ms: number) => { waits.push(ms); time += ms; } }, advance: (ms: number) => { time += ms; } };
}

describe("bounded read-only trial observation", () => {
  test("only performs GET and retries transient transport failure without exposing secrets", async () => {
    const f = fixture(); let calls = 0;
    const result = await readTrialObject(url, { ...f.options, headers: { Authorization: "Bearer secret" }, transport: async (_url, init) => {
      expect(init.method).toBe("GET"); expect(init.redirect).toBe("error"); expect(init.cache).toBe("no-store");
      if (++calls === 1) throw new TypeError("secret upstream response"); return good();
    } });
    expect(new TextDecoder().decode(result.bytes)).toBe("metadata"); expect(calls).toBe(2); expect(f.waits).toEqual([250]);
    expect(f.diagnostics[0]).toMatchObject({ outcome: "retry", reason_code: "transport_error", attempt: 1 });
    expect(JSON.stringify(f.diagnostics)).not.toContain("secret"); expect(JSON.stringify(f.diagnostics)).not.toContain("private.invalid");
  });
  test("distinguishes a DOMException timeout and shares the original deadline across attempts", async () => {
    const f = fixture(); let calls = 0;
    const result = await readTrialObject(url, { ...f.options, timeoutMs: 100, attemptTimeoutMs: 10, transport: async (_url, init) => {
      calls++;
      if (calls === 1) { await new Promise<void>((resolve) => init.signal!.addEventListener("abort", () => resolve(), { once: true }));
        f.advance(10); throw new DOMException("private timeout", "TimeoutError"); } return good();
    }, delay: async (ms) => { f.advance(ms); } }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(TrialReadError); expect(calls).toBe(1);
    expect(f.diagnostics[0]).toMatchObject({ outcome: "failed", reason_code: "observation_timeout" });
  });
  test.each([408, 429, 500, 502, 503, 504])("retries transient HTTP %i only after old response cancellation settles", async (status) => {
    const f = fixture(); let calls = 0, canceled = false;
    await readTrialObject(url, { ...f.options, transport: async () => {
      if (++calls === 1) return new Response(new ReadableStream({ async cancel() { await Bun.sleep(1); canceled = true; } }), { status });
      expect(canceled).toBe(true); return good();
    } });
    expect(calls).toBe(2); expect(f.diagnostics[0]?.http_status).toBe(status);
  });
  test.each([401, 403, 404, 409, 501])("never retries HTTP %i or treats missing evidence as success", async (status) => {
    const f = fixture(); let calls = 0;
    await expect(readTrialObject(url, { ...f.options, transport: async () => { calls++; return new Response("private", { status }); } })).rejects.toThrow("http_error");
    expect(calls).toBe(1); expect(f.waits).toEqual([]);
  });
  test("respects Retry-After within a shared deadline and never starts another GET beyond it", async () => {
    const f = fixture(); let calls = 0;
    await expect(readTrialObject(url, { ...f.options, transport: async () => {
      calls++; f.advance(10000); return new Response("no", { status: 429, headers: { "Retry-After": "20" } });
    } })).rejects.toThrow("http_error"); expect(calls).toBe(1); expect(f.waits).toEqual([]);
    expect(f.diagnostics[0]).toMatchObject({ elapsed_ms: 10000, outcome: "failed" });
  });
  test("has a finite retry count", async () => {
    const f = fixture(); let calls = 0;
    await expect(readTrialObject(url, { ...f.options, transport: async () => { calls++; throw new Error("private"); } })).rejects.toThrow("transport_error");
    expect(calls).toBe(3); expect(f.waits).toEqual([250, 500]); expect(f.diagnostics.at(-1)?.outcome).toBe("failed");
  });
  test("does not retry invalid headers, oversized bodies, or failed cleanup", async () => {
    for (const response of [new Response("partial", { headers: { "Content-Range": "bytes 0-6/20", ETag: "ok" } }),
      new Response("missing etag"), new Response("x".repeat(33), { headers: { ETag: "ok" } }),
      new Response(new ReadableStream({ cancel() { throw new Error("private cleanup"); } }), { status: 503 })]) {
      const f = fixture(); let calls = 0;
      await expect(readTrialObject(url, { ...f.options, transport: async () => { calls++; return response; } })).rejects.toBeInstanceOf(TrialReadError);
      expect(calls).toBe(1); expect(f.diagnostics[0]?.outcome).toBe("failed");
    }
  });
  test("streams unknown-length bodies with a bound and retries body IO, not parsing or validation", async () => {
    const f = fixture(); let calls = 0;
    const result = await readTrialObject(url, { ...f.options, transport: async () => ++calls === 1 ?
      new Response(new ReadableStream({ start(controller) { controller.error(new Error("private body")); } }), { headers: { ETag: "ok" } }) : good() });
    expect(result.bytes.length).toBe(8); expect(calls).toBe(2); expect(f.diagnostics[0]?.reason_code).toBe("body_read_failed");
  });
  test("does not cancel a fully consumed response or accept invalid limits", async () => {
    const f = fixture(); let canceled = false;
    await readTrialObject(url, { ...f.options, transport: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); }, cancel() { canceled = true; } }), { headers: { ETag: "ok" } }) });
    expect(canceled).toBe(false);
    await expect(readTrialObject(url, { ...f.options, maximumBytes: 0 })).rejects.toThrow("Invalid");
    await expect(readTrialObject(url, { ...f.options, maximumAttempts: 4 })).rejects.toThrow("Invalid");
  });
  test("bounds decoded bytes without confusing compressed Content-Length with payload length", async () => {
    const f = fixture();
    const result = await readTrialObject(url, { ...f.options, transport: async (_url, init) => {
      expect(new Headers(init.headers).get("Accept-Encoding")).toBe("identity");
      return new Response("metadata", { headers: { ETag: "ok", "Content-Encoding": "gzip", "Content-Length": "100" } });
    } }); expect(result.bytes.length).toBe(8);
    await expect(readTrialObject(url, { ...f.options, transport: async () => new Response("short", {
      headers: { ETag: "ok", "Content-Length": "10" } }) })).rejects.toThrow("partial_response");
  });
});
