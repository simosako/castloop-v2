import { sqliteRuntimeRequestSchema, sqliteResumeRequestSchema, sqliteRegistrationSchema } from "../packages/shared/src/sqlite-service-api";
import { sqliteCatalogRequestSchema } from "../packages/shared/src/sqlite-catalog";
import { sqliteUpdateActivateSchema, sqliteUpdatePrepareSchema } from "../packages/shared/src/sqlite-runtime-update";
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
      if (path.startsWith("update-status/") && request.method === "GET") return reply(runtime.updates.statusById(path.slice(14)));
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
      if (!["prepare", "pause", "resume", "register-show", "catalog", "update-prepare", "update-activate"].includes(path)) return reply({ error: "not_found" }, 404);
      if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) return reply({ error: "invalid_input" }, 400);
      const body = await readBoundedAdminJson(request);
      if (path === "update-prepare") return reply(runtime.updates.prepare(sqliteUpdatePrepareSchema.parse(body)));
      if (path === "update-activate") return reply(await runtime.updates.activate(sqliteUpdateActivateSchema.parse(body)));
      if (path === "prepare") return reply(await runtime.prepare(sqliteRuntimeRequestSchema.parse(body)), 202);
      if (!runtime.ready()) return reply({ error: "runtime_not_ready" }, 503);
      if (path === "catalog") return reply(runtime.catalog(sqliteCatalogRequestSchema.parse(body)));
      if (path === "pause") {
        throw new Error("Show controls require the versioned Show endpoint");
      }
      const parsed = path === "resume" ? sqliteResumeRequestSchema.parse(body) : sqliteRegistrationSchema.parse(body);
      runtime.requireTarget({ service_id: parsed.service_id, worker_version_id: parsed.worker_version_id,
        service_config_sha256: parsed.service_config_sha256, operation_id: parsed.operation_id });
      if (path === "resume") throw new Error("Show controls require the versioned Show endpoint");
      const registration = sqliteRegistrationSchema.parse(parsed), snapshot = runtime.queue.snapshot();
      if (snapshot.state !== "open") return reply({ error: "stale_window" }, 409);
      runtime.content.registerShow(registration.show_id, registration.reservation_id);
      return reply(await runtime.inspect(registration.show_id));
    } catch {
      console.error(JSON.stringify({ event: "sqlite_service_http", reason_code: "service_request_unverified" }));
      return reply({ error: "service_request_unverified" }, 409);
    }
  };
}
