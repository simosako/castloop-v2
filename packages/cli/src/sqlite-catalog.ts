import type { SqliteCatalogResponse } from "../../shared/src/sqlite-catalog";

export function formatSqliteCatalog(result: SqliteCatalogResponse): string {
  const cell = (value: string | null) => value === null ? "(unavailable)" : JSON.stringify(value).slice(1, -1);
  const lines = [`Service: ${result.service_id} (${result.state})`, "Server records only. Snapshot only; not an operation authorization or proof of delivery."];
  if (result.shows) {
    lines.push("SHOW_ID\tSTATE\tUNFINISHED\tTITLE\tFEED_URL");
    for (const show of result.shows) lines.push([show.show_id, show.lifecycle, String(show.unfinished_operation), cell(show.title), cell(show.feed_url)].join("\t"));
  } else {
    lines.push(`Show: ${result.show!.show_id} (${result.show!.lifecycle}); unfinished operation: ${result.show!.unfinished_operation}`);
    lines.push("EPISODE_ID\tSTATE\tPUBLISHED_AT\tTITLE");
    for (const episode of result.episodes!) lines.push([episode.episode_id, episode.lifecycle, cell(episode.published_at), cell(episode.title)].join("\t"));
  }
  if (result.next_cursor) lines.push(`More records: repeat with --cursor ${JSON.stringify(result.next_cursor)} and the same options.`);
  return lines.join("\n");
}
