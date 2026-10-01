import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import { renderFeed } from "./feed";
import type { LifecycleFeedEnv } from "./lifecycle-feed";

export type PublicationEffects = {
  checkDeliveryGate: (target: { showId: string; episodeId?: string }) => Promise<void>;
  purge: (target: { showId: string; episodeId?: string }) => Promise<void>;
};

export async function readPublicationBytes(env: LifecycleFeedEnv, key: string, maximum: number): Promise<Uint8Array> {
  const head = await env.CASTLOOP_BUCKET.head(key);
  if (!head || head.size < 1 || head.size > maximum) throw new Error("Publication snapshot is missing or oversized");
  const object = await env.CASTLOOP_BUCKET.get(key, { onlyIf: { etagMatches: head.etag } });
  if (!object || !("body" in object) || !object.body || object.etag !== head.etag || object.size !== head.size) {
    throw new Error("Publication snapshot changed before reading");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== head.size) throw new Error("Publication snapshot contents have a different size");
  return bytes;
}

export async function publicationChecksum(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function renderPublicationFeed(show: ShowMetadata, episodes: EpisodeRevision[], baseUrl: string, extension: "jpg" | "png"): string {
  const sourceBytes = new TextEncoder().encode(JSON.stringify({ show, episodes, baseUrl })).byteLength;
  if (sourceBytes * 6 + episodes.length * 1024 + 4096 > 32_000_000) throw new Error("Publication feed exceeds its conservative rendering budget");
  return renderFeed(show, episodes, baseUrl, extension);
}
