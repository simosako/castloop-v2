import { CONTENT_LIST_PAGE_SIZE, contentListRequestSchema, contentListResponseSchema, parseEpisodeRevision, parseShowMetadata, validateId } from "../packages/shared/src/index";
import type { ContentListRequest, ContentListResponse, LifecycleState } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { readEpisodeLifecycle, readShowControl } from "./lifecycle-control";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import { M6ManagementServiceMismatch, withM6ManagementRead } from "./m6-management";

type Env = { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "head" | "list">; CASTLOOP_ADMIN_KEY: string };

function hasPublishedMetadata(lifecycle: LifecycleState): boolean {
  return lifecycle === "active" || lifecycle === "unpublished";
}

async function metadata<T>(env: Env, key: string, parse: (source: string) => T): Promise<T | null> {
  const object = await env.CASTLOOP_BUCKET.get(key);
  if (!object) return null;
  if (object.size < 1 || object.size > 16384) {
    await object.body.cancel();
    return null;
  }
  const source = await object.text();
  try { return parse(source); } catch { return null; }
}

function shortTitle(value: string): string {
  return Array.from(value).slice(0, 100).join("");
}

async function listContent(env: Env, bindings: M6DeliveryGateBindings, input: ContentListRequest): Promise<ContentListResponse | null> {
  return withM6ManagementRead(env, input.service_id, bindings, async (admission, config) => {
    const parent = input.kind === "episode" ? await readShowControl(env, input.show_id) : null;
    if (input.kind === "episode" && !parent) return null;
    const prefix = input.kind === "show" ? "system/show-publications/" : `system/episode-lifecycle/${input.show_id}/`;
    const suffix = input.kind === "show" ? ".json" : ".toml";
    const page = await env.CASTLOOP_BUCKET.list({ prefix, limit: CONTENT_LIST_PAGE_SIZE, cursor: input.cursor });
    const common = { schema_version: 1, result: "catalog", request: input, snapshot_only: true, authorizes_operation: false,
      admission_state: admission.state, next_cursor: page.truncated ? page.cursor : null };
    const shows: Extract<ContentListResponse, { shows: unknown }>["shows"] = [];
    const episodes: Extract<ContentListResponse, { episodes: unknown }>["episodes"] = [];
    for (const object of page.objects) {
      if (!object.key.startsWith(prefix) || !object.key.endsWith(suffix)) throw new Error("Invalid catalog control key");
      const id = validateId(object.key.slice(prefix.length, -suffix.length), input.kind);
      if (input.kind === "show") {
        const control = await readShowControl(env, id);
        if (!control) throw new Error("Show control disappeared during listing");
        if (control.value.lifecycle === "deleted" && !input.include_deleted) continue;
        const current = !control.value.owner && hasPublishedMetadata(control.value.lifecycle) ?
          await metadata(env, `system/shows/${id}/show.toml`, parseShowMetadata) : null;
        shows.push({ show_id: id, lifecycle: control.value.lifecycle, unfinished_operation: !!control.value.owner,
          title: current?.show_id === id ? shortTitle(current.title) : null,
          feed_url: `${config.public_base_url.replace(/\/$/, "")}/podcasts/${id}/feed.xml` });
      } else {
        const control = await readEpisodeLifecycle(env, input.show_id, id);
        if (!control) throw new Error("Episode control disappeared during listing");
        if (control.lifecycle === "deleted" && !input.include_deleted) continue;
        const current = !parent!.value.owner && hasPublishedMetadata(parent!.value.lifecycle) && hasPublishedMetadata(control.lifecycle) ?
          await metadata(env, `public/episodes/${input.show_id}/${id}/metadata.toml`, parseEpisodeRevision) : null;
        const matches = current?.episode_id === id;
        episodes.push({ episode_id: id, lifecycle: control.lifecycle, title: matches ? shortTitle(current.title) : null,
          published_at: matches ? current.published_at : null });
      }
    }
    return contentListResponseSchema.parse(input.kind === "show" ? { ...common, shows } : { ...common,
      show: { show_id: input.show_id, lifecycle: parent!.value.lifecycle, unfinished_operation: !!parent!.value.owner }, episodes });
  });
}

export async function handleM6ContentList(request: Request, env: Env, bindings: M6DeliveryGateBindings): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/admin/catalog") return null;
  const reply = (data: object, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return reply({ error: "method not allowed" }, 405);
  let input: ContentListRequest;
  try { input = contentListRequestSchema.parse(await readBoundedAdminJson(request)); }
  catch { return reply({ error: "Invalid catalog request", reason_code: "catalog_input_invalid" }, 400); }
  try {
    const result = await listContent(env, bindings, input);
    if (!result) return reply({ error: "Show not found", reason_code: "catalog_show_missing" }, 404);
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 65536) throw new Error("Catalog exceeds its response budget");
    return reply(result);
  } catch (error) {
    if (error instanceof M6ManagementServiceMismatch) return reply({ error: "Service ID mismatch", reason_code: "catalog_input_invalid" }, 400);
    console.error(JSON.stringify({ event: "catalog_read_failed", reason_code: "catalog_unavailable" }));
    return reply({ error: "Catalog could not be read; retry read-only inspection", reason_code: "catalog_unavailable" }, 409);
  }
}
