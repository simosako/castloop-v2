import { parsePublicAssetPath } from "../packages/shared/src/public-assets";
import { isSqliteStatsBotUserAgent } from "../packages/shared/src/sqlite-stats";
import type { SqliteDeliveryObservation } from "../packages/shared/src/sqlite-stats";
import type { SqliteDeliveryDecision } from "./sqlite-publication-content";
import type { PublicCacheProps } from "./public-assets";

export type SqliteGatewayService = { fetch: (request: Request) => Promise<Response>; delivery: (path: string) => Promise<SqliteDeliveryDecision> };
export type SqliteDeliveryObservationSink = (observation: SqliteDeliveryObservation) => void;

function responseLength(response: Response): number {
  const declared = response.headers.get("Content-Length");
  return declared !== null && /^\d+$/.test(declared) && Number.isSafeInteger(Number(declared)) ? Number(declared) : 0;
}
function rangeOffset(response: Response): number | null {
  const range = response.headers.get("Content-Range");
  const match = range !== null ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range) : null;
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
}

export async function serveSqliteGateway(request: Request, managementOrigin: string, service: SqliteGatewayService,
  cachedFetch: (request: Request, props: PublicCacheProps) => Promise<Response>, publicOrigin = managementOrigin,
  observeDelivery?: SqliteDeliveryObservationSink): Promise<Response> {
  const url = new URL(request.url);
  try {
    const canonical = new URL(publicOrigin);
    if (canonical.protocol !== "https:" || canonical.port || canonical.origin !== publicOrigin) throw new Error("Public origin differs");
    if (url.origin !== managementOrigin && url.origin !== publicOrigin) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
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
    if (url.origin !== publicOrigin) {
      return new Response(null, { status: asset.kind === "feed" ? 301 : 307,
        headers: { Location: `${publicOrigin}${url.pathname}`, "Cache-Control": "no-store" } });
    }
    const headers = new Headers();
    for (const name of ["Range", "If-Range", "If-Match", "If-Unmodified-Since", "If-None-Match", "If-Modified-Since"]) {
      const value = request.headers.get(name); if (value !== null) headers.set(name, value);
    }
    const response = await cachedFetch(new Request(new URL(url.pathname, "https://castloop-cache.invalid"),
      { method: request.method, headers }), decision.cache_props);
    if (observeDelivery && asset.kind === "audio" && (response.status === 200 || response.status === 206 || response.status === 304)) {
      const offset = rangeOffset(response);
      // A 206 without a usable Content-Range header cannot be classified; skip it instead of guessing.
      if (response.status !== 206 || offset !== null) {
        // Observation hand-off must never turn into a delivery failure, even if the sink throws.
        try {
          observeDelivery({ episode_id: asset.episodeId, audio_revision_id: asset.revisionId,
            method: request.method === "HEAD" ? "HEAD" : "GET", status: response.status as 200 | 206 | 304,
            content_length: responseLength(response), range_offset: offset, bot: isSqliteStatsBotUserAgent(request.headers.get("User-Agent")) });
        } catch {
          console.error(JSON.stringify({ event: "sqlite_delivery_stats", reason_code: "stats_handoff_failed" }));
        }
      }
    }
    const outgoing = new Headers(response.headers);
    for (const name of ["Cache-Tag", "CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"]) outgoing.delete(name);
    outgoing.set("Cache-Control", response.status < 400 ? "public, max-age=0, must-revalidate" : "no-store");
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: outgoing });
  } catch {
    console.error(JSON.stringify({ event: "sqlite_gateway", reason_code: "request_unavailable" }));
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
