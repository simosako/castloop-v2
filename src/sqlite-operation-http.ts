import { operationClientSchema, operationCommandSchema } from "../packages/shared/src/sqlite-operations";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { adminReply as reply } from "./admin-reply";
import type { OperationCleanupBucket, SqliteOperationRecords } from "./sqlite-operation-records";

export function operationClient(request: Request) {
  return operationClientSchema.parse({ client_id: request.headers.get("X-Castloop-Client-Id"), cli_version: request.headers.get("X-Castloop-Cli-Version") });
}

export function createSqliteOperationHttp(records: SqliteOperationRecords, key: string, ready: () => boolean,
  bucket: OperationCleanupBucket) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), prefix = "/admin/sqlite-operations/";
    if (!url.pathname.startsWith(prefix)) return reply({ error: "not_found" }, 404);
    if (!await authenticated(request, key)) return reply({ error: "unauthorized" }, 401);
    const path = url.pathname.slice(prefix.length), invocation = crypto.randomUUID();
    try {
      if (request.method === "GET") {
        const allowed = path === "list" ? ["incomplete", "cursor", "parent"] : ["after_version", "request_cursor", "summary"];
        for (const name of url.searchParams.keys()) if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) throw new Error("Invalid operation query");
        if (path === "list") {
          const incomplete = url.searchParams.get("incomplete");
          if (incomplete !== null && incomplete !== "true" && incomplete !== "false") throw new Error("Invalid incomplete filter");
          return reply(records.list(incomplete === "true", url.searchParams.get("cursor") ?? undefined, url.searchParams.get("parent") ?? undefined));
        }
        if (path.startsWith("cleanup/")) return reply(await records.cleanupPlan(path.slice(8)));
        if (path.startsWith("requests/")) {
          const result = records.request(path.slice(9));
          return result ? reply(result) : reply({ error: "not_found" }, 404);
        }
        const after = url.searchParams.get("after_version");
        if (after !== null && !/^\d+$/.test(after)) throw new Error("Invalid event cursor");
        const summary = url.searchParams.get("summary");
        if (summary !== null && summary !== "true" && summary !== "false") throw new Error("Invalid summary option");
        const detail = records.detail(path, after === null ? 0 : Number(after), url.searchParams.get("request_cursor") ?? undefined, summary === "true");
        return detail ? reply(detail) : reply({ error: "not_found" }, 404);
      }
      if (path !== "commands" || request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (url.search || url.hash || request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) {
        return reply({ error: "invalid_command" }, 400);
      }
      if (!ready()) return reply({ error: "publication_not_ready" }, 503);
      const client = operationClient(request), input = operationCommandSchema.parse(await readBoundedAdminJson(request));
      const result = input.action === "cleanup" ? await records.cleanup(input, client, bucket, invocation) : await records.command(input, client, invocation);
      return reply(result, 200);
    } catch {
      console.error(JSON.stringify({ event: "sqlite_operation_http", invocation_id: invocation, reason_code: "operation_unverified" }));
      return reply({ error: "operation_unverified" }, 409);
    }
  };
}
