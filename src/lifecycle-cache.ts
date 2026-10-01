import { validateId } from "../packages/shared/src/index";
import { parsePublicAssetPath, publicAssetCacheTags } from "./public-assets";
import type { PublicAsset, PublicCacheProps } from "./public-assets";
import type { CachedPublicFetch } from "./lifecycle-gateway";

export type LifecycleCacheEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "head" | "get"> };
export type LifecyclePurgeTarget = { showId: string; episodeId?: string };
export type CachedAssetBinding = (options: { props: PublicCacheProps }) => { fetch: (request: Request) => Promise<Response> };

function rejected(request: Request, status: 404 | 405 | 412 | 416 | 503, size?: number): Response {
  return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: status === 404 ? "not found" :
    status === 503 ? "temporarily unavailable" : "request cannot be satisfied" }), {
    status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8",
      ...(status === 416 && size !== undefined ? { "Content-Range": `bytes */${size}` } : {}) },
  });
}

function validProps(asset: PublicAsset, props: PublicCacheProps): boolean {
  if (!props || typeof props !== "object") return false;
  const keys = asset.kind === "feed" ? ["showGeneration", "feedGeneration"] :
    asset.kind === "audio" ? ["showGeneration", "episodeGeneration"] : ["showGeneration"];
  const present = Object.keys(props);
  if (present.length !== keys.length || present.some((key) => !keys.includes(key))) return false;
  return keys.every((key) => {
    const value = props[key as keyof PublicCacheProps];
    return value !== undefined && Number.isSafeInteger(value) && value >= 0;
  });
}

function matchesEtag(value: string, etag: string, weak: boolean): boolean {
  if (value.trim() === "*") return true;
  return value.split(",").some((item) => weak ? item.trim().replace(/^W\//, "") === etag : item.trim() === etag);
}

function modifiedAfter(uploaded: Date, value: string): boolean | null {
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.floor(uploaded.getTime() / 1000) > Math.floor(date / 1000) : null;
}

function preconditionStatus(request: Request, object: R2Object): 304 | 412 | null {
  const match = request.headers.get("If-Match");
  if (match !== null && !matchesEtag(match, object.httpEtag, false)) return 412;
  const unmodified = request.headers.get("If-Unmodified-Since");
  if (match === null && unmodified !== null && modifiedAfter(object.uploaded, unmodified) === true) return 412;
  const none = request.headers.get("If-None-Match");
  if (none !== null) return matchesEtag(none, object.httpEtag, true) ? 304 : null;
  const since = request.headers.get("If-Modified-Since");
  return since !== null && modifiedAfter(object.uploaded, since) === false ? 304 : null;
}

function requestedRange(request: Request, object: R2Object): { offset: number; length: number } | "unsatisfiable" | null {
  if (request.method !== "GET") return null;
  const value = request.headers.get("Range");
  if (!value || value.length > 256) return null;
  const condition = request.headers.get("If-Range");
  if (condition !== null && condition !== object.httpEtag && modifiedAfter(object.uploaded, condition) !== false) return null;
  const range = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!range || (!range[1] && !range[2])) return null;
  const size = object.size;
  if (!size) return "unsatisfiable";
  if (!range[1]) {
    const suffix = Number(range[2]);
    if (suffix === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(offset) || offset >= size || end < offset) return "unsatisfiable";
  return { offset, length: end - offset + 1 };
}

export function createCachedPublicFetch(binding: CachedAssetBinding): CachedPublicFetch {
  return async (request, asset, props) => {
    const original = new URL(request.url);
    const parsed = parsePublicAssetPath(original.pathname);
    if (!parsed || parsed.key !== asset.key || !validProps(asset, props) || (request.method !== "GET" && request.method !== "HEAD")) {
      throw new Error("Invalid cached public transport input");
    }
    const url = new URL(original.pathname, "https://castloop-cache.invalid");
    const headers = new Headers();
    for (const name of ["Range", "If-Range", "If-Match", "If-Unmodified-Since", "If-None-Match", "If-Modified-Since"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return binding({ props }).fetch(new Request(url, { method: request.method, headers }));
  };
}

export async function serveCachedLifecycleAsset(request: Request, env: LifecycleCacheEnv, props: PublicCacheProps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return rejected(request, 405);
  const asset = parsePublicAssetPath(new URL(request.url).pathname);
  if (!asset) return rejected(request, 404);
  if (!validProps(asset, props)) return rejected(request, 503);
  try {
    const object = await env.CASTLOOP_BUCKET.head(asset.key);
    if (!object) return rejected(request, 404);
    if (!Number.isSafeInteger(object.size) || object.size < 0 || !Number.isFinite(object.uploaded.getTime())) {
      throw new Error("Invalid public object metadata");
    }
    const headers = new Headers({ "Content-Type": asset.contentType, "ETag": object.httpEtag,
      "Last-Modified": object.uploaded.toUTCString(), "Accept-Ranges": "bytes",
      "Cache-Control": asset.kind === "audio" ? "public, max-age=31536000" : "public, max-age=300",
      "Cache-Tag": publicAssetCacheTags(asset).join(","),
    });
    const condition = preconditionStatus(request, object);
    if (condition === 412) return rejected(request, 412);
    if (condition === 304) return new Response(null, { status: 304, headers });
    const range = requestedRange(request, object);
    if (range === "unsatisfiable") return rejected(request, 416, object.size);
    headers.set("Content-Length", String(range ? range.length : object.size));
    if (request.method === "HEAD") return new Response(null, { headers });
    const data = await env.CASTLOOP_BUCKET.get(asset.key, { onlyIf: { etagMatches: object.etag }, ...(range ? { range } : {}) });
    if (!data || !("body" in data) || !data.body || data.etag !== object.etag || data.size !== object.size) {
      throw new Error("Public object changed during delivery");
    }
    if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
    return new Response(data.body, { status: range ? 206 : 200, headers });
  } catch {
    console.error(JSON.stringify({ event: "lifecycle_cached_asset_failed", show_id: asset.showId,
      ...(asset.kind === "audio" ? { episode_id: asset.episodeId } : {}), reason_code: "public_delivery_failed" }));
    return rejected(request, 503);
  }
}

export async function purgeLifecycleCache(cache: Pick<CacheContext, "purge"> | undefined, input: LifecyclePurgeTarget): Promise<void> {
  const showId = validateId(input.showId, "show");
  const episodeId = input.episodeId !== undefined ? validateId(input.episodeId, "episode") : undefined;
  if (!cache) throw new Error("Cached entrypoint purge is unavailable");
  const tags = episodeId ? [`feed-${showId}`, `episode-${showId}/${episodeId}`] : [`show-${showId}`, `feed-${showId}`, `cover-${showId}`];
  const tagged = await cache.purge({ tags });
  if (!tagged.success) throw new Error("Lifecycle cache tag purge failed");
  const prefix = episodeId ? `/podcasts/${showId}/episodes/${episodeId}/` : `/podcasts/${showId}/`;
  const prefixed = await cache.purge({ pathPrefixes: [prefix] });
  if (!prefixed.success) throw new Error("Lifecycle cache prefix purge failed");
}
