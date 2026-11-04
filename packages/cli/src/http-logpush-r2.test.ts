import { expect, test } from "bun:test";
import { HttpLogpushR2 } from "./http-logpush-r2";
import type { HttpLogpushFile } from "./http-logpush-r2";
import type { HttpLogpushRecord } from "./http-logpush-events";
import { logObject, logPrefix, logR2Fixture, logRecord, logTarget } from "./test-support/http-logpush";

test("R2 log listing freezes all pages under the service and zone prefix", async () => {
  const first = logObject("2026-11-04/a.json.gz", ""), second = logObject("2026-11-03/b.json.gz", "");
  const fixture = logR2Fixture([first, second], 1);
  const r2 = new HttpLogpushR2(logTarget, { accountId: logTarget.accountId, apiToken: "test-token", transport: fixture.transport });
  expect(await r2.listFiles()).toEqual([second.file, first.file]);
  expect(fixture.requests).toHaveLength(2);
  for (const request of fixture.requests) {
    const url = new URL(request.url);
    expect(url.searchParams.get("prefix")).toBe(logPrefix);
    expect(url.searchParams.get("per_page")).toBe("1000");
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
    expect(url.searchParams.has("delimiter")).toBe(false);
  }
  expect(new URL(fixture.requests[1]!.url).searchParams.get("cursor")).toBe("1");
  expect(fixture.bodyReads).toEqual([]);
});

test("R2 log listing rejects incomplete, wrong-prefix and repeated pagination responses", async () => {
  const object = logObject("2026-11-04/a.gz", "");
  for (const page of [
    { success: true, result: [object.file] },
    { success: true, result: [object.file], result_info: { is_truncated: true } },
    { success: true, result: [object.file], result_info: { is_truncated: true, cursor: "same" } },
    { success: true, result: [{ ...object.file, key: "http/another-service/file.gz" }], result_info: { is_truncated: false } },
  ]) {
    let calls = 0;
    const r2 = new HttpLogpushR2(logTarget, { accountId: logTarget.accountId, apiToken: "test-token",
      transport: async () => { calls++; return Response.json(page); } });
    await expect(r2.listFiles()).rejects.toThrow("R2 log listing");
    expect(calls).toBeLessThanOrEqual(2);
  }
});

test("R2 log files stream gzip NDJSON across chunk boundaries with CRLF and a final unterminated line", async () => {
  const other = { ...logRecord, RayID: "7b52f2c4f9f64c1b", ClientRequestPath: "/podcasts/daily/日本語.mp3" };
  const object = logObject("2026-11-04/a b?#.gz", `${JSON.stringify(logRecord)}\r\n${JSON.stringify(other)}`);
  let requestUrl = "";
  const records: HttpLogpushRecord[] = [];
  const r2 = new HttpLogpushR2(logTarget, { accountId: logTarget.accountId, apiToken: "test-token",
    transport: async (input, init) => {
      requestUrl = String(input);
      expect(init).toMatchObject({ decompress: false, redirect: "error", cache: "no-store" });
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        for (let offset = 0; offset < object.body.length; offset += 3) controller.enqueue(object.body.slice(offset, offset + 3));
        controller.close();
      } });
      return new Response(body, { headers: { ETag: `"${object.file.etag}"`, "Content-Encoding": "gzip" } });
    } });
  await r2.readFile(object.file, async (record) => { records.push(record); });
  expect(requestUrl).toEndWith("/2026-11-04/a%20b%3F%23.gz");
  expect(records).toEqual([{ ...logRecord, EdgeStartTimestamp: Date.parse(logRecord.EdgeStartTimestamp) },
    { ...other, EdgeStartTimestamp: Date.parse(other.EdgeStartTimestamp) }]);
});

test("Bun fetch keeps stored gzip bytes intact even when R2 returns Content-Encoding gzip", async () => {
  const object = logObject("2026-11-04/a.gz", `${JSON.stringify(logRecord)}\n`);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(object.body, { headers: { ETag: `"${object.file.etag}"`, "Content-Encoding": "gzip" } });
  } });
  try {
    const r2 = new HttpLogpushR2(logTarget, { accountId: logTarget.accountId, apiToken: "test-token",
      transport: (_input, init) => fetch(server.url, init) });
    const records: HttpLogpushRecord[] = [];
    await r2.readFile(object.file, (record) => { records.push(record); });
    expect(records.map((record) => record.RayID)).toEqual([logRecord.RayID]);
  } finally { server.stop(true); }
});

test("R2 log file reads reject changed ETags, partial bodies, invalid gzip and changed sizes", async () => {
  const object = logObject("2026-11-04/a.gz", `${JSON.stringify(logRecord)}\n`);
  const cases: Array<{ body: Uint8Array<ArrayBuffer>; file: HttpLogpushFile; headers: HeadersInit }> = [
    { body: object.body, file: object.file, headers: { ETag: '"different"' } },
    { body: object.body, file: { ...object.file, size: object.file.size + 1 }, headers: { ETag: `"${object.file.etag}"` } },
    { body: object.body, file: { ...object.file, size: object.file.size - 1 }, headers: { ETag: `"${object.file.etag}"` } },
    { body: object.body.slice(0, -4), file: { ...object.file, size: object.body.length - 4 }, headers: { ETag: `"${object.file.etag}"` } },
    { body: object.body, file: object.file, headers: { ETag: `"${object.file.etag}"`, "Content-Range": "bytes 0-1/100" } },
  ];
  for (const entry of cases) {
    const r2 = new HttpLogpushR2(logTarget, { accountId: logTarget.accountId, apiToken: "test-token",
      transport: async () => new Response(entry.body, { headers: entry.headers }) });
    await expect(r2.readFile(entry.file, () => {})).rejects.toThrow("R2 log");
  }
});

test("log decoding rejects malformed UTF-8, JSON and unconfigured fields without echoing them", async () => {
  const badUtf8 = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0x22, 0x7d]);
  for (const [body, message] of [[badUtf8, "Invalid UTF-8 in HTTP Requests Logpush file"],
    ['{"secret-token":', "Invalid JSON in HTTP Requests Logpush file"],
    [JSON.stringify({ ...logRecord, ClientIP: "192.0.2.1" }), "Invalid HTTP Requests Logpush record"]] as const) {
    const object = logObject("2026-11-04/a.gz", body);
    const fixture = logR2Fixture([object]);
    const r2 = new HttpLogpushR2(logTarget, { accountId: logTarget.accountId, apiToken: "test-token", transport: fixture.transport });
    await expect(r2.readFile(object.file, () => {})).rejects.toThrow(message);
  }
});

test("R2 log reads preserve REST errors without recording arbitrary API messages or replaying requests", async () => {
  let calls = 0;
  const r2 = new HttpLogpushR2(logTarget, { accountId: logTarget.accountId, apiToken: "test-token",
    transport: async () => { calls++; return new Response("private API failure", { status: 403 }); } });
  await expect(r2.listFiles()).rejects.toThrow("R2 log GET was not verified (HTTP 403)");
  expect(calls).toBe(1);
  expect(() => new HttpLogpushR2(logTarget, { accountId: "c".repeat(32), apiToken: "test-token" })).toThrow("credentials");
});
