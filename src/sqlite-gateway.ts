import { parsePublicAssetPath } from "../packages/shared/src/public-assets";
import type { SqliteDeliveryDecision } from "./sqlite-publication-content";
import type { PublicCacheProps } from "./public-assets";

export type SqliteGatewayService = { fetch: (request: Request) => Promise<Response>; delivery: (path: string) => Promise<SqliteDeliveryDecision> };
export async function serveSqliteGateway(request: Request, managementOrigin: string, service: SqliteGatewayService,
  cachedFetch: (request: Request, props: PublicCacheProps) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname.startsWith("/admin/")) {
      if (url.origin !== managementOrigin) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
      return await service.fetch(request);
    }
    const asset = parsePublicAssetPath(url.pathname);
    if (!asset) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { "Cache-Control": "no-store" } });
    const decision = await service.delivery(url.pathname);
    if (decision.status !== 200) return new Response(null, { status: decision.status, headers: { "Cache-Control": "no-store" } });
    if (decision.key !== asset.key) throw new Error("Public delivery target differs");
    const headers = new Headers();
    for (const name of ["Range", "If-Range", "If-Match", "If-Unmodified-Since", "If-None-Match", "If-Modified-Since"]) {
      const value = request.headers.get(name); if (value !== null) headers.set(name, value);
    }
    const response = await cachedFetch(new Request(new URL(url.pathname, "https://castloop-cache.invalid"),
      { method: request.method, headers }), decision.cache_props);
    const outgoing = new Headers(response.headers);
    for (const name of ["Cache-Tag", "CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"]) outgoing.delete(name);
    outgoing.set("Cache-Control", response.status < 400 ? "public, max-age=0, must-revalidate" : "no-store");
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: outgoing });
  } catch {
    console.error(JSON.stringify({ event: "sqlite_gateway", reason_code: "request_unavailable" }));
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
