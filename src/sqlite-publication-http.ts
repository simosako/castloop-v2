import { parseSqliteDirectPublicationRequest, MAX_SQLITE_DIRECT_PUBLICATION_BYTES } from "../packages/shared/src/sqlite-direct-publication";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { SqlitePublicationInputError } from "./sqlite-publication-queue";
import type { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { adminReply as reply } from "./admin-reply";

export function createSqlitePublicationHttp(queue: SqlitePublicationQueue, administratorKey: string,
  publicationReady: () => boolean): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url), prefix = "/admin/sqlite-publication/";
    if (!url.pathname.startsWith(prefix)) return reply({ error: "not_found" }, 404);
    if (!await authenticated(request, administratorKey)) return reply({ error: "unauthorized" }, 401);
    if (url.search || url.hash) return reply({ error: "invalid_route" }, 400);
    if (url.pathname.slice(prefix.length) !== "publish") return reply({ error: "not_found" }, 404);
    if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    if (!publicationReady()) return reply({ error: "publication_not_ready" }, 503);
    let input;
    try {
      if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) throw new Error("Invalid publication content type");
      input = parseSqliteDirectPublicationRequest(await readBoundedAdminJson(request, MAX_SQLITE_DIRECT_PUBLICATION_BYTES));
    } catch { return reply({ error: "invalid_publication" }, 400); }
    try { return reply(await queue.publish(input)); }
    catch (error) {
      if (error instanceof SqlitePublicationInputError) return reply({ error: error.reason }, error.reason === "validation_failed" ? 400 : 409);
      console.error(JSON.stringify({ event: "sqlite_publication_http", reason_code: "publication_failed" }));
      return reply({ error: "publication_failed" }, 503);
    }
  };
}
