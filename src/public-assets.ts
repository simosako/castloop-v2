import { validateId } from "../packages/shared/src/ids";
import type { PublicVisibilitySnapshot } from "./lifecycle-control";

export type PublicAsset = { kind: "feed" | "cover"; showId: string; key: string; contentType: string } | {
  kind: "audio"; showId: string; episodeId: string; revisionId: string; key: string; contentType: "audio/mpeg";
};
export type PublicCacheProps = { showGeneration: number; feedGeneration?: number; episodeGeneration?: number };

const REVISION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function parsePublicAssetPath(pathname: string): PublicAsset | null {
  const audio = /^\/podcasts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-f0-9-]{36})\.mp3$/.exec(pathname);
  if (audio && audio[1].length <= 32 && audio[2].length <= 80 && REVISION_ID.test(audio[3])) {
    return { kind: "audio", showId: audio[1], episodeId: audio[2], revisionId: audio[3],
      key: `public${pathname}`, contentType: "audio/mpeg" };
  }
  const show = /^\/podcasts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(feed\.xml|cover\.(?:jpg|png))$/.exec(pathname);
  if (!show || show[1].length > 32) return null;
  const feed = show[2] === "feed.xml";
  return { kind: feed ? "feed" : "cover", showId: show[1], key: `public${pathname}`,
    contentType: feed ? "application/rss+xml; charset=utf-8" : show[2].endsWith("png") ? "image/png" : "image/jpeg" };
}

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
