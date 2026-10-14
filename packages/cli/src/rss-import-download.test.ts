import { describe, expect, test } from "bun:test";
import { defaultRssAssetTransport, isPublicRssAddress, receiveRssAsset, validateRssSourceUrl } from "./rss-import-download";
import type { RssAssetResponse, RssAssetTransport } from "./rss-import-download";
import { createServer } from "node:http";

function response(status = 200, chunks = [Buffer.from("asset")], headers: RssAssetResponse["headers"] = {}): RssAssetResponse {
  return { status, headers, body: (async function* () { yield* chunks; })(), close() {} };
}

describe("RSS source download boundaries", () => {
  test("the actual HTTP transport connects to the pinned address and sends no administrative headers", async () => {
    let host: string | undefined;
    const server = createServer((request, response) => {
      host = request.headers.host;
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["x-castloop-key"]).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      response.end("asset");
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing local test listener");
      const url = new URL(`http://does-not-exist.invalid:${address.port}/asset`);
      const response = await defaultRssAssetTransport.request(url, { address: "127.0.0.1", family: 4 });
      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of response.body) chunks.push(chunk);
        expect(Buffer.concat(chunks).toString()).toBe("asset");
        expect(host).toBe(url.host);
      } finally { response.close(); }
    } finally { await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); }); }
  });

  test("rejects local, reserved, mapped and malformed addresses and unsafe URL forms", () => {
    for (const address of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1",
      "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fe80::1",
      "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::", "not-an-ip"]) expect(isPublicRssAddress(address)).toBe(false);
    for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"]) expect(isPublicRssAddress(address)).toBe(true);
    for (const url of ["file:///etc/passwd", "http://localhost/feed", "http://127.1/feed", "http://[::1]/feed",
      "https://user:secret@public.example/feed", "https://public.example:8443/feed", "https://public.example/feed#fragment"]) {
      expect(() => validateRssSourceUrl(url)).toThrow();
    }
  });

  test("pins the checked DNS address, rechecks redirects and closes every response", async () => {
    const requests: Array<{ host: string; address: string }> = [];
    let closed = 0;
    const transport: RssAssetTransport = { async resolve() { return [{ address: "1.1.1.1", family: 4 }]; },
      async request(url, address) {
        requests.push({ host: url.hostname, address: address.address });
        return { ...response(requests.length === 1 ? 302 : 200, [Buffer.from("asset")],
          requests.length === 1 ? { location: "https://media.example/audio.mp3" } : { "content-length": "5" }), close() { closed++; } };
      } };
    const chunks: Uint8Array[] = [];
    expect(await receiveRssAsset("https://source.example/feed?private=token", 5, async (bytes) => { chunks.push(bytes); }, transport))
      .toEqual({ url: "https://media.example/audio.mp3", length: 5 });
    expect(requests).toEqual([{ host: "source.example", address: "1.1.1.1" }, { host: "media.example", address: "1.1.1.1" }]);
    expect(Buffer.concat(chunks).toString()).toBe("asset");
    expect(closed).toBe(2);
  });

  test("blocks mixed DNS and unsafe redirect destinations before making their request", async () => {
    let requests = 0;
    const request = async () => { requests++; return response(); };
    await expect(receiveRssAsset("https://public.example/feed", 10, async () => {}, {
      async resolve() { return [{ address: "1.1.1.1", family: 4 }, { address: "127.0.0.1", family: 4 }]; }, request,
    })).rejects.toThrow("nonpublic");
    expect(requests).toBe(0);
    for (const location of ["http://public.example/feed", "https://127.0.0.1/feed", "file:///etc/passwd"]) {
      await expect(receiveRssAsset("https://public.example/feed", 10, async () => {}, {
        async resolve() { return [{ address: "1.1.1.1", family: 4 }]; }, async request() { return response(302, [], { location }); },
      })).rejects.toThrow();
    }
  });

  test("rejects size overflow, truncation, compressed data, empty bodies and HTTP failures", async () => {
    for (const value of [response(200, [Buffer.from("123456")]), response(200, [Buffer.from("123")], { "content-length": "5" }),
      response(200, [], { "content-length": "999" }), response(200, [Buffer.from("123")], { "content-encoding": "gzip" }),
      response(200, []), response(403), response(206), response(200, [], { "content-length": "invalid" })]) {
      await expect(receiveRssAsset("https://public.example/feed?secret=token", 5, async () => {}, {
        async resolve() { return [{ address: "1.1.1.1", family: 4 }]; }, async request() { return value; },
      })).rejects.toThrow();
    }
  });
});
