import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

type Address = { address: string; family: number };
export type RssAssetResponse = { status: number; headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>; close: () => void };
export type RssAssetTransport = { resolve: (hostname: string) => Promise<Address[]>;
  request: (url: URL, address: Address) => Promise<RssAssetResponse> };

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
  blocked.addSubnet(address, prefix, "ipv4");
}
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
const globalIpv6 = new BlockList();
globalIpv6.addSubnet("2000::", 3, "ipv6");

export function isPublicRssAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 &&
    globalIpv6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function validateRssSourceUrl(source: string): URL {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("Invalid RSS source URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash ||
    url.port || /(^|\.)localhost\.?$/i.test(url.hostname)) {
    throw new Error("RSS source requires an HTTP(S) URL without credentials, fragments or a custom port");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !isPublicRssAddress(hostname)) throw new Error("RSS source cannot access a nonpublic address");
  return url;
}

export const defaultRssAssetTransport: RssAssetTransport = {
  async resolve(hostname) { return isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : lookup(hostname, { all: true }); },
  async request(url, address) {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url.href, {
        method: "GET", agent: false, family: address.family,
        lookup: (_hostname, _options, callback) => { callback(null, address.address, address.family); },
        headers: { Accept: "*/*", "Accept-Encoding": "identity", "User-Agent": "castloop-rss-import" },
        signal: AbortSignal.timeout(600000), timeout: 30000, maxHeaderSize: 16384,
      }, (response) => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response,
          close: () => { response.destroy(); request.destroy(); } });
      });
      request.on("timeout", () => { request.destroy(new Error("RSS source download timed out")); });
      request.on("error", () => { reject(new Error("RSS source download failed")); });
      request.end();
    });
  },
};

export async function receiveRssAsset(source: string, maximumBytes: number,
  write: (bytes: Uint8Array) => Promise<void>, transport: RssAssetTransport = defaultRssAssetTransport): Promise<{ url: string; length: number }> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error("Invalid RSS download limit");
  let url = validateRssSourceUrl(source);
  for (let redirects = 0; redirects <= 5; redirects++) {
    let addresses: Address[];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      addresses = await Promise.race([transport.resolve(url.hostname.replace(/^\[|\]$/g, "")),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), 10000); })]);
    } catch { throw new Error("RSS source DNS lookup failed or timed out"); }
    finally { clearTimeout(timer); }
    if (!addresses.length || addresses.some((address) => !isPublicRssAddress(address.address) || isIP(address.address) !== address.family)) {
      throw new Error("RSS source DNS resolved to a nonpublic or invalid address");
    }
    const response = await transport.request(url, addresses[0]!);
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (redirects === 5 || typeof location !== "string") throw new Error("RSS source redirect limit or missing location");
        let target: URL;
        try { target = validateRssSourceUrl(new URL(location, url).href); }
        catch { throw new Error("RSS source redirected to an invalid destination"); }
        if (url.protocol === "https:" && target.protocol !== "https:") throw new Error("RSS source HTTPS downgrade is not allowed");
        url = target;
        continue;
      }
      if (response.status !== 200) throw new Error(`RSS source returned HTTP ${response.status}`);
      const encoding = response.headers["content-encoding"];
      if (encoding && encoding !== "identity") throw new Error("Compressed RSS source responses are not supported");
      const declared = response.headers["content-length"];
      if (declared !== undefined && (typeof declared !== "string" || !/^\d+$/.test(declared) ||
        !Number.isSafeInteger(Number(declared)) || Number(declared) > maximumBytes)) throw new Error("RSS source size exceeds its limit or is invalid");
      let length = 0;
      try {
        for await (const chunk of response.body) {
          length += chunk.byteLength;
          if (length > maximumBytes) throw new Error("RSS source size exceeds its limit");
          await write(chunk);
        }
      } catch { throw new Error("RSS source download failed, was interrupted or exceeded its size limit"); }
      if (!length || declared !== undefined && Number(declared) !== length) throw new Error("RSS source download is empty or incomplete");
      return { url: url.href, length };
    } finally { response.close(); }
  }
  throw new Error("RSS source redirect limit exceeded");
}
