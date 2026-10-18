import { sha256Hex } from "../packages/shared/src/index";
import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import { renderFeed } from "./feed";

export async function publicationChecksum(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes);
}

export function renderPublicationFeed(show: ShowMetadata, episodes: EpisodeRevision[], baseUrl: string, extension: "jpg" | "png"): string {
  const sourceBytes = new TextEncoder().encode(JSON.stringify({ show, episodes, baseUrl })).byteLength;
  if (sourceBytes * 6 + episodes.length * 1024 + 4096 > 32_000_000) throw new Error("Publication feed exceeds its conservative rendering budget");
  return renderFeed(show, episodes, baseUrl, extension);
}
