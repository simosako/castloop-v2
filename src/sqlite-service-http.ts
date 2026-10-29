import { sqliteCatalogRequestSchema } from "../packages/shared/src/sqlite-catalog";
import { adminReply as reply } from "./admin-reply";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { SqliteServiceRuntime } from "./sqlite-service-runtime";

export function createSqliteServiceHttp(runtime: SqliteServiceRuntime, key: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url), path = url.pathname.slice("/admin/sqlite-service/".length);
    if (!url.pathname.startsWith("/admin/sqlite-service/")) return reply({ error: "not_found" }, 404);
    if (!await authenticated(request, key)) return reply({ error: "unauthorized" }, 401);
    if (url.search || url.hash) return reply({ error: "invalid_route" }, 400);
    try {
      if (path === "health" && request.method === "GET") return reply(runtime.health());
      if (path.startsWith("targets/") && request.method === "GET") {
        const parts = path.slice(8).split("/");
        if (parts.length < 1 || parts.length > 2 || parts.some((part) => !part)) return reply({ error: "invalid_target" }, 400);
        return reply(await runtime.inspect(parts[0], parts[1]));
      }
      if (path.startsWith("content/") && request.method === "GET") {
        const parts = path.slice(8).split("/");
        if (parts.length < 1 || parts.length > 2 || parts.some((part) => !part)) return reply({ error: "invalid_target" }, 400);
        return reply(await runtime.contentSnapshot(parts[0]!, parts[1]));
      }
      if (path.startsWith("content-inventory/") && request.method === "GET") {
        const parts = path.slice(18).split("/");
        if ((parts.length !== 2 && parts.length !== 4) || !/^\d+$/.test(parts[1]!) ||
          !Number.isSafeInteger(Number(parts[1])) || parts.length === 4 && parts[2] !== "after") return reply({ error: "invalid_target" }, 400);
        return reply(runtime.previewInventory(parts[0]!, Number(parts[1]), parts[3]));
      }
      if (path.startsWith("revisions/") && request.method === "GET") {
        const parts = path.slice(10).split("/");
        if (parts.some((part) => !part)) return reply({ error: "invalid_target" }, 400);
        if (parts.length === 1) return reply(runtime.revisions(parts[0]!));
        if (parts.length === 3 && parts[1] === "after" && /^\d+$/.test(parts[2]!)) {
          return reply(runtime.revisions(parts[0]!, { afterSequence: Number(parts[2]) }));
        }
        if (parts.length === 3 && parts[1] === "item") {
          const detail = runtime.revisionDetail(parts[0]!, parts[2]!);
          return detail ? reply(detail) : reply({ error: "not_found" }, 404);
        }
        if (parts.length === 3 && parts[1] === "episodes") {
          return reply(runtime.revisions(parts[0]!, { episodeId: parts[2] }));
        }
        if (parts.length === 5 && parts[1] === "episodes" && parts[3] === "after" && /^\d+$/.test(parts[4]!)) {
          return reply(runtime.revisions(parts[0]!, { episodeId: parts[2], afterSequence: Number(parts[4]) }));
        }
        if (parts.length === 5 && parts[1] === "episodes" && parts[3] === "item") {
          const detail = runtime.revisionDetail(parts[0]!, parts[4]!, parts[2]);
          return detail ? reply(detail) : reply({ error: "not_found" }, 404);
        }
        return reply({ error: "invalid_target" }, 400);
      }
      if (path !== "catalog") return reply({ error: "not_found" }, 404);
      if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) return reply({ error: "invalid_input" }, 400);
      const body = await readBoundedAdminJson(request);
      if (!runtime.ready()) return reply({ error: "runtime_not_ready" }, 503);
      return reply(runtime.catalog(sqliteCatalogRequestSchema.parse(body)));
    } catch {
      console.error(JSON.stringify({ event: "sqlite_service_http", reason_code: "service_request_unverified" }));
      return reply({ error: "service_request_unverified" }, 409);
    }
  };
}
