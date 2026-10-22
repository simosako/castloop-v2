import { sha256Hex } from "../packages/shared/src/index";
import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import { assertPublicationInventoryBudget, assertPublicationRenderBudget, publicationCharacterLength } from "../packages/shared/src/publication-budget";
import { renderFeed } from "./feed";

export async function publicationChecksum(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

export function renderPublicationFeed(show: ShowMetadata, episodes: EpisodeRevision[], baseUrl: string, extension: "jpg" | "png"): string {
  assertPublicationInventoryBudget(episodes.length,
    episodes.reduce((length, episode) => length + publicationCharacterLength(JSON.stringify(episode)), 0));
  const sourceBytes = new TextEncoder().encode(JSON.stringify({ show, episodes, baseUrl })).byteLength;
  assertPublicationRenderBudget(sourceBytes, episodes.length);
  return renderFeed(show, episodes, baseUrl, extension);
}
