import { z } from "zod";
import { sqlitePublicationProtocol, sqlitePublicationTargetSchema, sqlitePublicationRuntimeSchema } from "./sqlite-publication";
import { sqliteAvailabilityStateSchema } from "./sqlite-availability";

export const SQLITE_CATALOG_PAGE_SIZE = 20;
const lifecycle = z.enum(["draft", "published", "unpublished", "deleted"]);
const options = { kind: z.enum(["show", "episode"]), show_id: sqlitePublicationTargetSchema.shape.show_id.optional(),
  include_deleted: z.boolean(), cursor: z.string().min(1).max(2048).optional() };
export const sqliteCatalogRequestSchema = z.object(options).strict().superRefine((value, context) => {
  if ((value.kind === "episode") !== (value.show_id !== undefined)) context.addIssue({ code: "custom", message: "Catalog target differs from its kind" });
});
const show = z.object({ show_id: sqlitePublicationTargetSchema.shape.show_id, lifecycle,
  unfinished_operation: z.boolean(), title: z.string().min(1).max(200).nullable(), feed_url: z.url().nullable() }).strict();
export const sqliteCatalogResponseSchema = sqlitePublicationRuntimeSchema.extend({ protocol: z.literal(sqlitePublicationProtocol),
  request: sqliteCatalogRequestSchema, state: sqliteAvailabilityStateSchema.nullable(), snapshot_only: z.literal(true), authorizes_recovery: z.literal(false),
  next_cursor: z.string().min(1).max(2048).nullable(), shows: z.array(show).max(SQLITE_CATALOG_PAGE_SIZE).optional(),
  show: show.pick({ show_id: true, lifecycle: true, unfinished_operation: true }).optional(),
  episodes: z.array(z.object({ episode_id: sqlitePublicationTargetSchema.shape.episode_id.unwrap(), lifecycle,
    title: z.string().min(1).max(200).nullable(), published_at: z.string().max(100).nullable() }).strict()).max(SQLITE_CATALOG_PAGE_SIZE).optional(),
}).strict().superRefine((value, context) => {
  const episode = value.request.kind === "episode";
  const ids = episode ? value.episodes?.map((item) => item.episode_id) : value.shows?.map((item) => item.show_id);
  if (episode !== (value.episodes !== undefined && value.show !== undefined) || episode === (value.shows !== undefined) ||
    episode && value.state === null || value.show?.show_id !== value.request.show_id || !ids || ids.some((id, index) => index > 0 && id <= ids[index - 1]) ||
    !value.request.include_deleted && (value.shows ?? value.episodes ?? []).some((item) => item.lifecycle === "deleted") ||
    value.next_cursor !== null && (value.next_cursor === value.request.cursor || ids.length !== SQLITE_CATALOG_PAGE_SIZE)) {
    context.addIssue({ code: "custom", message: "Catalog page differs from its request" });
  }
});
export type SqliteCatalogRequest = z.infer<typeof sqliteCatalogRequestSchema>;
export type SqliteCatalogResponse = z.infer<typeof sqliteCatalogResponseSchema>;

export const sqliteCatalogCursorSchema = sqlitePublicationRuntimeSchema.extend({ kind: options.kind, show_id: options.show_id,
  include_deleted: options.include_deleted, last_id: z.string().max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict();
