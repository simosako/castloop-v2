import { z } from "zod";
import { episodeLifecycleSchema, lifecycleStateSchema, showControlSchema } from "./lifecycle";
import { publishedTimestampSchema } from "./metadata-time";
import { serviceAdmissionSchema } from "./service-admission";

export const CONTENT_LIST_PAGE_SIZE = 20;
const cursor = z.string().min(1).max(4096);
const requestFields = { schema_version: z.literal(1), service_id: serviceAdmissionSchema.shape.service_id,
  include_deleted: z.boolean(), cursor: cursor.optional() };
const showRequest = z.object({ ...requestFields, kind: z.literal("show") }).strict();
const episodeRequest = z.object({ ...requestFields, kind: z.literal("episode"), show_id: showControlSchema.shape.show_id }).strict();
export const contentListRequestSchema = z.discriminatedUnion("kind", [showRequest, episodeRequest]);

const title = z.string().min(1).max(200).nullable();
const showSummary = z.object({ show_id: showControlSchema.shape.show_id, lifecycle: lifecycleStateSchema,
  unfinished_operation: z.boolean(), title, feed_url: z.url().max(4096) }).strict();
const responseFields = { schema_version: z.literal(1), result: z.literal("catalog"), snapshot_only: z.literal(true),
  authorizes_operation: z.literal(false), admission_state: z.enum(["open", "paused"]), next_cursor: cursor.nullable() };
export const contentListResponseSchema = z.union([
  z.object({ ...responseFields, request: showRequest, shows: z.array(showSummary).max(CONTENT_LIST_PAGE_SIZE) }).strict(),
  z.object({ ...responseFields, request: episodeRequest,
    show: showSummary.pick({ show_id: true, lifecycle: true, unfinished_operation: true }),
    episodes: z.array(z.object({ episode_id: episodeLifecycleSchema.shape.episode_id, lifecycle: lifecycleStateSchema,
      title, published_at: publishedTimestampSchema.nullable() }).strict()).max(CONTENT_LIST_PAGE_SIZE) }).strict(),
]).superRefine((value, context) => {
  if (value.next_cursor !== null && value.next_cursor === value.request.cursor) {
    context.addIssue({ code: "custom", message: "Catalog pagination did not advance" });
  }
  if ("episodes" in value && value.show.show_id !== value.request.show_id) {
    context.addIssue({ code: "custom", message: "Episode catalog belongs to another Show" });
  }
  const items = "shows" in value ? value.shows : value.episodes;
  if (!value.request.include_deleted && items.some((item) => item.lifecycle === "deleted")) {
    context.addIssue({ code: "custom", message: "Deleted entries require an explicit request" });
  }
});

export type ContentListRequest = z.infer<typeof contentListRequestSchema>;
export type ContentListResponse = z.infer<typeof contentListResponseSchema>;
