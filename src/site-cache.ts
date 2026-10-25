import { toHex } from "../packages/shared/src/sha256";
import { parseSitePagePath, siteSnapshotKey } from "../packages/shared/src/website";
import { SITE_HTML_LIMIT_BYTES, siteContentSecurityPolicy } from "./site-renderer";

export type SiteCacheProps = { generation: number; showGeneration: number; episodeGeneration?: number;
  cssHash: string; sha256: string; lengthBytes: number };

export async function serveCachedSitePage(request: Request, bucket: Pick<R2Bucket, "head" | "get">,
  props: SiteCacheProps): Promise<Response> {
  const reject = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
  if (request.method !== "GET" && request.method !== "HEAD") return reject(405);
  const page = parseSitePagePath(new URL(request.url).pathname);
  if (!page) return reject(404);
  try {
    const fields = ["generation", "showGeneration", "cssHash", "sha256", "lengthBytes", ...(page.kind === "episode" ? ["episodeGeneration"] : [])];
    if (Object.keys(props).length !== fields.length || Object.keys(props).some((key) => !fields.includes(key)) ||
      !Number.isSafeInteger(props.showGeneration) || props.showGeneration < 0 ||
      page.kind === "episode" && (!Number.isSafeInteger(props.episodeGeneration) || props.episodeGeneration! < 0) ||
      !/^[a-f0-9]{64}$/.test(props.sha256) || !Number.isSafeInteger(props.lengthBytes) ||
      props.lengthBytes < 1 || props.lengthBytes > SITE_HTML_LIMIT_BYTES) throw new Error("Invalid site cache properties");
    const csp = siteContentSecurityPolicy(props.cssHash), key = siteSnapshotKey(page, props.generation);
    const object = await bucket.head(key);
    if (!object || object.key !== key || object.size !== props.lengthBytes || !object.checksums.sha256 ||
      toHex(object.checksums.sha256) !== props.sha256) return reject(503);
    const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ETag: object.httpEtag,
      "Last-Modified": object.uploaded.toUTCString(), "Cache-Control": "public, max-age=300",
      "Cache-Tag": `site-${page.showId},${page.kind === "episode" ? `site-episode-${page.showId}/${page.episodeId}` : `site-list-${page.showId}`}` });
    const matches = (value: string, weak: boolean) => value.trim() === "*" || value.split(",").some((item) =>
      (weak ? item.trim().replace(/^W\//, "") : item.trim()) === object.httpEtag);
    const modified = (value: string) => {
      const time = Date.parse(value);
      return Number.isFinite(time) ? Math.floor(object.uploaded.getTime() / 1000) > Math.floor(time / 1000) : null;
    };
    const match = request.headers.get("If-Match"), unmodified = request.headers.get("If-Unmodified-Since");
    if (match !== null ? !matches(match, false) : unmodified !== null && modified(unmodified) === true) return reject(412);
    const none = request.headers.get("If-None-Match"), since = request.headers.get("If-Modified-Since");
    if (none !== null ? matches(none, true) : since !== null && modified(since) === false) return new Response(null, { status: 304, headers });
    headers.set("Content-Length", String(object.size));
    if (request.method === "HEAD") return new Response(null, { headers });
    const data = await bucket.get(key, { onlyIf: { etagMatches: object.etag } });
    if (!data || !("body" in data) || !data.body || data.key !== key || data.etag !== object.etag || data.size !== object.size) {
      if (data && "body" in data) await data.body?.cancel();
      return reject(503);
    }
    return new Response(data.body, { headers });
  } catch {
    console.error(JSON.stringify({ event: "site_cached_page", show_id: page.showId, reason_code: "public_delivery_failed" }));
    return reject(503);
  }
}
