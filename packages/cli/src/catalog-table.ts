type ShowRow = { show_id: string; lifecycle: string; unfinished_operation: boolean; title: string | null; feed_url: string | null };
type EpisodeRow = { episode_id: string; lifecycle: string; published_at: string | null; title: string | null };

function cell(value: string | null): string {
  return value === null ? "(unavailable)" : JSON.stringify(value).slice(1, -1);
}

export function formatShowTable(shows: readonly ShowRow[]): string[] {
  return ["SHOW_ID\tSTATE\tUNFINISHED\tTITLE\tFEED_URL", ...shows.map((show) =>
    [show.show_id, show.lifecycle, String(show.unfinished_operation), cell(show.title), cell(show.feed_url)].join("\t"))];
}

export function formatEpisodeTable(episodes: readonly EpisodeRow[]): string[] {
  return ["EPISODE_ID\tSTATE\tPUBLISHED_AT\tTITLE", ...episodes.map((episode) =>
    [episode.episode_id, episode.lifecycle, cell(episode.published_at), cell(episode.title)].join("\t"))];
}
