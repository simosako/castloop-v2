import { parseEpisodeRevision, targetInspectionRequestSchema, targetInspectionResponseSchema } from "../packages/shared/src/index";
import type { TargetInspectionRequest, TargetInspectionResponse } from "../packages/shared/src/index";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import { readEpisodeLifecycle, readShowControl } from "./lifecycle-control";
import type { LifecycleReadEnv } from "./lifecycle-control";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import { M6ManagementServiceMismatch, withM6ManagementRead } from "./m6-management";
import { requireShowReservationReady } from "./show-reservation-record";

type Env = LifecycleReadEnv & { CASTLOOP_ADMIN_KEY: string };

async function inspectTarget(env: Env, bindings: M6DeliveryGateBindings, input: TargetInspectionRequest): Promise<TargetInspectionResponse> {
  return withM6ManagementRead(env, input.service_id, bindings, async (admission) => {
    const show = await readShowControl(env, input.show_id);
    if (show) await requireShowReservationReady(env, show.value);
    else if (await env.CASTLOOP_BUCKET.head(`system/show-reservations/${input.show_id}.json`)) {
      throw new Error("Reserved Show has no lifecycle control record");
    }
    const episode = input.kind === "episode" ? await readEpisodeLifecycle(env, input.show_id, input.episode_id!) : null;
    if (!show && episode) throw new Error("Episode control has no matching Show control");
    const key = input.kind === "episode" ? `public/episodes/${input.show_id}/${input.episode_id}/metadata.toml` : undefined;
    let metadata: R2ObjectBody | null = null;
    let history: R2ObjectBody | null = null;
    let historyKey: string | undefined;
    let currentRevision: TargetInspectionResponse["current_revision"] = null;
    if (key && !show?.value.owner && episode && ["active", "unpublished"].includes(episode.lifecycle)) {
      metadata = await env.CASTLOOP_BUCKET.get(key);
      if (!metadata || metadata.size < 1 || metadata.size > 1_000_000) throw new Error("Current Episode metadata is missing or oversized");
      currentRevision = parseEpisodeRevision(await metadata.text());
      if (currentRevision.episode_id !== input.episode_id) throw new Error("Current Episode metadata targets another Episode");
      historyKey = `public/episodes/${input.show_id}/${input.episode_id}/revisions/${currentRevision.revision_id}.toml`;
      history = await env.CASTLOOP_BUCKET.get(historyKey);
      if (!history || history.size < 1 || history.size > 1_000_000 ||
        JSON.stringify(parseEpisodeRevision(await history.text())) !== JSON.stringify(currentRevision)) {
        throw new Error("Current Episode history is missing or inconsistent");
      }
    } else if (key && !show?.value.owner && (!episode || episode.lifecycle === "draft")) {
      if (await env.CASTLOOP_BUCKET.head(key)) throw new Error("Draft or missing Episode has orphan current metadata");
    }
    const afterShow = await readShowControl(env, input.show_id);
    const afterEpisode = input.kind === "episode" ? await readEpisodeLifecycle(env, input.show_id, input.episode_id!) : null;
    if (show?.etag !== afterShow?.etag || JSON.stringify(show?.value) !== JSON.stringify(afterShow?.value) ||
      JSON.stringify(episode) !== JSON.stringify(afterEpisode)) throw new Error("Target controls changed during inspection");
    if (afterShow) await requireShowReservationReady(env, afterShow.value);
    if (key && historyKey) {
      const [afterMetadata, afterHistory] = await Promise.all([env.CASTLOOP_BUCKET.head(key), env.CASTLOOP_BUCKET.head(historyKey)]);
      if (metadata?.etag !== afterMetadata?.etag || metadata?.size !== afterMetadata?.size ||
        history?.etag !== afterHistory?.etag || history?.size !== afterHistory?.size) throw new Error("Current Episode revision changed during inspection");
    }
    return targetInspectionResponseSchema.parse({ schema_version: 1, result: "target", request: input,
      snapshot_only: true, authorizes_operation: false, payloads_verified: false, admission_state: admission.state,
      show: show ? { lifecycle: show.value.lifecycle, generation: show.value.generation } : null,
      episode: episode ? { lifecycle: episode.lifecycle, generation: episode.generation } : null,
      unfinished_show_operation: !!show?.value.owner, current_revision: currentRevision });
  });
}

export async function handleM6TargetInspection(request: Request, env: Env, bindings: M6DeliveryGateBindings): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/admin/target") return null;
  const reply = (data: object, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
  if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return reply({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return reply({ error: "method not allowed" }, 405);
  let input: TargetInspectionRequest;
  try { input = targetInspectionRequestSchema.parse(await readBoundedAdminJson(request)); }
  catch { return reply({ error: "Invalid target inspection", reason_code: "target_input_invalid" }, 400); }
  try {
    const result = await inspectTarget(env, bindings, input);
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 2_000_000) throw new Error("Target inspection exceeds its response budget");
    return reply(result);
  }
  catch (error) {
    if (error instanceof M6ManagementServiceMismatch) return reply({ error: "Service ID mismatch", reason_code: "target_input_invalid" }, 400);
    console.error(JSON.stringify({ event: "target_inspection_blocked", reason_code: "target_inspection_blocked" }));
    return reply({ error: "Target inspection could not verify a consistent snapshot", reason_code: "target_inspection_blocked" }, 409);
  }
}
