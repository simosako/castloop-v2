import { validateId } from "../packages/shared/src/ids";
import type { PublicAsset } from "../packages/shared/src/public-assets";
export { parsePublicAssetPath } from "../packages/shared/src/public-assets";
export type { PublicAsset } from "../packages/shared/src/public-assets";

export type PublicCacheProps = { showGeneration: number; feedGeneration?: number; episodeGeneration?: number; coverGeneration?: number };

export function publicAssetCacheTags(asset: PublicAsset): string[] {
  validateId(asset.showId, "show");
  if (asset.kind === "audio") validateId(asset.episodeId, "episode");
  return [`show-${asset.showId}`, asset.kind === "audio" ? `episode-${asset.showId}/${asset.episodeId}`
    : `${asset.kind}-${asset.showId}`];
}
