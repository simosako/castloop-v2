import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { adminReply } from "./admin-reply";
import { sqliteStatsRetentionResponseSchema } from "../packages/shared/src/sqlite-service-api";
import type { SqliteHealth } from "../packages/shared/src/sqlite-service-api";
import { sqliteStatsEpisodesResponseSchema, sqliteStatsEpisodeDailyResponseSchema } from "../packages/shared/src/sqlite-stats";
import type { SqliteDeliveryStats } from "./sqlite-delivery-stats";

const prefix = "/admin/sqlite-stats/";
const episodeIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const allowedQueries = ["from", "to", "cursor"];

export function createSqliteStatsHttp(stats: SqliteDeliveryStats, administratorKey: string,
  showId: string, health: () => SqliteHealth): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix)) return adminReply({ error: "not_found" }, 404);
    if (!await authenticated(request, administratorKey)) return adminReply({ error: "unauthorized" }, 401);
    if (url.hash) return adminReply({ error: "invalid_route" }, 400);
    const path = url.pathname.slice(prefix.length);
    try {
      const query: Record<string, string> = {};
      for (const [name, value] of url.searchParams) {
        if (!allowedQueries.includes(name) || Object.hasOwn(query, name) || value === "") throw new Error("Invalid statistics query");
        query[name] = value;
      }
      if ((query.from !== undefined && !datePattern.test(query.from)) ||
        (query.to !== undefined && !datePattern.test(query.to))) return adminReply({ error: "invalid_input" }, 400);
      const meta = stats.meta();
      const identity = health();
      const runtimeFields = { service_id: identity.service_id, worker_version_id: identity.worker_version_id,
        service_config_sha256: identity.service_config_sha256, state: identity.state as typeof identity.state | null,
        protocol: "sqlite-sequential-v1" as const };
      const common = { ...runtimeFields, measurement_started_at_ms: meta.measurement_started_at_ms,
        measurement_started_date_utc: meta.measurement_started_date_utc,
        retained_from_date_utc: meta.retained_from_date_utc, retention_days: meta.retention_days,
        recording_error_count: meta.recording_error_count, collection_mode: "best_effort_non_blocking" as const,
        current_date_utc: new Date(Date.now()).toISOString().slice(0, 10) };
      if (path === "episodes" && request.method === "GET") {
        const page = stats.episodePage({ from_date_utc: query.from, to_date_utc: query.to, cursor: query.cursor });
        return adminReply(sqliteStatsEpisodesResponseSchema.parse({ ...common, show_id: showId,
          from_date_utc: page.fromDate, to_date_utc: page.toDate,
          episodes: page.episodes, next_cursor: page.nextCursor }));
      }
      if (path.startsWith("episodes/") && request.method === "GET") {
        const episodeId = path.slice("episodes/".length);
        if (!episodeIdPattern.test(episodeId) || episodeId.length > 80 || !stats.episodeExists(episodeId)) return adminReply({ error: "not_found" }, 404);
        const page = stats.dailyPage({ episode_id: episodeId, from_date_utc: query.from, to_date_utc: query.to, cursor: query.cursor });
        return adminReply(sqliteStatsEpisodeDailyResponseSchema.parse({ ...common, show_id: showId,
          episode_id: page.episodeId, episode_lifecycle: page.lifecycle,
          from_date_utc: page.fromDate, to_date_utc: page.toDate, coverage: page.coverage, period: page.period,
          lifetime: page.lifetime, revisions: page.revisions, days: page.days, next_cursor: page.nextCursor }));
      }
      if (path === "retention" && request.method === "POST") {
        if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) {
          return adminReply({ error: "invalid_input" }, 400);
        }
        const input = await readBoundedAdminJson(request);
        const snapshot = health();
        const retention = await stats.applyRetention(input, {
          service_id: snapshot.service_id, worker_version_id: snapshot.worker_version_id,
          service_config_sha256: snapshot.service_config_sha256 });
        return adminReply(sqliteStatsRetentionResponseSchema.parse({ ...snapshot, retention }));
      }
      if (path.startsWith("retention/") && request.method === "GET") {
        const operationId = path.slice("retention/".length);
        if (!uuidPattern.test(operationId)) return adminReply({ error: "not_found" }, 404);
        const retention = stats.retentionRecord(operationId);
        return retention ? adminReply(sqliteStatsRetentionResponseSchema.parse({ ...health(), retention })) :
          adminReply({ error: "not_found" }, 404);
      }
      return adminReply({ error: "method_not_allowed" }, 405);
    } catch {
      console.error(JSON.stringify({ event: "sqlite_stats_http", reason_code: "stats_request_unverified" }));
      return adminReply({ error: "stats_unavailable" }, 409);
    }
  };
}
