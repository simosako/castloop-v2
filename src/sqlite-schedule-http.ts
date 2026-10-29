import { sqliteScheduleCancelSchema, sqliteScheduleCreateSchema, sqliteScheduleReapproveSchema, sqliteScheduleRescheduleSchema } from "../packages/shared/src/sqlite-schedule";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { adminReply as reply } from "./admin-reply";
import { MAX_SQLITE_DIRECT_PUBLICATION_BYTES } from "../packages/shared/src/sqlite-direct-publication";
import { SqlitePublicationSchedules } from "./sqlite-publication-schedules";

const prefix = "/admin/sqlite-schedules";
export function createSqliteScheduleHttp(schedules: SqlitePublicationSchedules, administratorKey: string,
  showId: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return reply({ error: "not_found" }, 404);
    if (!await authenticated(request, administratorKey)) return reply({ error: "unauthorized" }, 401);
    if (url.hash) return reply({ error: "invalid_route" }, 400);
    const path = url.pathname.slice(prefix.length);
    try {
      if (path === "" || path === "/") {
        if (request.method === "GET") {
          for (const name of url.searchParams.keys()) if (name !== "after") return reply({ error: "invalid_route" }, 400);
          return reply(schedules.list(url.searchParams.get("after") ?? undefined));
        }
        if (url.search) return reply({ error: "invalid_route" }, 400);
        if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
        if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) {
          return reply({ error: "invalid_input" }, 400);
        }
        const input = sqliteScheduleCreateSchema.parse(await readBoundedAdminJson(request, MAX_SQLITE_DIRECT_PUBLICATION_BYTES + 16384));
        if (input.show_id !== showId) return reply({ error: "target_differs" }, 409);
        return reply(await schedules.create(input), 202);
      }
      const parts = path.slice(1).split("/");
      if (parts.length > 2 || parts.some((part) => !part)) return reply({ error: "invalid_route" }, 400);
      const scheduleId = sqliteScheduleCancelSchema.shape.schedule_id.parse(parts[0]);
      if (parts.length === 1) {
        if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
        if (url.search) return reply({ error: "invalid_route" }, 400);
        return reply(schedules.status(scheduleId));
      }
      const action = parts[1];
      if (!["cancel", "reschedule", "reapprove"].includes(action!)) return reply({ error: "not_found" }, 404);
      if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (url.search) return reply({ error: "invalid_route" }, 400);
      if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) {
        return reply({ error: "invalid_input" }, 400);
      }
      const input = await readBoundedAdminJson(request, MAX_SQLITE_DIRECT_PUBLICATION_BYTES + 16384);
      if (action === "cancel") {
        const parsed = sqliteScheduleCancelSchema.parse(input);
        if (parsed.show_id !== showId || parsed.schedule_id !== scheduleId) return reply({ error: "target_differs" }, 409);
        return reply(await schedules.cancel(parsed), 202);
      }
      if (action === "reschedule") {
        const parsed = sqliteScheduleRescheduleSchema.parse(input);
        if (parsed.show_id !== showId || parsed.schedule_id !== scheduleId) return reply({ error: "target_differs" }, 409);
        return reply(await schedules.reschedule(parsed), 202);
      }
      const parsed = sqliteScheduleReapproveSchema.parse(input);
      if (parsed.show_id !== showId || parsed.schedule_id !== scheduleId) return reply({ error: "target_differs" }, 409);
      return reply(await schedules.reapprove(parsed), 202);
    } catch {
      console.error(JSON.stringify({ event: "sqlite_schedule_http", show_id: showId, reason_code: "schedule_request_unverified" }));
      return reply({ error: "schedule_request_unverified" }, 409);
    }
  };
}
