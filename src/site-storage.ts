import { sha256Hex, toHex } from "../packages/shared/src/sha256";
import { validateId } from "../packages/shared/src/ids";
import { siteSnapshotKey } from "../packages/shared/src/website";
import type { SitePage } from "../packages/shared/src/website";
import type { SqlitePublicationBucket } from "./sqlite-publication-executor";
import { SITE_HTML_LIMIT_BYTES, siteContentSecurityPolicy } from "./site-renderer";
import type { SiteCacheProps } from "./site-cache";
import { purgeCacheTarget } from "./sqlite-cache-purge";

export type SiteCandidatePage = { page: SitePage; props: SiteCacheProps };

export async function persistSitePage(bucket: Pick<SqlitePublicationBucket, "put">, page: SitePage,
  generation: number, html: string, identity: Omit<SiteCacheProps, "generation" | "sha256" | "lengthBytes">): Promise<SiteCandidatePage> {
  siteContentSecurityPolicy(identity.cssHash);
  const bytes = new TextEncoder().encode(html);
  if (!bytes.length || bytes.length > SITE_HTML_LIMIT_BYTES) throw new Error("Site HTML exceeds its rendering budget");
  const key = siteSnapshotKey(page, generation), sha256 = await sha256Hex(bytes);
  const object = await bucket.put(key, bytes, { onlyIf: new Headers({ "If-None-Match": "*" }), sha256,
    httpMetadata: { contentType: "text/html; charset=utf-8" } });
  if (!object || object.key !== key || object.size !== bytes.length || !object.checksums.sha256 || toHex(object.checksums.sha256) !== sha256) {
    throw new Error("Immutable site page write was not verified");
  }
  return { page, props: { ...identity, generation, sha256, lengthBytes: bytes.length } };
}

export type SitePurgeTarget = { showId: string; episodeId?: string };
export function sitePurgeTags(target: SitePurgeTarget): string[] {
  validateId(target.showId, "show");
  if (target.episodeId === undefined) return [`site-${target.showId}`];
  validateId(target.episodeId, "episode");
  return [`site-list-${target.showId}`, `site-episode-${target.showId}/${target.episodeId}`];
}

export async function purgeSitePages(cache: Pick<CacheContext, "purge">, target: SitePurgeTarget): Promise<void> {
  await purgeCacheTarget(cache, target, { tags: sitePurgeTags(target) });
}
