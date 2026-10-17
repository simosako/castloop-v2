import { parseEpisodeLifecycle, parseServiceConfig, parseShowControl, serviceAdmissionSchema, validateId } from "../packages/shared/src/index";

type DeliveryWriteEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "put"> };
type DeliveryPrepareEnv = { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "put" | "list"> };
const MAX_RECORD_BYTES = 16384;

export function publicDeliveryMetadata(key: string, source: string): Record<string, string> {
  const size = new TextEncoder().encode(source).length;
  if (size < 1 || size > MAX_RECORD_BYTES) {
    throw new Error("Public delivery source is empty or oversized");
  }
  if (key === "system/service.toml") {
    const config = parseServiceConfig(source);
    return { castloop_delivery: "config-v1", castloop_service_id: config.service_id, castloop_dlq_name: config.dlq_name };
  }
  if (key === "system/lifecycle-service.json") {
    const service = serviceAdmissionSchema.parse(JSON.parse(source));
    const readiness = service.runtime_readiness ?? service.readiness;
    let visibility: "public" | "legacy" | "migration" | "closed" = "closed";
    if (service.mode === "legacy" && service.state === "migrating") visibility = "migration";
    if (service.mode === "m6" && service.state === "open" && !service.url_change && readiness) {
      visibility = service.runtime_readiness ? "public" : "legacy";
    }
    return { castloop_delivery: "service-v1", castloop_service_id: service.service_id, castloop_visibility: visibility,
      ...(readiness && (visibility === "public" || visibility === "legacy") ? { castloop_worker_version: readiness.worker_version_id } : {}) };
  }
  const showMatch = /^system\/show-publications\/([^/]+)\.json$/.exec(key);
  if (showMatch) {
    const show = parseShowControl(JSON.parse(source));
    if (show.show_id !== validateId(showMatch[1]!, "show")) throw new Error("Public Show source does not match its key");
    return { castloop_delivery: "show-v1", castloop_show_id: show.show_id,
      castloop_visibility: visibility(show.lifecycle), castloop_show_generation: String(show.generation),
      castloop_feed_generation: String(show.feed_generation) };
  }
  const episodeMatch = /^system\/episode-lifecycle\/([^/]+)\/([^/]+)\.toml$/.exec(key);
  if (episodeMatch) {
    const episode = parseEpisodeLifecycle(source);
    if (episode.show_id !== validateId(episodeMatch[1]!, "show") || episode.episode_id !== validateId(episodeMatch[2]!, "episode")) {
      throw new Error("Public Episode source does not match its key");
    }
    return { castloop_delivery: "episode-v1", castloop_show_id: episode.show_id, castloop_episode_id: episode.episode_id,
      castloop_visibility: visibility(episode.lifecycle), castloop_episode_generation: String(episode.generation) };
  }
  throw new Error("Unknown public delivery source key");
}

function visibility(state: string): "public" | "not_found" | "gone" {
  return state === "active" ? "public" : state === "deleting" || state === "deleted" ? "gone" : "not_found";
}

export async function putPublicDeliveryRecord(env: DeliveryWriteEnv, key: string, source: string,
  options: R2PutOptions): Promise<R2Object | null> {
  const conditional = options.onlyIf instanceof Headers ? options.onlyIf.get("If-None-Match") === "*" :
    typeof options.onlyIf?.etagMatches === "string" && options.onlyIf.etagMatches.length > 0;
  if (!conditional) throw new Error("Public delivery records require a conditional ETag or create-only write");
  return await env.CASTLOOP_BUCKET.put(key, source, { ...options,
    customMetadata: { ...options.customMetadata, ...publicDeliveryMetadata(key, source) } });
}

export async function preparePublicDeliveryConfiguration(env: { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "put"> },
  serviceId: string, expectedEtag?: string): Promise<void> {
  const key = "system/service.toml";
  const object = await env.CASTLOOP_BUCKET.get(key);
  if (!object || object.size < 1 || object.size > MAX_RECORD_BYTES) throw new Error("Public delivery configuration is missing or oversized");
  if (expectedEtag !== undefined && object.etag !== expectedEtag) throw new Error("Public delivery configuration changed after runtime verification");
  const source = await object.text();
  const metadata = publicDeliveryMetadata(key, source);
  if (metadata.castloop_service_id !== serviceId) throw new Error("Public delivery configuration belongs to another service");
  if (Object.entries(metadata).every(([name, value]) => object.customMetadata?.[name] === value)) return;
  if (!await putPublicDeliveryRecord(env, key, source, { onlyIf: { etagMatches: object.etag },
    httpMetadata: object.httpMetadata, customMetadata: object.customMetadata })) {
    throw new Error("Public delivery configuration changed during preparation");
  }
}

export async function preparePublicDeliveryControls(env: DeliveryPrepareEnv, checkOwner: () => Promise<void>): Promise<void> {
  for (const prefix of ["system/show-publications/", "system/episode-lifecycle/"]) {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    let count = 0;
    do {
      await checkOwner();
      const page = await env.CASTLOOP_BUCKET.list({ prefix, cursor, limit: 100 });
      for (const listed of page.objects) {
        if (++count > 100000 || !listed.key.startsWith(prefix)) throw new Error("Public delivery preparation exceeds its inventory budget");
        const object = await env.CASTLOOP_BUCKET.get(listed.key);
        if (!object || object.size < 1 || object.size > MAX_RECORD_BYTES || object.etag !== listed.etag) {
          throw new Error("Public delivery source changed during preparation");
        }
        const source = await object.text();
        const metadata = publicDeliveryMetadata(listed.key, source);
        if (Object.entries(metadata).every(([name, value]) => object.customMetadata?.[name] === value)) continue;
        await checkOwner();
        if (!await putPublicDeliveryRecord(env, listed.key, source, { onlyIf: { etagMatches: object.etag },
          httpMetadata: object.httpMetadata, customMetadata: object.customMetadata })) {
          throw new Error("Public delivery control changed during preparation");
        }
      }
      if (!page.truncated) break;
      if (!page.cursor || cursors.has(page.cursor)) throw new Error("Public delivery preparation cursor did not advance");
      cursors.add(page.cursor);
      cursor = page.cursor;
    } while (true);
  }
  await checkOwner();
}
