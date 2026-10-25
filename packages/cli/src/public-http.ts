import { BoundedReadError, collectStreamBytes } from "./bounded-http-read";
import type { R2RestTransport } from "./verified-r2-put";
import { version } from "../../../package.json";

export type PublicHttpFailureCode = "transport_error" | "too_many_redirects" | "insecure_redirect" |
  "size_limit_exceeded" | "body_read_failed" | "invalid_response";

export class PublicHttpError extends Error {
  constructor(readonly code: PublicHttpFailureCode) { super(code); }
}

export type PublicHttpResponse = {
  requestUrl: string;
  finalUrl: string;
  redirects: string[];
  status: number;
  contentType: string | null;
  contentLength: number | null;
  etag: string | null;
  cacheControl: string | null;
  body?: Uint8Array;
};

export type PublicRequestOptions = { transport?: R2RestTransport; maximumBytes?: number; timeoutMs?: number };

export async function publicRequest(url: URL, method: "GET" | "HEAD",
  options: PublicRequestOptions = {}): Promise<PublicHttpResponse> {
  const redirects: string[] = [];
  let current = url;
  for (;;) {
    let response: Response;
    try {
      // A distinct User-Agent separates castloop's own verification traffic from listener statistics.
      response = await (options.transport ?? fetch)(current, { method, redirect: "manual", cache: "no-store",
        headers: { "User-Agent": `castloop-verify/${version}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? 30000) });
    } catch {
      throw new PublicHttpError("transport_error");
    }
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (!location) throw new PublicHttpError("invalid_response");
      if (redirects.length >= 3) throw new PublicHttpError("too_many_redirects");
      const next = new URL(location, current);
      if (next.protocol !== "https:") throw new PublicHttpError("insecure_redirect");
      redirects.push(next.toString());
      current = next;
      continue;
    }
    const headers = {
      contentType: response.headers.get("Content-Type"),
      contentLength: (() => { const value = response.headers.get("Content-Length"); return value === null || !/^\d+$/.test(value) ? null : Number(value); })(),
      etag: response.headers.get("ETag"),
      cacheControl: response.headers.get("Cache-Control"),
    };
    if (method === "GET" && options.maximumBytes !== undefined && response.status === 200 && response.body) {
      let bytes: Uint8Array;
      try { bytes = await collectStreamBytes(response.body, options.maximumBytes); }
      catch (error) {
        if (error instanceof BoundedReadError && error.code === "size_limit") throw new PublicHttpError("size_limit_exceeded");
        throw new PublicHttpError("body_read_failed");
      }
      return { requestUrl: url.toString(), finalUrl: current.toString(), redirects, status: response.status, ...headers, body: bytes };
    }
    await response.body?.cancel();
    return { requestUrl: url.toString(), finalUrl: current.toString(), redirects, status: response.status, ...headers };
  }
}
