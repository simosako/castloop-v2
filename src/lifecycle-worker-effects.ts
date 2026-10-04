import { episodeRevisionSchema, parseLifecycleCommitKey,
  serviceConfigSchema, showMetadataSchema } from "../packages/shared/src/index";
import type { EpisodeRevision } from "../packages/shared/src/index";
import { readLifecycleCommit } from "./lifecycle-commit";
import { readPublicVisibility, readShowControl, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import type { LifecyclePurgeTarget } from "./lifecycle-cache";
import type { LifecycleConsumerEffects } from "./lifecycle-consumer";
import type { LifecycleDeleteEnv } from "./lifecycle-delete-batch";
import { readLifecycleFeedInputs, readPublishedFeedSource, writePublishedFeed } from "./lifecycle-feed";
import type { RestoreFeedSnapshot } from "./lifecycle-restore";
import type { ShowPublicationEffects } from "./publication-show-runner";
import type { PublicationEffects } from "./publication-inputs";

export type LifecycleWorkerBindings = {
  cachedAssets: { invalidate: (target: LifecyclePurgeTarget) => Promise<void> };
  queue: Pick<Queue, "send">;
  checkDeliveryGate: (target: LifecyclePurgeTarget) => Promise<void>;
};

export async function createShowPublicationWorkerEffects(env: LifecycleDeleteEnv, execution: ShowExecution,
  bindings: Pick<LifecycleWorkerBindings, "cachedAssets" | "checkDeliveryGate">): Promise<ShowPublicationEffects> {
  const current = await requireShowExecution(env, execution);
  if (current.value.owner?.action !== "publish" || current.value.owner.kind !== "show") throw new Error("Show publication effects require a Show publish owner");
  return createPublicationWorkerEffects(env, execution, bindings);
}

export async function createPublicationWorkerEffects(env: LifecycleDeleteEnv, execution: ShowExecution,
  bindings: Pick<LifecycleWorkerBindings, "cachedAssets" | "checkDeliveryGate">): Promise<PublicationEffects> {
  const current = await requireShowExecution(env, execution);
  if (current.value.owner?.action !== "publish") throw new Error("Publication effects require a publish owner");
  const target = { showId: execution.showId, ...(current.value.owner.episode_id ? { episodeId: current.value.owner.episode_id } : {}) };
  async function guard(input: { showId: string; episodeId?: string }): Promise<void> {
    if (input.showId !== target.showId || input.episodeId !== target.episodeId) throw new Error("Publication effect targets another operation");
    await requireShowExecution(env, execution);
    await bindings.checkDeliveryGate(target);
    await requireShowExecution(env, execution);
  }
  await guard(target);
  return { checkDeliveryGate: guard, async purge(input) {
    await guard(input);
    await bindings.cachedAssets.invalidate(target);
    await requireShowExecution(env, execution);
  } };
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
    const source = await readPublishedFeedSource(env, execution.showId);
    if (restoring && (JSON.stringify(showMetadataSchema.parse(restoring.show)) !== JSON.stringify(source.show) ||
      JSON.stringify(serviceConfigSchema.parse(restoring.service)) !== JSON.stringify(source.service) || restoring.coverExtension !== source.coverExtension)) {
      throw new Error("Restore snapshots changed before feed writing");
    }
    await writePublishedFeed(env, source, episodes, guard);
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
