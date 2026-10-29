import { SQLITE_CATALOG_PAGE_SIZE, sqliteCatalogCursorSchema, sqliteCatalogRequestSchema, sqliteCatalogResponseSchema } from "../packages/shared/src/sqlite-catalog";
import type { SqliteCatalogRequest, SqliteCatalogResponse } from "../packages/shared/src/sqlite-catalog";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";

export function readSqliteCatalog(storage: PublicationQueueStorage, input: SqliteCatalogRequest,
  identity: SqlitePublicationRuntime, origin: string): SqliteCatalogResponse {
  const request = sqliteCatalogRequestSchema.parse(input), { cursor, ...options } = request;
  const scope = { ...identity, ...options };
  let after = "";
  if (cursor) {
    const decoded = sqliteCatalogCursorSchema.parse(JSON.parse(atob(cursor)));
    const { last_id, ...bound } = decoded;
    if (JSON.stringify(bound) !== JSON.stringify(sqliteCatalogCursorSchema.omit({ last_id: true }).parse(scope))) throw new Error("Catalog cursor belongs to another query or runtime");
    after = last_id;
  }
  return storage.transactionSync(() => {
    const service = storage.sql.exec<{ state: string }>("SELECT state FROM publication_service WHERE id = 1").toArray()[0];
    const fields = { ...identity, protocol: "sqlite-sequential-v1", request, state: service?.state, snapshot_only: true, authorizes_recovery: false };
    const showRows = storage.sql.exec<{ show_id: string; lifecycle: string; title: string | null }>(`
      SELECT s.show_id, s.lifecycle,
        CASE WHEN s.lifecycle IN ('published', 'unpublished') THEN substr(json_extract(c.metadata_json, '$.title'), 1, 200) END AS title
      FROM publication_shows s LEFT JOIN publication_show_content c USING(show_id)
      WHERE ${request.kind === "episode" ? "s.show_id = ?" : "s.show_id > ? AND (? OR s.lifecycle != 'deleted')"}
      ORDER BY s.show_id LIMIT ?`, ...(request.kind === "episode" ? [request.show_id!, 1] : [after, Number(request.include_deleted), SQLITE_CATALOG_PAGE_SIZE + 1])).toArray();
    const next = (ids: string[]) => ids.length > SQLITE_CATALOG_PAGE_SIZE ? btoa(JSON.stringify({ ...scope, last_id: ids[SQLITE_CATALOG_PAGE_SIZE - 1] })) : null;
    if (request.kind === "show") return sqliteCatalogResponseSchema.parse({ ...fields, next_cursor: next(showRows.map((row) => row.show_id)),
      shows: showRows.slice(0, SQLITE_CATALOG_PAGE_SIZE).map((row) => ({ show_id: row.show_id, lifecycle: row.lifecycle,
        unfinished_operation: false, title: row.title, feed_url: row.lifecycle === "published" ? `${origin}/podcasts/${row.show_id}/feed.xml` : null })) });
    const parent = showRows[0];
    if (!parent) throw new Error("Catalog Show is missing");
    const rows = storage.sql.exec<{ episode_id: string; lifecycle: string; title: string | null; published_at: string | null }>(`
      SELECT e.episode_id, e.lifecycle,
        CASE WHEN e.lifecycle != 'deleted' THEN substr(json_extract(c.revision_json, '$.title'), 1, 200) END AS title,
        CASE WHEN e.lifecycle != 'deleted' THEN json_extract(c.revision_json, '$.published_at') END AS published_at
      FROM publication_episodes e LEFT JOIN publication_episode_content c USING(show_id, episode_id)
      WHERE e.show_id = ? AND e.episode_id > ? AND (? OR e.lifecycle != 'deleted') ORDER BY e.episode_id LIMIT ?`,
    request.show_id!, after, Number(request.include_deleted), SQLITE_CATALOG_PAGE_SIZE + 1).toArray();
    return sqliteCatalogResponseSchema.parse({ ...fields, next_cursor: next(rows.map((row) => row.episode_id)),
      show: { show_id: parent.show_id, lifecycle: parent.lifecycle, unfinished_operation: false }, episodes: rows.slice(0, SQLITE_CATALOG_PAGE_SIZE) });
  });
}
