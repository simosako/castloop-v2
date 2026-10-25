import type { EpisodeRevision } from "./index";

export function comparePublishedEpisodes(left: EpisodeRevision, right: EpisodeRevision): number {
  return Date.parse(right.published_at) - Date.parse(left.published_at) || left.episode_id.localeCompare(right.episode_id);
}
