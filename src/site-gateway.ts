import { parseSitePagePath, sitePageUrl, siteSnapshotKey } from "../packages/shared/src/website";
import type { SitePage } from "../packages/shared/src/website";
import type { SiteCacheProps } from "./site-cache";

export type SiteDeliveryDecision = { status: 200; props: SiteCacheProps } | { status: 404 | 410 | 503 };
export type SiteGateway = {
  managementOrigin: string;
  publicOrigin: string;
  delivery: (page: SitePage) => Promise<SiteDeliveryDecision>;
  cachedFetch: (request: Request, props: SiteCacheProps) => Promise<Response>;
};

export async function serveSiteGateway(request: Request, gateway: SiteGateway): Promise<Response> {
  const url = new URL(request.url), page = parseSitePagePath(url.pathname);
  const reject = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
  if (!page || ![gateway.managementOrigin, gateway.publicOrigin].includes(url.origin)) return reject(404);
  if (request.method !== "GET" && request.method !== "HEAD") return reject(405);
  try {
    const canonical = sitePageUrl(gateway.publicOrigin, page);
    const decision = await gateway.delivery(page);
    if (decision.status !== 200) return reject(decision.status);
    siteSnapshotKey(page, decision.props.generation);
    if (url.origin !== gateway.publicOrigin) return new Response(null, { status: 307,
      headers: { Location: canonical, "Cache-Control": "no-store" } });
    const headers = new Headers();
    for (const name of ["If-None-Match", "If-Modified-Since", "If-Match", "If-Unmodified-Since"]) {
      const value = request.headers.get(name); if (value !== null) headers.set(name, value);
    }
    const response = await gateway.cachedFetch(new Request(`https://castloop-site-cache.invalid${url.pathname}`,
      { method: request.method, headers }), decision.props);
    const outgoing = new Headers(response.headers);
    for (const name of ["Cache-Tag", "CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"]) outgoing.delete(name);
    outgoing.set("Cache-Control", response.status < 400 ? "public, max-age=0, must-revalidate" : "no-store");
    if (response.status >= 400) outgoing.set("X-Robots-Tag", "noindex");
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: outgoing });
  } catch {
    console.error(JSON.stringify({ event: "site_gateway", reason_code: "request_unavailable" }));
    return reject(503);
  }
}
