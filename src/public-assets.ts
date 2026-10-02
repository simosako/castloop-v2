import { validateId } from "../packages/shared/src/ids";
import type { PublicAsset } from "../packages/shared/src/public-assets";
import type { PublicVisibilitySnapshot } from "./lifecycle-control";
export { parsePublicAssetPath } from "../packages/shared/src/public-assets";
export type { PublicAsset } from "../packages/shared/src/public-assets";

export type PublicCacheProps = { showGeneration: number; feedGeneration?: number; episodeGeneration?: number };

function validGeneration(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

export function publicAssetCacheProps(asset: PublicAsset, snapshot: PublicVisibilitySnapshot): PublicCacheProps {
  if (snapshot.visibility !== "public") throw new Error("Non-public state cannot produce a public cache key");
  if (asset.showId !== snapshot.showId || !validGeneration(snapshot.showGeneration) || !validGeneration(snapshot.feedGeneration)) {
    throw new Error("Public asset does not match its Show visibility snapshot");
  }
  if (asset.kind === "audio") {
    if (asset.episodeId !== snapshot.episodeId || !validGeneration(snapshot.episodeGeneration)) {
      throw new Error("Audio asset does not match its Episode visibility snapshot");
    }
    return { showGeneration: snapshot.showGeneration, episodeGeneration: snapshot.episodeGeneration };
  }
  if (snapshot.episodeId !== undefined || snapshot.episodeGeneration !== undefined) {
    throw new Error("Show assets require a Show-only visibility snapshot");
  }
  return asset.kind === "feed" ? { showGeneration: snapshot.showGeneration, feedGeneration: snapshot.feedGeneration }
    : { showGeneration: snapshot.showGeneration };
}

export function publicAssetCacheTags(asset: PublicAsset): string[] {
  validateId(asset.showId, "show");
  if (asset.kind === "audio") validateId(asset.episodeId, "episode");
  return [`show-${asset.showId}`, asset.kind === "audio" ? `episode-${asset.showId}/${asset.episodeId}`
    : `${asset.kind}-${asset.showId}`];
}
