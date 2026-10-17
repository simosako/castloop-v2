import { contentListRequestSchema, contentListResponseSchema } from "@castloop/shared";
import type { ContentListRequest, ContentListResponse, ServiceConfig } from "@castloop/shared";
import { M6AdminJsonClient } from "./m6-admin-json";
import type { M6AdminTransport } from "./m6-admin-json";
import { formatEpisodeTable, formatShowTable } from "./catalog-table";

export class ContentListClient {
  private readonly http: M6AdminJsonClient;

  constructor(config: ServiceConfig, adminKey: string, transport: M6AdminTransport = fetch) {
    this.http = new M6AdminJsonClient(config, adminKey, transport);
  }

  async list(input: ContentListRequest): Promise<ContentListResponse> {
    const request = contentListRequestSchema.parse(input);
    if (request.service_id !== this.http.config.service_id) throw new Error("Catalog request belongs to another service");
    const response = contentListResponseSchema.parse(await this.http.post("catalog", request));
    if (JSON.stringify(response.request) !== JSON.stringify(request)) throw new Error("Catalog response belongs to another exact request");
    return response;
  }
}

export function formatContentList(result: ContentListResponse): string {
  const lines = [`Service: ${result.request.service_id} (${result.admission_state})`,
    "Server records only; local-only drafts are not included. Snapshot only, not an operation authorization."];
  if ("shows" in result) {
    lines.push(...formatShowTable(result.shows));
    if (!result.shows.length) lines.push("No Shows on this page.");
  } else {
    lines.push(`Show: ${result.show.show_id} (${result.show.lifecycle}); unfinished operation: ${result.show.unfinished_operation}`);
    if (result.admission_state === "paused" || result.show.lifecycle !== "active") lines.push("Parent Show/service is not serving these Episodes.");
    lines.push(...formatEpisodeTable(result.episodes));
    if (!result.episodes.length) lines.push("No Episodes on this page.");
  }
  lines.push("Unavailable titles/dates may be unpublished, removed, busy or missing metadata. Feed URLs do not certify delivery.");
  if (result.next_cursor !== null) lines.push(`More records: repeat this command with --cursor ${JSON.stringify(result.next_cursor)} and the same options.`);
  return lines.join("\n");
}
