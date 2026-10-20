import { parseSqlitePublicationRequest, sqlitePublicationRequestSchema } from "../packages/shared/src/sqlite-publication";
import { sqliteServiceStatusSchema } from "../packages/shared/src/sqlite-service";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { PublicationQueueConflict, SqlitePublicationQueue } from "./sqlite-publication-queue";
import { adminReply as reply } from "./admin-reply";
import { operationClient } from "./sqlite-operation-http";

const prefix = "/admin/sqlite-publication/";
export function createSqlitePublicationHttp(queue: SqlitePublicationQueue, administratorKey: string,
  publicationReady: () => boolean, showId?: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix)) return reply({ error: "not_found" }, 404);
    if (!await authenticated(request, administratorKey)) return reply({ error: "unauthorized" }, 401);
    if (url.search || url.hash) return reply({ error: "invalid_route" }, 400);
    const path = url.pathname.slice(prefix.length);
    if (path.startsWith("jobs/") && request.method === "GET") {
      const id = sqlitePublicationRequestSchema.shape.request_id.safeParse(path.slice(5));
      if (!id.success) return reply({ error: "not_found" }, 404);
      try { const status = queue.status(id.data); return status ? reply(status) : reply({ error: "not_found" }, 404); }
      catch { return reply({ error: "status_unavailable" }, 503); }
    }
    if (path !== "status" && path !== "jobs") return reply({ error: "not_found" }, 404);
    if (request.method !== (path === "status" ? "GET" : "POST")) return reply({ error: "method_not_allowed" }, 405);
    if (!publicationReady()) return reply({ error: "publication_not_ready" }, 503);
    if (path === "status") {
      try {
        const snapshot = queue.snapshot();
        return reply(sqliteServiceStatusSchema.parse({ ...queue.identity(), protocol: "sqlite-sequential-v1",
          ...(showId ? { show_id: showId } : {}),
          state: snapshot.state, admission_window_id: snapshot.admission_window_id, publication_ready: true }));
      } catch { return reply({ error: "runtime_unavailable" }, 503); }
    }
    let input;
    try {
      if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) {
        throw new Error("Invalid bounded publication content type");
      }
      input = parseSqlitePublicationRequest(await readBoundedAdminJson(request));
    } catch {
      try { if (request.body && !request.body.locked) await request.body.cancel(); }
      catch { return reply({ error: "input_unavailable" }, 503); }
      return reply({ error: "invalid_publication" }, 400);
    }
    const invocation = crypto.randomUUID();
    try { return reply(await queue.enqueue(input, request.headers.has("X-Castloop-Client-Id") ? operationClient(request) : undefined, invocation), 202); }
    catch (error) {
      console.error(JSON.stringify({ event: "sqlite_publication_http", request_id: input.request_id, job_id: input.job_id, invocation_id: invocation,
        reason_code: error instanceof PublicationQueueConflict ? "request_conflict" : "submission_unverified" }));
      return reply({ error: error instanceof PublicationQueueConflict ? "request_conflict" : "submission_unverified" },
        error instanceof PublicationQueueConflict ? 409 : 503);
    }
  };
}
