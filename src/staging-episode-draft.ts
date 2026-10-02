import { episodeLifecycleSchema, stageControlRequest, stringifyLifecycleToml } from "../packages/shared/src/index";
import type { StageUploadRequest } from "../packages/shared/src/index";
import { controlRequestHash, readEpisodeLifecycle, requireOwnedOperation } from "./lifecycle-control";
import type { LifecycleControlEnv } from "./lifecycle-control";

export type StageEpisodeDraftEnv = LifecycleControlEnv & { CASTLOOP_BUCKET: Pick<R2Bucket, "list"> };

async function requireUnusedEpisodePaths(env: StageEpisodeDraftEnv, request: StageUploadRequest): Promise<void> {
  const prefixes = [
    `public/episodes/${request.show_id}/${request.episode_id}/`,
    `public/podcasts/${request.show_id}/episodes/${request.episode_id}/`,
    `staging/episodes/${request.show_id}/${request.episode_id}/`,
  ];
  for (const prefix of prefixes) {
    const page = await env.CASTLOOP_BUCKET.list({ prefix, limit: 1 });
    if (page.objects.length || page.truncated) throw new Error("New Episode ID has existing data; inspect it without overwriting");
  }
}

export async function prepareNewEpisodeDraft(env: StageEpisodeDraftEnv, request: StageUploadRequest): Promise<boolean> {
  if (request.kind !== "episode" || await readEpisodeLifecycle(env, request.show_id, request.episode_id!)) return false;
  if (request.expected_episode_generation !== 0) throw new Error("New Episode staging requires generation zero");
  await requireUnusedEpisodePaths(env, request);
  return true;
}

async function requireInitializationOwner(env: StageEpisodeDraftEnv, request: StageUploadRequest): Promise<void> {
  const current = await requireOwnedOperation(env, request.show_id, request.operation_id, request.expected_show_generation + 1);
  const owner = current.value.owner;
  if (request.kind !== "episode" || request.expected_episode_generation !== 0 || current.value.lifecycle !== "active" ||
    owner.action !== "stage" || owner.state !== "uploading" || owner.kind !== "episode" || owner.episode_id !== request.episode_id ||
    owner.verification_id || owner.request_sha256 !== await controlRequestHash(stageControlRequest(request))) {
    throw new Error("Episode draft initialization requires its exact active Show staging owner");
  }
}

export async function initializeOwnedEpisodeDraft(env: StageEpisodeDraftEnv, request: StageUploadRequest): Promise<void> {
  await requireInitializationOwner(env, request);
  const initial = episodeLifecycleSchema.parse({ schema_version: 1, show_id: request.show_id,
    episode_id: request.episode_id, lifecycle: "draft", generation: 0 });
  const existing = await readEpisodeLifecycle(env, request.show_id, request.episode_id!);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(initial)) throw new Error("Episode lifecycle cannot be reinitialized");
    await requireInitializationOwner(env, request);
    return;
  }
  if (await env.CASTLOOP_BUCKET.head(`system/jobs/${request.operation_id}/upload-progress.json`)) {
    throw new Error("Staging progress exists without its Episode lifecycle; do not recreate it");
  }
  await requireUnusedEpisodePaths(env, request);
  await requireInitializationOwner(env, request);
  const key = `system/episode-lifecycle/${request.show_id}/${request.episode_id}.toml`;
  const written = await env.CASTLOOP_BUCKET.put(key, stringifyLifecycleToml(initial), { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (!written && JSON.stringify(await readEpisodeLifecycle(env, request.show_id, request.episode_id!)) !== JSON.stringify(initial)) {
    throw new Error("Episode lifecycle initialization conflicted; retained Show ownership must be inspected");
  }
  await requireInitializationOwner(env, request);
}
