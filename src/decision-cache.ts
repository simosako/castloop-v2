import { validateId } from "../packages/shared/src/ids";
import { parseSitePagePath, sitePagePath, SITE_ID_PATTERN } from "../packages/shared/src/website";
import type { SitePage } from "../packages/shared/src/website";
import { parsePublicAssetPath, publicAssetCacheTags } from "./public-assets";
import type { PublicCacheProps } from "./public-assets";
import type { SqliteDeliveryDecision } from "./sqlite-publication-content";
import type { SiteDeliveryDecision } from "./site-gateway";
import type { SiteCacheProps } from "./site-cache";
import { purgeCacheTarget } from "./sqlite-cache-purge";

// Delivery decisions are cached on a dedicated entrypoint so cache hits stop before
// reaching the Show DO. Correctness comes from the same purge-before-commit order as
// the body caches; the TTL below only bounds propagation when a purge is lost.
export const DELIVERY_DECISION_MAX_AGE_SECONDS = 300;
const DECISION_ORIGIN = "https://castloop-decisions.invalid";

export type DecisionPurgeTarget = { showId: string; episodeId?: string; siteId?: string };
export type DeliveryDecisionSource = {
  delivery: (path: string) => Promise<SqliteDeliveryDecision>;
  siteDelivery: (page: SitePage) => Promise<SiteDeliveryDecision>;
};
type DecisionCacheStatus = 200 | 404 | 410 | 503;

function siteDecisionCacheTags(page: SitePage): string[] {
  return [`site-${page.showId}`,
    page.kind === "episode" ? `site-episode-${page.showId}/${page.siteId}` : `site-list-${page.showId}`];
}

function decisionResponse(status: DecisionCacheStatus, body: unknown, tags: string[]): Response {
  return Response.json(body, { status, headers: {
    "Cache-Control": status === 200 ? `public, max-age=${DELIVERY_DECISION_MAX_AGE_SECONDS}` : "no-store",
    ...(status === 200 ? { "Cache-Tag": tags.join(",") } : {}) } });
}

export async function serveCachedDeliveryDecision(request: Request, source: DeliveryDecisionSource): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { "Cache-Control": "no-store" } });
  const pathname = new URL(request.url).pathname;
  const asset = parsePublicAssetPath(pathname);
  const page = asset ? null : parseSitePagePath(pathname);
  if (!asset && !page) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  const decision = asset ? await source.delivery(pathname) : await source.siteDelivery(page!);
  if (decision.status === 200) {
    return decisionResponse(200, decision, asset ? publicAssetCacheTags(asset) : siteDecisionCacheTags(page!));
  }
  return decisionResponse(decision.status, { status: decision.status }, []);
}

function decisionStatus(response: Response): DecisionCacheStatus {
  if (response.status === 200 || response.status === 404 || response.status === 410 || response.status === 503) {
    return response.status;
  }
  throw new Error("Cached delivery decision status differs");
}

async function decisionJson(response: Response): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await response.json(); }
  catch { throw new Error("Cached delivery decision body differs"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cached delivery decision body differs");
  return value as Record<string, unknown>;
}

export async function readCachedDeliveryDecision(response: Response): Promise<SqliteDeliveryDecision> {
  const status = decisionStatus(response);
  if (status !== 200) return { status };
  const value = await decisionJson(response);
  if (value.status !== 200 || typeof value.key !== "string" || !value.key ||
    typeof value.content_type !== "string" || !value.content_type ||
    !value.cache_props || typeof value.cache_props !== "object" || Array.isArray(value.cache_props)) {
    throw new Error("Cached delivery decision body differs");
  }
  return { status: 200, key: value.key, content_type: value.content_type, cache_props: value.cache_props as PublicCacheProps };
}

export async function readCachedSiteDeliveryDecision(response: Response): Promise<SiteDeliveryDecision> {
  const status = decisionStatus(response);
  if (status !== 200) return { status };
  const value = await decisionJson(response);
  const props = value.props as Record<string, unknown> | undefined;
  if (value.status !== 200 || !props || typeof props !== "object" || Array.isArray(props) ||
    !Number.isSafeInteger(props.generation) || !Number.isSafeInteger(props.showGeneration) ||
    props.episodeGeneration !== undefined && !Number.isSafeInteger(props.episodeGeneration)) {
    throw new Error("Cached site delivery decision body differs");
  }
  return { status: 200, props: props as SiteCacheProps };
}

export type CachedDecisionFetcher = { fetch: (request: Request) => Promise<Response> };

export function cachedDeliveryDecisions(fetcher: CachedDecisionFetcher): {
  asset: (path: string) => Promise<SqliteDeliveryDecision>;
  site: (page: SitePage) => Promise<SiteDeliveryDecision>;
} {
  return {
    asset: (path) => fetcher.fetch(new Request(`${DECISION_ORIGIN}${path}`)).then(readCachedDeliveryDecision),
    site: (page) => fetcher.fetch(new Request(`${DECISION_ORIGIN}${sitePagePath(page)}`)).then(readCachedSiteDeliveryDecision),
  };
}

export async function purgeDeliveryDecisions(cache: Pick<CacheContext, "purge"> | undefined,
  target: DecisionPurgeTarget): Promise<void> {
  const showId = validateId(target.showId, "show");
  if (target.episodeId !== undefined) {
    const episodeId = validateId(target.episodeId, "episode");
    return purgeCacheTarget(cache, target, { tags: [`feed-${showId}`, `episode-${showId}/${episodeId}`],
      pathPrefixes: [`/podcasts/${showId}/episodes/${episodeId}/`] });
  }
  if (target.siteId !== undefined) {
    if (!SITE_ID_PATTERN.test(target.siteId)) throw new Error("Invalid Episode site ID");
    return purgeCacheTarget(cache, target, { tags: [`site-list-${showId}`, `site-episode-${showId}/${target.siteId}`] });
  }
  return purgeCacheTarget(cache, target, { tags: [`show-${showId}`, `feed-${showId}`, `cover-${showId}`, `site-${showId}`],
    pathPrefixes: [`/podcasts/${showId}/`] });
}
