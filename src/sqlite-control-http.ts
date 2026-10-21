import { sqliteCatalogRequestSchema } from "../packages/shared/src/sqlite-catalog";
import { sqliteRegistrationSchema } from "../packages/shared/src/sqlite-service-api";
import { sqliteUpdateActivateSchema, sqliteUpdatePrepareSchema } from "../packages/shared/src/sqlite-runtime-update";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { adminReply } from "./admin-reply";
import { createSqliteServiceHttp } from "./sqlite-service-http";
import type { SqliteServiceControl } from "./sqlite-service-control";

export function createSqliteControlHttp(control: SqliteServiceControl, key: string) {
  const setupHttp = createSqliteServiceHttp(control.runtime, key);
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), path = url.pathname.slice("/admin/sqlite-service/".length);
    if (!await authenticated(request, key)) return adminReply({ error: "unauthorized" }, 401);
    if (!url.pathname.startsWith("/admin/sqlite-service/") || url.search || url.hash) return adminReply({ error: "not_found" }, 404);
    try {
      if (path === "health" && request.method === "GET") return adminReply(await control.health());
      if (path === "registration-health" && request.method === "GET") return adminReply(control.registrationHealth());
      if (path.startsWith("registrations/") && request.method === "GET") return adminReply(control.registrationStatus(path.slice(14)));
      if (path.startsWith("update-status/") && request.method === "GET") return adminReply(await control.updateStatus(path.slice(14)));
      if (path === "prepare") return setupHttp(request);
      if (!["register-show", "catalog", "update-prepare", "update-activate"].includes(path)) return adminReply({ error: "show_required" }, 400);
      if (request.method !== "POST") return adminReply({ error: "method_not_allowed" }, 405);
      if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) return adminReply({ error: "invalid_input" }, 400);
      const input = await readBoundedAdminJson(request);
      if (path === "register-show") return adminReply(await control.register(sqliteRegistrationSchema.parse(input)));
      if (path === "catalog") return adminReply(await control.catalog(sqliteCatalogRequestSchema.parse(input)));
      if (path === "update-prepare") return adminReply(await control.prepareUpdate(sqliteUpdatePrepareSchema.parse(input)));
      return adminReply(await control.activateUpdate(sqliteUpdateActivateSchema.parse(input)));
    } catch {
      console.error(JSON.stringify({ event: "sqlite_service_control", reason_code: "service_request_unverified" }));
      return adminReply({ error: "service_request_unverified" }, 409);
    }
  };
}
