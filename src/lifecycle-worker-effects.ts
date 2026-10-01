import { episodeRevisionSchema, parseLifecycleCommitKey, parseServiceConfig, parseShowMetadata,
  serviceConfigSchema, showMetadataSchema } from "../packages/shared/src/index";
import type { EpisodeRevision, ServiceConfig, ShowMetadata } from "../packages/shared/src/index";
import { renderFeed } from "./feed";
import { readLifecycleCommit } from "./lifecycle-commit";
import { readPublicVisibility, readShowControl, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import type { LifecyclePurgeTarget } from "./lifecycle-cache";
import type { LifecycleConsumerEffects } from "./lifecycle-consumer";
import type { LifecycleDeleteEnv } from "./lifecycle-delete-batch";
import { readLifecycleFeedInputs } from "./lifecycle-feed";
import type { RestoreFeedSnapshot } from "./lifecycle-restore";

export type LifecycleWorkerBindings = {
  cachedAssets: { invalidate: (target: LifecyclePurgeTarget) => Promise<void> };
  queue: Pick<Queue, "send">;
  checkDeliveryGate: (target: LifecyclePurgeTarget) => Promise<void>;
};
type PublishedFeedSource = {
  show: ShowMetadata; service: ServiceConfig; coverExtension: "jpg" | "png";
  objects: Array<{ key: string; etag: string; size: number }>;
};

async function publishedFeedSource(env: LifecycleDeleteEnv, execution: ShowExecution): Promise<PublishedFeedSource> {
  await requireShowExecution(env, execution);
  const showKey = `system/shows/${execution.showId}/show.toml`;
  const serviceKey = "system/service.toml";
  const showObject = await env.CASTLOOP_BUCKET.get(showKey);
  const serviceObject = await env.CASTLOOP_BUCKET.get(serviceKey);
  if (!showObject || showObject.size < 1 || showObject.size > 1_000_000 ||
    !serviceObject || serviceObject.size < 1 || serviceObject.size > 16384) throw new Error("Published feed snapshots are missing or oversized");
  const show = parseShowMetadata(await showObject.text());
  const service = parseServiceConfig(await serviceObject.text());
  if (show.show_id !== execution.showId) throw new Error("Published feed Show does not match its owner");
  const coverExtension = show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
  const coverKey = `public/podcasts/${execution.showId}/cover.${coverExtension}`;
  const cover = await env.CASTLOOP_BUCKET.head(coverKey);
  if (!cover || !Number.isSafeInteger(cover.size) || cover.size < 1 || cover.size > 5_000_000) throw new Error("Published feed cover is missing or oversized");
  await requireShowExecution(env, execution);
  return { show, service, coverExtension, objects: [{ key: showKey, etag: showObject.etag, size: showObject.size },
    { key: serviceKey, etag: serviceObject.etag, size: serviceObject.size }, { key: coverKey, etag: cover.etag, size: cover.size }] };
}

function sameEpisodes(left: EpisodeRevision[], right: EpisodeRevision[]): boolean {
  const ordered = (episodes: EpisodeRevision[]) => episodes.toSorted((a, b) => a.episode_id.localeCompare(b.episode_id));
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
}

export async function createLifecycleWorkerEffects(env: LifecycleDeleteEnv, execution: ShowExecution,
  bindings: LifecycleWorkerBindings): Promise<LifecycleConsumerEffects> {
  const initial = await requireShowExecution(env, execution);
  const owner = initial.value.owner!;
  if (!["unpublish", "restore", "delete"].includes(owner.action)) throw new Error("Worker effects require a lifecycle operation");
  const target: LifecyclePurgeTarget = { showId: execution.showId, ...(owner.episode_id ? { episodeId: owner.episode_id } : {}) };

  async function guard(input: LifecyclePurgeTarget = target): Promise<void> {
    if (input.showId !== target.showId || input.episodeId !== target.episodeId) throw new Error("Lifecycle effect targets another operation");
    await requireShowExecution(env, execution);
    await bindings.checkDeliveryGate(target);
    await requireShowExecution(env, execution);
  }

  async function writeFeed(input: EpisodeRevision[], restoring?: RestoreFeedSnapshot): Promise<void> {
    await guard();
    const current = await requireShowExecution(env, execution);
    if (owner.action === "restore" ? !restoring : current.value.lifecycle !== "active" || owner.kind !== "episode") {
      throw new Error("This lifecycle operation cannot write a public feed");
    }
    const episodes = input.map((episode) => episodeRevisionSchema.parse(episode));
    const eligible = await readLifecycleFeedInputs(env, execution);
    if (!eligible.writeFeed || !sameEpisodes(episodes, eligible.episodes)) throw new Error("Lifecycle feed input no longer matches saved snapshots");
    const source = await publishedFeedSource(env, execution);
    if (restoring && (JSON.stringify(showMetadataSchema.parse(restoring.show)) !== JSON.stringify(source.show) ||
      JSON.stringify(serviceConfigSchema.parse(restoring.service)) !== JSON.stringify(source.service) || restoring.coverExtension !== source.coverExtension)) {
      throw new Error("Restore snapshots changed before feed writing");
    }
    const sourceBytes = new TextEncoder().encode(JSON.stringify({ show: source.show, episodes, baseUrl: source.service.public_base_url })).byteLength;
    if (sourceBytes * 6 + episodes.length * 1024 + 4096 > 32_000_000) throw new Error("Lifecycle feed exceeds its conservative rendering budget");
    const feed = renderFeed(source.show, episodes, source.service.public_base_url, source.coverExtension);
    const key = `public/podcasts/${execution.showId}/feed.xml`;
    const previous = await env.CASTLOOP_BUCKET.head(key);
    for (const object of source.objects) {
      const latest = await env.CASTLOOP_BUCKET.head(object.key);
      if (!latest || latest.etag !== object.etag || latest.size !== object.size) throw new Error("Published feed snapshots changed before writing");
    }
    await guard();
    const written = await env.CASTLOOP_BUCKET.put(key, feed, {
      onlyIf: previous ? { etagMatches: previous.etag } : new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "application/rss+xml; charset=utf-8" },
    });
    if (!written) throw new Error("Lifecycle feed changed before writing");
    await requireShowExecution(env, execution);
  }

  async function purge(input: LifecyclePurgeTarget): Promise<void> {
    await guard(input);
    await bindings.cachedAssets.invalidate(target);
    await requireShowExecution(env, execution);
  }

  await guard();
  return {
    unpublish: { writeFeed, purge },
    restore: { writeFeed: (snapshot) => writeFeed(snapshot.episodes, snapshot), purge, checkDeliveryGate: guard },
    delete: { writeFeed, purge, async checkDelivery(input) {
      if (input.kind !== owner.kind) throw new Error("Deletion delivery check targets another operation");
      await guard(input);
      if (owner.action !== "delete" || await readPublicVisibility(env, target.showId, target.episodeId) !== "gone") {
        throw new Error("Deletion delivery does not confirm a closed deleting target");
      }
      await requireShowExecution(env, execution);
    } },
    async sendContinuation(key) {
      const delivery = parseLifecycleCommitKey(key);
      if (!delivery || delivery.show_id !== execution.showId || delivery.job_id !== execution.jobId ||
        delivery.kind !== owner.kind || delivery.episode_id !== owner.episode_id) throw new Error("Lifecycle continuation does not match its operation");
      const marker = await readLifecycleCommit(env, key);
      const current = await readShowControl(env, execution.showId);
      if (!marker || owner.action !== "delete" || marker.action !== owner.action || marker.show_generation !== execution.generation ||
        marker.request_sha256 !== owner.request_sha256 || current?.value.generation !== execution.generation ||
        current.value.owner?.job_id !== execution.jobId || current.value.owner.request_sha256 !== owner.request_sha256) {
        throw new Error("Lifecycle continuation no longer owns its frozen operation");
      }
      await bindings.checkDeliveryGate(target);
      await bindings.queue.send({ object: { key } });
    },
  };
}
