import { validateId } from "../packages/shared/src/ids";
import type { PublicVisibilitySnapshot } from "./lifecycle-control";

type DeliveryReadEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "head"> };

function metadata(object: R2Object | null, kind: string): Record<string, string> {
  if (!object || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > 16384 ||
    object.customMetadata?.castloop_delivery !== kind) throw new Error("Public delivery metadata is missing or invalid");
  return object.customMetadata;
}

function generation(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new Error("Invalid public delivery generation");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Invalid public delivery generation");
  return result;
}

function visibility(value: string | undefined): "public" | "not_found" | "gone" {
  if (value !== "public" && value !== "not_found" && value !== "gone") throw new Error("Invalid public delivery visibility");
  return value;
}

export async function readPublicServiceDelivery(env: DeliveryReadEnv, workerVersionId: string, dlqName: string):
  Promise<{ serviceId: string; mode: "m6" | "legacy" | "migration" }> {
  const service = metadata(await env.CASTLOOP_BUCKET.head("system/lifecycle-service.json"), "service-v1");
  const serviceId = service.castloop_service_id;
  if (typeof serviceId !== "string") throw new Error("Public delivery service identity is missing");
  validateId(serviceId, "service");
  if (service.castloop_visibility === "migration") return { serviceId, mode: "migration" };
  if ((service.castloop_visibility !== "public" && service.castloop_visibility !== "legacy") ||
    !workerVersionId || service.castloop_worker_version !== workerVersionId) {
    throw new Error("Public delivery requires its verified open runtime");
  }
  if (service.castloop_visibility === "legacy") return { serviceId, mode: "legacy" };
  const config = metadata(await env.CASTLOOP_BUCKET.head("system/service.toml"), "config-v1");
  if (config.castloop_service_id !== serviceId || config.castloop_dlq_name !== dlqName) {
    throw new Error("Public delivery configuration does not match this service");
  }
  return { serviceId, mode: "m6" };
}

export async function readPublicDeliverySnapshot(env: DeliveryReadEnv, showId: string,
  episodeId?: string): Promise<PublicVisibilitySnapshot> {
  validateId(showId, "show");
  if (episodeId !== undefined) validateId(episodeId, "episode");
  const showObject = await env.CASTLOOP_BUCKET.head(`system/show-publications/${showId}.json`);
  if (!showObject) {
    if (await env.CASTLOOP_BUCKET.head(`system/show-reservations/${showId}.json`)) throw new Error("Reserved Show has no public delivery control");
    return { visibility: "not_found" };
  }
  const show = metadata(showObject, "show-v1");
  if (show.castloop_show_id !== showId) throw new Error("Public Show delivery metadata does not match its key");
  const showGeneration = generation(show.castloop_show_generation);
  const feedGeneration = generation(show.castloop_feed_generation);
  const showVisibility = visibility(show.castloop_visibility);
  if (showVisibility !== "public") return { visibility: showVisibility };
  const snapshot = { visibility: "public" as const, showId, showGeneration, feedGeneration };
  if (episodeId === undefined) return snapshot;
  const episodeObject = await env.CASTLOOP_BUCKET.head(`system/episode-lifecycle/${showId}/${episodeId}.toml`);
  if (!episodeObject) {
    if (await env.CASTLOOP_BUCKET.head(`public/episodes/${showId}/${episodeId}/metadata.toml`)) {
      throw new Error("Published Episode has no public delivery control");
    }
    return { visibility: "not_found" };
  }
  const episode = metadata(episodeObject, "episode-v1");
  if (episode.castloop_show_id !== showId || episode.castloop_episode_id !== episodeId) {
    throw new Error("Public Episode delivery metadata does not match its key");
  }
  const episodeGeneration = generation(episode.castloop_episode_generation);
  const episodeVisibility = visibility(episode.castloop_visibility);
  return episodeVisibility === "public" ? { ...snapshot, episodeId, episodeGeneration } : { visibility: episodeVisibility };
}
