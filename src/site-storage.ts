import { validateId } from "../packages/shared/src/ids";
import { SITE_ID_PATTERN } from "../packages/shared/src/website";
import { purgeCacheTarget } from "./sqlite-cache-purge";

export type SitePurgeTarget = { showId: string; siteId?: string };
export function sitePurgeTags(target: SitePurgeTarget): string[] {
  validateId(target.showId, "show");
  if (target.siteId === undefined) return [`site-${target.showId}`];
  if (!SITE_ID_PATTERN.test(target.siteId)) throw new Error("Invalid Episode site ID");
  return [`site-list-${target.showId}`, `site-episode-${target.showId}/${target.siteId}`];
}

export async function purgeSitePages(cache: Pick<CacheContext, "purge">, target: SitePurgeTarget): Promise<void> {
  await purgeCacheTarget(cache, target, { tags: sitePurgeTags(target) });
}
