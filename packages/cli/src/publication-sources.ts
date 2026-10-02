import { episodeDraftFromRevision, episodeRevisionSchema, parseEpisodeDraft, parseShowMetadata } from "@castloop/shared";
import type { EpisodeRevision, ServiceConfig, StageAsset, StagePayload } from "@castloop/shared";
import { createPublicationOperationEffects } from "./publication-operation";
import type { PublicationOperationEffects } from "./publication-operation";
import { validatePublicationClientState } from "./publication-journal";
import type { PublicationClientState } from "./publication-journal";
import type { PublicationAdminClient } from "./publication-client";
import { validateStagingClientState } from "./staging-journal";
import type { StagingClientState } from "./staging-journal";
import { assertLocalStagingSource } from "./staging-sources";
import { readLocalMetadata } from "./local-metadata-read";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

export type LocalPublicationInputs = {
  stages: readonly StagingClientState[];
  metadataPath: string;
  coverPath?: string;
  audioPath?: string;
  baseRevision?: EpisodeRevision;
};

export function createLocalPublicationEffects(config: ServiceConfig, input: PublicationClientState, adminKey: string,
  local: LocalPublicationInputs, client?: Pick<PublicationAdminClient, "claim" | "commit" | "retry" | "status">): PublicationOperationEffects {
  const state = validatePublicationClientState(input);
  const effects = createPublicationOperationEffects(config, state, adminKey, client);
  const frozen = state.publication;
  const commit = frozen.commit;
  const stages = local.stages.map((value) => validateStagingClientState(value));
  if (stages.length !== frozen.staged_uploads.length || new Set(stages.map((stage) => stage.upload.operation_id)).size !== stages.length) {
    throw new Error("Local publication requires exactly its acknowledged staging operations");
  }
  const expected = new Map<StageAsset, { hash: string; length?: number }>();
  if (commit.kind === "show") {
    expected.set("show_metadata", { hash: commit.metadata_sha256 });
    expected.set(`cover_${commit.cover_extension}`, { hash: commit.cover_sha256 });
  } else {
    if (commit.metadata_sha256) expected.set("episode_metadata", { hash: commit.metadata_sha256 });
    if (commit.audio_sha256) expected.set("audio", { hash: commit.audio_sha256, length: commit.audio_length_bytes });
  }
  const checked = new Map<StageAsset, StagePayload>();
  for (const stage of stages) {
    const upload = stage.upload;
    if (JSON.stringify(stage.identity) !== JSON.stringify(state.identity) || stage.phase !== "finished" || stage.finish_receipt !== "staged" ||
      !frozen.staged_uploads.includes(upload.operation_id) || upload.draft_job_id !== commit.job_id || upload.show_id !== commit.show_id ||
      upload.kind !== commit.kind || upload.episode_id !== frozen.request.episode_id ||
      upload.expected_episode_generation !== frozen.request.expected_episode_generation || upload.expected_show_generation + 1 > frozen.request.expected_show_generation) {
      throw new Error("Local staging receipt differs from the publication service, target, draft or generation");
    }
    for (const payload of upload.payloads) {
      const wanted = expected.get(payload.asset);
      if (!wanted || checked.has(payload.asset) || payload.sha256 !== wanted.hash || wanted.length !== undefined && payload.length_bytes !== wanted.length) {
        throw new Error("Local staged payload differs from its frozen publication checksum/size");
      }
      checked.set(payload.asset, payload);
    }
  }
  if (checked.size !== expected.size) throw new Error("Local publication staging evidence is incomplete");
  const metadataPath = resolve(local.metadataPath);
  const coverPath = local.coverPath !== undefined ? resolve(local.coverPath) : undefined;
  const audioPath = local.audioPath !== undefined ? resolve(local.audioPath) : undefined;
  if ((commit.kind === "show") !== (coverPath !== undefined) || (checked.has("audio")) !== (audioPath !== undefined)) {
    throw new Error("Local publication source paths must match its changed assets exactly");
  }
  const base = local.baseRevision !== undefined ? episodeRevisionSchema.parse(local.baseRevision) : undefined;
  if (commit.kind === "show" ? base !== undefined : Boolean(commit.base_revision_id) !== Boolean(base) ||
    base && (base.revision_id !== commit.base_revision_id || base.episode_id !== commit.episode_id)) {
    throw new Error("Local publication base revision differs from its frozen manifest");
  }
  return { ...effects, checkLocalInputs: async () => {
    const bytes = await readLocalMetadata(metadataPath);
    const metadataAsset = checked.get(commit.kind === "show" ? "show_metadata" : "episode_metadata");
    if (metadataAsset && (bytes.length !== metadataAsset.length_bytes || createHash("sha256").update(bytes).digest("hex") !== metadataAsset.sha256)) {
      throw new Error("Local metadata differs from its staged draft; explicitly stage the latest edit before publication");
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (commit.kind === "show") {
      const metadata = parseShowMetadata(text);
      if (metadata.show_id !== commit.show_id || resolve(dirname(metadataPath), metadata.image_path) !== coverPath) {
        throw new Error("Local Show metadata/cover source differs from its publication target");
      }
      await assertLocalStagingSource(coverPath!, checked.get(`cover_${commit.cover_extension}`)!);
    } else {
      const metadata = parseEpisodeDraft(text);
      if (metadata.episode_id !== commit.episode_id || base && (metadata.guid !== base.guid || metadata.published_at !== base.published_at) ||
        !metadataAsset && (!base || JSON.stringify(metadata) !== JSON.stringify(episodeDraftFromRevision(base)))) {
        throw new Error("Local Episode metadata differs from its target, immutable identity or reused base; explicitly stage the edit");
      }
      if (audioPath) await assertLocalStagingSource(audioPath, checked.get("audio")!);
    }
    if (!bytes.equals(await readLocalMetadata(metadataPath))) throw new Error("Local metadata changed while publication media were being validated");
  } };
}
