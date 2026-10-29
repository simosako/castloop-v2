import type { SqliteCatalogResponse } from "../../shared/src/sqlite-catalog";
import { formatEpisodeTable, formatShowTable } from "./catalog-table";

export function formatSqliteCatalog(result: SqliteCatalogResponse): string {
  const lines = [`Service: ${result.service_id}`, "Server records only. Snapshot only; not an operation authorization or proof of delivery."];
  if (result.shows) {
    lines.push(...formatShowTable(result.shows));
  } else {
    lines.push(`Show: ${result.show!.show_id} (${result.show!.lifecycle}); unfinished operation: ${result.show!.unfinished_operation}`);
    lines.push(...formatEpisodeTable(result.episodes!));
  }
  if (result.next_cursor) lines.push(`More records: repeat with --cursor ${JSON.stringify(result.next_cursor)} and the same options.`);
  return lines.join("\n");
}
