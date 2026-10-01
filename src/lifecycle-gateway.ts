import { readPublicVisibilitySnapshot } from "./lifecycle-control";
import type { LifecycleReadEnv } from "./lifecycle-control";
import { parsePublicAssetPath, publicAssetCacheProps } from "./public-assets";
import type { PublicAsset, PublicCacheProps } from "./public-assets";

export type CachedPublicFetch = (request: Request, asset: PublicAsset, props: PublicCacheProps) => Promise<Response>;

function rejected(request: Request, status: 404 | 410 | 503): Response {
  const error = status === 410 ? "gone" : status === 503 ? "temporarily unavailable" : "not found";
  return new Response(request.method === "HEAD" ? null : JSON.stringify({ error }), {
    status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function serveLifecyclePublicRequest(request: Request, env: LifecycleReadEnv,
  cachedFetch: CachedPublicFetch): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const asset = parsePublicAssetPath(new URL(request.url).pathname);
  if (!asset) return null;
  try {
    const snapshot = await readPublicVisibilitySnapshot(env, asset.showId, asset.kind === "audio" ? asset.episodeId : undefined);
    if (snapshot.visibility !== "public") return rejected(request, snapshot.visibility === "gone" ? 410 : 404);
    const response = await cachedFetch(request, asset, publicAssetCacheProps(asset, snapshot));
    const headers = new Headers(response.headers);
    headers.delete("Cloudflare-CDN-Cache-Control");
    headers.delete("CDN-Cache-Control");
    headers.delete("Cache-Tag");
    headers.set("Cache-Control", response.status < 400 ? "public, max-age=0, must-revalidate" : "no-store");
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status, statusText: response.statusText, headers,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "lifecycle_public_request_failed", show_id: asset.showId,
      ...(asset.kind === "audio" ? { episode_id: asset.episodeId } : {}),
      reason: error instanceof Error ? error.message : "Public delivery failed" }));
    return rejected(request, 503);
  }
}
