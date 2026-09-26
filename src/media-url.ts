import type { EpisodeRevision } from "../packages/shared/src/index";

export function canonicalEnclosureUrl(episode: EpisodeRevision, showId: string, baseUrl: string): string {
  const original = new URL(episode.enclosure_url);
  const prefix = `/podcasts/${showId}/episodes/${episode.episode_id}/`;
  const filename = original.pathname.slice(prefix.length);
  if (!original.pathname.startsWith(prefix) || !/^[a-f0-9-]{36}\.mp3$/.test(filename) ||
    original.search || original.hash || original.username || original.password ||
    (original.protocol !== "https:" && original.protocol !== "http:")) {
    throw new Error("Published Episode has an invalid audio reference");
  }
  return `${baseUrl.replace(/\/$/, "")}${original.pathname}`;
}
