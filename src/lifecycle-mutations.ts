import { parseControlRequest, parseEpisodeLifecycle, parseShowControl, permitsControlAction,
  stringifyLifecycleToml } from "../packages/shared/src/index";
import type { EpisodeLifecycle } from "../packages/shared/src/index";
import { requireShowExecution } from "./lifecycle-control";
import type { LifecycleControlEnv, ShowExecution } from "./lifecycle-control";

export async function closeOwnedLifecycleTarget(env: LifecycleControlEnv, execution: ShowExecution): Promise<void> {
  const current = await requireShowExecution(env, execution);
  const owner = current.value.owner!;
  if (owner.action !== "unpublish" && owner.action !== "delete") throw new Error("Operation cannot close public delivery");
  const state = owner.action === "delete" ? "deleting" : "unpublished";
  if (owner.kind === "show") {
    if (current.value.lifecycle === state) return;
    if (!permitsControlAction(current.value.lifecycle, owner.action)) throw new Error("Show changed before closing delivery");
    const value = parseShowControl({ ...current.value, lifecycle: state });
    const written = await env.CASTLOOP_BUCKET.put(`system/show-publications/${execution.showId}.json`, JSON.stringify(value), {
      onlyIf: { etagMatches: current.etag },
    });
    if (!written) throw new Error("Show control changed before closing delivery");
    return;
  }
  const frozen = await env.CASTLOOP_BUCKET.get(`system/jobs/${execution.jobId}/request.toml`);
  if (!frozen || frozen.size > 16384) throw new Error("Frozen lifecycle request is missing or oversized");
  const request = parseControlRequest(await frozen.text());
  const key = `system/episode-lifecycle/${execution.showId}/${owner.episode_id}.toml`;
  const object = await env.CASTLOOP_BUCKET.get(key);
  if (!object || object.size > 16384) throw new Error("Episode lifecycle is missing or oversized");
  const episode = parseEpisodeLifecycle(await object.text());
  if (episode.show_id !== execution.showId || episode.episode_id !== owner.episode_id) throw new Error("Episode lifecycle does not match its target");
  if (episode.lifecycle === state && episode.last_job_id === execution.jobId &&
    episode.generation === request.expected_episode_generation! + 1) return;
  if (!permitsControlAction(episode.lifecycle, owner.action) || episode.generation !== request.expected_episode_generation ||
    episode.generation === Number.MAX_SAFE_INTEGER) throw new Error("Episode changed before closing delivery");
  const value: EpisodeLifecycle = { ...episode, lifecycle: state, generation: episode.generation + 1, last_job_id: execution.jobId };
  const written = await env.CASTLOOP_BUCKET.put(key, stringifyLifecycleToml(value), { onlyIf: { etagMatches: object.etag } });
  if (!written) throw new Error("Episode lifecycle changed before closing delivery");
}

export async function advanceLifecycleFeedGeneration(env: LifecycleControlEnv, execution: ShowExecution): Promise<void> {
  const current = await requireShowExecution(env, execution);
  if (current.value.last_feed_job_id === execution.jobId) return;
  if (current.value.feed_generation === Number.MAX_SAFE_INTEGER) throw new Error("Feed generation is exhausted");
  const value = parseShowControl({ ...current.value, feed_generation: current.value.feed_generation + 1,
    last_feed_job_id: execution.jobId });
  const written = await env.CASTLOOP_BUCKET.put(`system/show-publications/${execution.showId}.json`, JSON.stringify(value), {
    onlyIf: { etagMatches: current.etag },
  });
  if (!written) throw new Error("Show control changed before feed generation advanced");
}
