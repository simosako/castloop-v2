import { sha256Hex } from "../packages/shared/src/sha256";
import { parseSitePagePath } from "../packages/shared/src/website";
import type { SitePage } from "../packages/shared/src/website";
import { SITE_HTML_LIMIT_BYTES, siteContentSecurityPolicy, siteCssHash } from "./site-renderer";

export type SiteCacheProps = { generation: number; showGeneration: number; episodeGeneration?: number };
export type SitePageRenderResult = { html: string; css?: string };
export type SitePageRenderer = (page: SitePage, props: SiteCacheProps) =>
  Promise<SitePageRenderResult | null> | SitePageRenderResult | null;

export async function serveCachedSitePage(request: Request, render: SitePageRenderer,
  props: SiteCacheProps): Promise<Response> {
  const reject = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
  if (request.method !== "GET" && request.method !== "HEAD") return reject(405);
  const page = parseSitePagePath(new URL(request.url).pathname);
  if (!page) return reject(404);
  try {
    const fields = ["generation", "showGeneration", ...(page.kind === "episode" ? ["episodeGeneration"] : [])];
    if (!props || typeof props !== "object" || Object.keys(props).length !== fields.length ||
      Object.keys(props).some((key) => !fields.includes(key)) ||
      !Number.isSafeInteger(props.generation) || props.generation < 1 ||
      !Number.isSafeInteger(props.showGeneration) || props.showGeneration < 0 ||
      page.kind === "episode" && (!Number.isSafeInteger(props.episodeGeneration) || props.episodeGeneration! < 0)) {
      throw new Error("Invalid site cache properties");
    }
    const rendered = await render(page, props);
    if (!rendered) return reject(503);
    const bytes = new TextEncoder().encode(rendered.html);
    if (!bytes.byteLength || bytes.byteLength > SITE_HTML_LIMIT_BYTES) return reject(503);
    const csp = siteContentSecurityPolicy(await siteCssHash(rendered.css ?? ""));
    const etag = `"${await sha256Hex(bytes)}"`;
    const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ETag: etag,
      "Cache-Control": "public, max-age=300",
      "Cache-Tag": `site-${page.showId},${page.kind === "episode" ? `site-episode-${page.showId}/${page.siteId}` : `site-list-${page.showId}`}` });
    const matches = (value: string, weak: boolean) => value.trim() === "*" || value.split(",").some((item) =>
      (weak ? item.trim().replace(/^W\//, "") : item.trim()) === etag);
    const match = request.headers.get("If-Match");
    if (match !== null && !matches(match, false)) return reject(412);
    const none = request.headers.get("If-None-Match");
    if (none !== null && matches(none, true)) return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(bytes.byteLength));
    if (request.method === "HEAD") return new Response(null, { headers });
    return new Response(bytes, { headers });
  } catch {
    console.error(JSON.stringify({ event: "site_cached_page", show_id: page.showId, reason_code: "public_delivery_failed" }));
    return reject(503);
  }
}
