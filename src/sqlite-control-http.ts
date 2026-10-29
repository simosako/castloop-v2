import { sqliteCatalogRequestSchema } from "../packages/shared/src/sqlite-catalog";
import { sqliteRegistrationSchema } from "../packages/shared/src/sqlite-service-api";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { adminReply } from "./admin-reply";
import type { SqliteServiceControl } from "./sqlite-service-control";
import { sqliteDomainCommitSchema, sqliteDomainFinalizeSchema, sqliteDomainRequestSchema } from "../packages/shared/src/sqlite-domain";

export function createSqliteControlHttp(control: SqliteServiceControl, key: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), path = url.pathname.slice("/admin/sqlite-service/".length);
    if (!await authenticated(request, key)) return adminReply({ error: "unauthorized" }, 401);
    const domainQuery = path.startsWith("domain-status/") && [...url.searchParams.keys()].every((name) => name === "after") && url.searchParams.getAll("after").length <= 1;
    if (!url.pathname.startsWith("/admin/sqlite-service/") || url.search && !domainQuery || url.hash) return adminReply({ error: "not_found" }, 404);
    try {
      if (path === "health" && request.method === "GET") return adminReply(await control.health());
      if (path === "registration-health" && request.method === "GET") return adminReply(control.registrationHealth());
      if (path === "domain-state" && request.method === "GET") return adminReply(control.domainState());
      if (path.startsWith("domain-status/") && request.method === "GET") return adminReply(await control.domainStatus(path.slice(14), url.searchParams.get("after") ?? ""));
      if (path.startsWith("registrations/") && request.method === "GET") return adminReply(control.registrationStatus(path.slice(14)));
      if (!["register-show", "catalog", "domain-prepare", "domain-commit", "domain-finalize"].includes(path)) return adminReply({ error: "show_required" }, 400);
      if (request.method !== "POST") return adminReply({ error: "method_not_allowed" }, 405);
      if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) return adminReply({ error: "invalid_input" }, 400);
      const input = await readBoundedAdminJson(request);
      if (path === "domain-prepare") return adminReply(await control.prepareDomain(sqliteDomainRequestSchema.parse(input)));
      if (path === "domain-commit") return adminReply(await control.commitDomain(sqliteDomainCommitSchema.parse(input)));
      if (path === "domain-finalize") return adminReply(await control.finalizeDomain(sqliteDomainFinalizeSchema.parse(input)));
      if (path === "register-show") return adminReply(await control.register(sqliteRegistrationSchema.parse(input)));
      return adminReply(await control.catalog(sqliteCatalogRequestSchema.parse(input)));
    } catch {
      console.error(JSON.stringify({ event: "sqlite_service_control", reason_code: "service_request_unverified" }));
      return adminReply({ error: "service_request_unverified" }, 409);
    }
  };
}
