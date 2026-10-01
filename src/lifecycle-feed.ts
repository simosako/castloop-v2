import { episodeRevisionSchema, parseEpisodeRevision, validateId } from "../packages/shared/src/index";
import type { EpisodeRevision } from "../packages/shared/src/index";
import { readEpisodeLifecycle, requireShowExecution } from "./lifecycle-control";
import type { LifecycleControlEnv, ShowExecution } from "./lifecycle-control";
import { canonicalEnclosureUrl } from "./media-url";
import { parsePublicAssetPath } from "./public-assets";

export type LifecycleFeedEnv = LifecycleControlEnv & { CASTLOOP_BUCKET: Pick<R2Bucket, "get" | "put" | "head" | "list"> };
export type LifecycleFeedInputs = { writeFeed: boolean; episodes: EpisodeRevision[] };

async function listedObjects(env: LifecycleFeedEnv, prefix: string, maximum: number): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.CASTLOOP_BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) {
      if (!object.key.startsWith(prefix) || seen.has(object.key)) throw new Error("Inconsistent lifecycle feed inventory");
      seen.add(object.key);
      objects.push(object);
      if (objects.length > maximum) throw new Error("Lifecycle feed inventory exceeds the object limit");
    }
    if (!page.truncated) break;
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("Lifecycle feed inventory cursor did not advance");
    cursors.add(page.cursor);
    cursor = page.cursor;
  } while (true);
  return objects;
}

export async function readLifecycleFeedInputs(env: LifecycleFeedEnv, execution: ShowExecution,
  options: { candidate?: EpisodeRevision; maximumObjects?: number; maximumMetadataBytes?: number } = {}): Promise<LifecycleFeedInputs> {
  const maximumObjects = options.maximumObjects ?? 10000;
  const maximumMetadataBytes = options.maximumMetadataBytes ?? 8_000_000;
  if (!Number.isSafeInteger(maximumObjects) || maximumObjects < 1 || maximumObjects > 100000 ||
    !Number.isSafeInteger(maximumMetadataBytes) || maximumMetadataBytes < 1 || maximumMetadataBytes > 32_000_000) {
    throw new Error("Invalid lifecycle feed inventory limits");
  }
  const snapshot = await requireShowExecution(env, execution);
  const owner = snapshot.value.owner!;
  if (owner.action === "stage") throw new Error("Staging cannot generate a public feed");
  let candidate: EpisodeRevision | undefined;
  if (options.candidate) {
    candidate = episodeRevisionSchema.parse(options.candidate);
    if (owner.action !== "publish" || owner.kind !== "episode" || owner.episode_id !== candidate.episode_id) {
      throw new Error("Feed candidate does not match the publication owner");
    }
  }
  if (owner.kind === "episode" && owner.action === "publish" && !candidate) {
    throw new Error("Episode publication requires its validated feed candidate");
  }
  if (candidate && new TextEncoder().encode(JSON.stringify(candidate)).length > maximumMetadataBytes) {
    throw new Error("Feed candidate exceeds the metadata budget");
  }
  const restoringShow = owner.kind === "show" && owner.action === "restore" && snapshot.value.lifecycle === "unpublished";
  const publishingShow = owner.kind === "show" && owner.action === "publish" && snapshot.value.lifecycle === "draft";
  if ((owner.kind === "show" && (owner.action === "unpublish" || owner.action === "delete")) ||
    !(snapshot.value.lifecycle === "active" || restoringShow || publishingShow)) {
    return { writeFeed: false, episodes: [] };
  }
  const metadataPrefix = `public/episodes/${execution.showId}/`;
  const lifecyclePrefix = `system/episode-lifecycle/${execution.showId}/`;
  const metadata = new Map<string, R2Object>();
  const episodeIds = new Set<string>();
  for (const object of await listedObjects(env, metadataPrefix, maximumObjects)) {
    const relative = object.key.slice(metadataPrefix.length).split("/");
    if (relative.at(-1) !== "metadata.toml") continue;
    if (relative.length !== 2) throw new Error("Invalid current Episode metadata key");
    const episodeId = validateId(relative[0], "episode");
    metadata.set(episodeId, object);
    episodeIds.add(episodeId);
  }
  for (const object of await listedObjects(env, lifecyclePrefix, maximumObjects)) {
    const name = object.key.slice(lifecyclePrefix.length);
    if (!name.endsWith(".toml") || name.includes("/")) throw new Error("Invalid Episode lifecycle inventory key");
    episodeIds.add(validateId(name.slice(0, -5), "episode"));
  }
  if (owner.kind === "episode") episodeIds.add(owner.episode_id!);
  if (episodeIds.size > maximumObjects) throw new Error("Lifecycle feed exceeds the Episode limit");
  const episodes: EpisodeRevision[] = [];
  let metadataBytes = candidate ? new TextEncoder().encode(JSON.stringify(candidate)).length : 0;
  for (const episodeId of episodeIds) {
    const lifecycle = await readEpisodeLifecycle(env, execution.showId, episodeId);
    if (!lifecycle) throw new Error("Known Episode has no lifecycle record");
    const isTarget = owner.kind === "episode" && owner.episode_id === episodeId;
    if (isTarget && owner.action === "restore" && lifecycle.lifecycle !== "unpublished" &&
      !(lifecycle.lifecycle === "active" && lifecycle.last_job_id === execution.jobId)) {
      throw new Error("Restore target is no longer eligible for feed preparation");
    }
    if (isTarget && candidate && lifecycle.lifecycle !== "draft" && lifecycle.lifecycle !== "active") {
      throw new Error("Publication candidate cannot revive a stopped Episode");
    }
    if (isTarget && (owner.action === "unpublish" || owner.action === "delete")) continue;
    const restoringEpisode = isTarget && owner.action === "restore" && lifecycle.lifecycle === "unpublished";
    const publishingEpisode = isTarget && candidate && (lifecycle.lifecycle === "draft" || lifecycle.lifecycle === "active");
    if (lifecycle.lifecycle !== "active" && !restoringEpisode && !publishingEpisode) continue;
    let revision: EpisodeRevision;
    if (publishingEpisode) revision = candidate!;
    else {
      const listed = metadata.get(episodeId);
      if (!listed) throw new Error("Active or restoring Episode has no current metadata");
      if (!Number.isSafeInteger(listed.size) || listed.size < 1 || listed.size > 1_000_000) {
        throw new Error("Episode metadata exceeds the record limit");
      }
      metadataBytes += listed.size;
      if (metadataBytes > maximumMetadataBytes) throw new Error("Lifecycle feed exceeds the metadata budget");
      const object = await env.CASTLOOP_BUCKET.get(listed.key);
      if (!object || object.etag !== listed.etag || object.size !== listed.size) {
        throw new Error("Episode metadata changed during feed preparation");
      }
      revision = parseEpisodeRevision(await object.text());
      if (revision.episode_id !== episodeId) throw new Error("Episode metadata does not match its key");
    }
    const url = new URL(canonicalEnclosureUrl(revision, execution.showId, "https://feed-validation.invalid"));
    const asset = parsePublicAssetPath(url.pathname);
    if (asset?.kind !== "audio" || asset.showId !== execution.showId || asset.episodeId !== episodeId) {
      throw new Error("Episode has an invalid immutable audio reference");
    }
    const audio = await env.CASTLOOP_BUCKET.head(asset.key);
    if (!audio || audio.size !== revision.length_bytes) throw new Error("Episode audio is missing or its size changed");
    episodes.push(revision);
  }
  const current = await requireShowExecution(env, execution);
  if (current.etag !== snapshot.etag) throw new Error("Show control changed during feed preparation");
  return { writeFeed: true, episodes };
}
