import { MAX_SQLITE_ACCESS_STATS_REQUEST_BYTES, sqliteAccessStatsDailyRequestSchema, sqliteAccessStatsReplaceRequestSchema,
  sqliteAccessStatsResourcesRequestSchema, sqliteAccessStatsSourcesRequestSchema } from "../packages/shared/src/sqlite-access-stats";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { adminReply } from "./admin-reply";
import { SqliteAccessStatsConflict, SqliteAccessStatsInputError } from "./sqlite-access-stats";
import type { SqliteAccessStats } from "./sqlite-access-stats";

const prefix = "/admin/sqlite-access-stats/";

export function createSqliteAccessStatsHttp(stats: SqliteAccessStats, administratorKey: string,
  ready: () => boolean): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url), path = url.pathname.slice(prefix.length);
    if (!url.pathname.startsWith(prefix) || !["sources", "resources", "daily"].includes(path)) return adminReply({ error: "not_found" }, 404);
    if (!await authenticated(request, administratorKey)) return adminReply({ error: "unauthorized" }, 401);
    if (url.hash) return adminReply({ error: "invalid_input" }, 400);
    try {
      if (request.method === "POST" && path === "daily") {
        if (url.search || request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" ||
          request.headers.has("Content-Encoding")) return adminReply({ error: "invalid_input" }, 400);
        if (!ready()) return adminReply({ error: "show_not_ready" }, 503);
        let input: unknown;
        try { input = await readBoundedAdminJson(request, MAX_SQLITE_ACCESS_STATS_REQUEST_BYTES); }
        catch { return adminReply({ error: "invalid_input" }, 400); }
        const parsed = sqliteAccessStatsReplaceRequestSchema.safeParse(input);
        if (!parsed.success) return adminReply({ error: "invalid_input" }, 400);
        return adminReply(await stats.replace(parsed.data));
      }
      if (request.method !== "GET") return adminReply({ error: "method_not_allowed" }, 405);
      const allowed = ["service_id", "service_config_sha256", "cursor", ...(path === "daily" ? ["source_id", "resource_path", "from", "to"] : [])];
      const query: Record<string, string> = {};
      for (const [name, value] of url.searchParams) {
        if (!allowed.includes(name) || Object.hasOwn(query, name) || !value) return adminReply({ error: "invalid_input" }, 400);
        query[name] = value;
      }
      const identity = { service_id: query.service_id, service_config_sha256: query.service_config_sha256,
        show_id: request.headers.get("X-Castloop-Show-Id"), ...(query.cursor ? { cursor: query.cursor } : {}) };
      if (path === "sources") {
        const parsed = sqliteAccessStatsSourcesRequestSchema.safeParse(identity);
        return parsed.success ? adminReply(stats.sources(parsed.data)) : adminReply({ error: "invalid_input" }, 400);
      }
      if (path === "resources") {
        const parsed = sqliteAccessStatsResourcesRequestSchema.safeParse(identity);
        return parsed.success ? adminReply(stats.resources(parsed.data)) : adminReply({ error: "invalid_input" }, 400);
      }
      const parsed = sqliteAccessStatsDailyRequestSchema.safeParse({ ...identity, source_id: query.source_id,
        resource_path: query.resource_path, from_date_utc: query.from, to_date_utc: query.to });
      return parsed.success ? adminReply(stats.daily(parsed.data)) : adminReply({ error: "invalid_input" }, 400);
    } catch (error) {
      if (error instanceof SqliteAccessStatsInputError) return adminReply({ error: "invalid_input" }, 400);
      if (error instanceof SqliteAccessStatsConflict) return adminReply({ error: "access_stats_conflict" }, 409);
      console.error(JSON.stringify({ event: "sqlite_access_stats_http", reason_code: "access_stats_unavailable" }));
      return adminReply({ error: "access_stats_unavailable" }, 503);
    }
  };
}
