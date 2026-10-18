import { defaultRssAssetTransport, validateRssSourceUrl } from "../../packages/cli/src/rss-import-download";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer as httpServer, request as httpRequest } from "node:http";
import type { IncomingMessage, RequestOptions, ServerResponse } from "node:http";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";

type LookupObservation = {
  hostname: string; family: number | "IPv4" | "IPv6" | null; all: boolean | null; hints: number | null;
  callback: "scalar" | "array";
};
type Outcome = { ok: true } | { ok: false; code: string };
const tlsDirectory = process.argv[2];
if (!tlsDirectory || process.argv.length !== 3 || !process.env.NODE_EXTRA_CA_CERTS ||
  process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  throw new Error("Usage: NODE_EXTRA_CA_CERTS=.../cert.pem bun rss-lookup-probe.ts TLS_DIRECTORY (TLS verification required)");
}
const tls = { cert: readFileSync(join(tlsDirectory, "cert.pem")), key: readFileSync(join(tlsDirectory, "key.pem")) };
const rows: unknown[] = [];

function serve(request: IncomingMessage, response: ServerResponse) {
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.headers["x-castloop-key"], undefined);
  assert.equal(request.headers.cookie, undefined);
  response.writeHead(200, {
    "x-probe-host": request.headers.host!,
    "x-probe-address": request.socket.localAddress!,
    "x-probe-sni": (request.socket as TLSSocket).servername || "none",
  });
  response.end("asset");
}

function verifyResponse(url: URL, address: string, headers: IncomingMessage["headers"], body: string) {
  assert.equal(body, "asset");
  assert.equal(headers["x-probe-host"], url.host);
  assert.equal(headers["x-probe-address"], address);
  assert.equal(headers["x-probe-sni"], url.protocol === "https:" ? url.hostname : "none");
}

async function observe(url: URL, address: string, family: number | undefined,
  autoSelectFamily: true | undefined, arrayAware: boolean) {
  const lookups: LookupObservation[] = [];
  const outcome = await new Promise<Outcome>((resolve) => {
    // Mirror the production request options, varying only the documented control conditions.
    const options: RequestOptions = {
      method: "GET", agent: false, family,
      ...(autoSelectFamily ? { autoSelectFamily } : {}),
      lookup: (hostname, options, callback) => {
        const array = arrayAware && options.all === true;
        lookups.push({ hostname, family: options.family ?? null, all: options.all ?? null,
          hints: options.hints ?? null, callback: array ? "array" : "scalar" });
        if (array) callback(null, [{ address, family: address === "::1" ? 6 : 4 }]);
        else callback(null, address, address === "::1" ? 6 : 4);
      },
      headers: { Accept: "*/*", "Accept-Encoding": "identity", "User-Agent": "castloop-rss-import" },
      signal: AbortSignal.timeout(600000), timeout: 30000, maxHeaderSize: 16384,
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url.href, options, (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      response.on("error", () => { resolve({ ok: false, code: "response_error" }); });
      response.on("end", () => {
        assert.equal(response.statusCode, 200);
        verifyResponse(url, address, response.headers, Buffer.concat(chunks).toString());
        resolve({ ok: true });
      });
    });
    const deadline = setTimeout(() => { request.destroy(new Error("Probe deadline exceeded")); }, 5000);
    request.on("close", () => { clearTimeout(deadline); });
    request.on("timeout", () => { request.destroy(new Error("RSS source download timed out")); });
    request.on("error", (error: NodeJS.ErrnoException) => { resolve({ ok: false, code: error.code ?? "request_error" }); });
    request.end();
  });
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0]!.hostname, url.hostname);
  if (family === 4 || family === 6) {
    assert.equal(lookups[0]!.family, family);
    assert.notEqual(lookups[0]!.all, true);
    assert.equal(outcome.ok, true);
  } else if (arrayAware) {
    assert.equal(outcome.ok, true);
  } else if (lookups[0]!.all === true) {
    assert.deepEqual(outcome, { ok: false, code: "ERR_INVALID_IP_ADDRESS" });
  }
  rows.push({ protocol: url.protocol, address, path: "observed-mirror", family: family ?? "omitted",
    autoSelectFamily: autoSelectFamily ?? "default", arrayAware, lookups, outcome });
}

for (const protocol of ["http:", "https:"]) {
  for (const pinned of [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]) {
    const server = protocol === "https:" ? httpsServer(tls, serve) : httpServer(serve);
    // The hostname-mismatch case intentionally fails the handshake; assert its client-side rejection below.
    server.on("tlsClientError", () => {});
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, pinned.address, resolve);
    });
    try {
      const listener = server.address();
      assert.ok(listener && typeof listener !== "string");
      const url = new URL(`${protocol}//does-not-exist.invalid:${listener.port}/asset`);
      // Only call the low-level transport with loopback fixtures; never weaken the public URL gate.
      assert.throws(() => validateRssSourceUrl(url.href));
      await observe(url, pinned.address, pinned.family, undefined, false);
      await observe(url, pinned.address, pinned.family, true, false);
      for (const family of [undefined, 0]) {
        for (const arrayAware of [false, true]) await observe(url, pinned.address, family, true, arrayAware);
      }
      const response = await defaultRssAssetTransport.request(url, pinned);
      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of response.body) chunks.push(chunk);
        assert.equal(response.status, 200);
        verifyResponse(url, pinned.address, response.headers, Buffer.concat(chunks).toString());
        rows.push({ protocol, ...pinned, path: "production-transport", outcome: { ok: true } });
      } finally { response.close(); }
      if (protocol === "https:") {
        const wrongHostname = new URL(url);
        wrongHostname.hostname = "wrong-host.invalid";
        await assert.rejects(async () => {
          const unexpected = await defaultRssAssetTransport.request(wrongHostname, pinned);
          unexpected.close();
        }, /RSS source download failed/);
        rows.push({ protocol, ...pinned, path: "production-tls-hostname-mismatch", rejected: true });
      }
    } finally {
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    }
  }
}

console.log(JSON.stringify({ bun: Bun.version, revision: Bun.revision, platform: process.platform,
  arch: process.arch, rows }, null, 2));
