import { expect, spyOn, test } from "bun:test";
import { putVerifiedR2Object } from "./verified-r2-put";
import type { R2RestTransport } from "./verified-r2-put";
import { createHash } from "node:crypto";

for (const phase of ["put", "put_receipt", "source_completed", "readback", "readback_verify"] as const) {
  test(`R2 PUT failures identify ${phase} without logging keys, credentials, body or arbitrary exceptions`, async () => {
    const bytes = Uint8Array.of(1), records: string[] = [];
    const logging = spyOn(console, "error").mockImplementation((message) => { records.push(String(message)); });
    try {
      await expect(putVerifiedR2Object({ account_id: "private-account", bucket_name: "private-bucket" }, {
        key: "private-key", length: 1, sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "application/octet-stream" },
      new Blob([bytes]).stream(), () => { if (phase === "source_completed") throw new Error("private exception"); }, {
        accountId: "private-account", apiToken: "private-token", transport: async (_, init) => {
          if (init?.method === "GET") {
            if (phase === "readback") throw new Error("private exception");
            return new Response(bytes, { headers: { ETag: '"changed"' } });
          }
          if (phase === "put") return new Response(null, { status: 503 });
          return Response.json({ success: true, result: { key: "private-key", size: phase === "put_receipt" ? 2 : 1, etag: "verified", version: "version" } });
        },
      })).rejects.toThrow("no automatic retry");
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0])).toEqual({ event: "r2_verified_put_failed", phase, reason_code: "put_or_readback_unverified",
        ...(phase === "readback" ? {} : { http_status: phase === "put" ? 503 : 200 }) });
      expect(records[0]).not.toContain("private");
    } finally { logging.mockRestore(); }
  });
}

const config = { account_id: "a".repeat(32), bucket_name: "private-bucket" };

for (const [key, encoded] of [
  ["system/service.toml", "system/service.toml"],
  ["staging/show/episode/audio.mp3", "staging/show/episode/audio.mp3"],
  ["system/a b?#&+.toml", "system/a%20b%3F%23%26%2B.toml"],
  ["system/%2F%25.toml", "system/%252F%2525.toml"],
  ["system/日本語.toml", "system/%E6%97%A5%E6%9C%AC%E8%AA%9E.toml"],
]) {
  test(`verified R2 PUT and readback preserve the exact key: ${key}`, async () => {
    const bytes = new TextEncoder().encode("frozen payload");
    const calls: string[] = [];
    let consumed = false;
    const transport: R2RestTransport = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      expect(url.href).toBe(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets/private-bucket/objects/${encoded}`);
      expect(url.search).toBe(""); expect(url.hash).toBe("");
      expect(decodeURIComponent(url.pathname.split("/objects/")[1]!)).toBe(key);
      expect(init?.redirect).toBe("error");
      calls.push(request.method);
      if (request.method === "PUT") {
        expect(Buffer.from(await request.arrayBuffer())).toEqual(Buffer.from(bytes));
        return Response.json({ success: true, result: { key, size: bytes.length, etag: "object-etag", version: "object-version" } });
      }
      expect(consumed).toBe(true);
      return new Response(bytes, { headers: { ETag: '"object-etag"' } });
    };
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    await expect(putVerifiedR2Object(config, { key, length: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), contentType: "application/octet-stream" },
    body, () => { consumed = true; }, { accountId: config.account_id, apiToken: "private-token", transport })).resolves.toEqual({
      etag: "object-etag", version: "object-version",
    });
    expect(calls).toEqual(["PUT", "GET"]);
  });
}
