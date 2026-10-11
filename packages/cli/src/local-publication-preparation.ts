import { episodeRevisionSchema, parseShowMetadata, publicationRequestSchema, serviceConfigSchema, serviceOperationIdentity } from "@castloop/shared";
import type { EpisodeRevision, PublicationRequest, ServiceConfig, StageAsset, StagePayload } from "@castloop/shared";
import { analyzeAudio } from "./audio";
import { readLocalMetadata } from "./local-metadata-read";
import type { PublicationAdminClient } from "./publication-client";
import { createPublicationJournal, readLocalPublicationJob, validatePublicationClientState } from "./publication-journal";
import type { PublicationJournal } from "./publication-journal";
import type { PublicationOperationEffects } from "./publication-operation";
import { createLocalPublicationEffects } from "./publication-sources";
import type { LocalPublicationInputs } from "./publication-sources";
import { readLocalStagingOperation } from "./staging-journal";
import { assertLocalStagingSource } from "./staging-sources";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

export type LocalPublicationPreparation = {
  stagedOperationIds: readonly string[];
  audioPath?: string;
  baseRevision?: EpisodeRevision;
};
export type PreparedLocalPublication = { journal: PublicationJournal; effects: PublicationOperationEffects; local: LocalPublicationInputs };

export async function prepareLocalPublication(root: string, configInput: ServiceConfig, requestInput: PublicationRequest["request"],
  input: LocalPublicationPreparation, adminKey: string,
  client?: Pick<PublicationAdminClient, "claim" | "commit" | "retry" | "status">): Promise<PreparedLocalPublication> {
  const config = serviceConfigSchema.parse(configInput);
  const request = publicationRequestSchema.shape.request.parse(requestInput);
  if (request.action !== "publish") throw new Error("Local publication preparation requires a publish request");
  const ids = [...input.stagedOperationIds].sort();
  if (ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length) throw new Error("Publication requires one or two distinct acknowledged uploads");
  const existing = readLocalPublicationJob(root, config, request.job_id);
  if (existing.lock_present || existing.client_state && existing.client_state.phase !== "prepared") {
    throw new Error("Publication preparation cannot reopen a requested job or a retained client lock");
  }
  const snapshots = ids.map((id) => readLocalStagingOperation(root, config, id));
  const stages = snapshots.map((snapshot) => {
    if (snapshot.lock_present || snapshot.client_state?.phase !== "finished" || snapshot.client_state.finish_receipt !== "staged") {
      throw new Error("Publication requires finished staged local receipts without a retained upload lock");
    }
    return snapshot.client_state;
  });
  const payloads = new Map<StageAsset, StagePayload>();
  for (const stage of stages) for (const payload of stage.upload.payloads) {
    if (payloads.has(payload.asset)) throw new Error("Publication cannot combine duplicate staged assets");
    payloads.set(payload.asset, payload);
  }
  for (const directory of [root, join(root, request.show_id)]) {
    if (!(await lstat(directory)).isDirectory()) throw new Error("Local publication parents must be real directories, not symlinks");
  }
  const directory = resolve(root, request.show_id);
  const local: LocalPublicationInputs = { stages, metadataPath: join(directory,
    request.kind === "show" ? "show.toml" : `episode-${request.episode_id}.toml`) };
  const base = input.baseRevision ? episodeRevisionSchema.parse(input.baseRevision) : undefined;
  let commit: PublicationRequest["commit"];
  if (request.kind === "show") {
    if (base || input.audioPath !== undefined) throw new Error("Show publication cannot adopt Episode base or audio inputs");
    const metadata = payloads.get("show_metadata");
    const cover = payloads.get("cover_jpg") ?? payloads.get("cover_png");
    if (!metadata || !cover || payloads.size !== 2) throw new Error("Show publication requires its exact staged metadata and cover");
    const show = parseShowMetadata(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readLocalMetadata(local.metadataPath)));
    local.coverPath = join(directory, show.image_path);
    commit = { schema_version: 1, kind: "show", show_id: request.show_id, job_id: request.job_id,
      metadata_sha256: metadata.sha256, cover_sha256: cover.sha256, cover_extension: cover.asset === "cover_png" ? "png" : "jpg" };
  } else {
    const metadata = payloads.get("episode_metadata");
    const audio = payloads.get("audio");
    if (payloads.size !== Number(!!metadata) + Number(!!audio)) throw new Error("Episode publication contains another target's assets");
    if (!!audio !== (input.audioPath !== undefined)) throw new Error("Changed audio requires exactly its current source path");
    let duration: number | undefined;
    if (audio) {
      local.audioPath = resolve(directory, input.audioPath!);
      await assertLocalStagingSource(local.audioPath, audio);
      const analysis = await analyzeAudio(local.audioPath);
      if (analysis.length !== audio.length_bytes) throw new Error("Publication audio changed during duration analysis");
      duration = analysis.duration;
    }
    if (base) local.baseRevision = base;
    commit = { schema_version: 1, kind: "episode", show_id: request.show_id, episode_id: request.episode_id!, job_id: request.job_id,
      ...(base ? { base_revision_id: base.revision_id } : {}), ...(metadata ? { metadata_sha256: metadata.sha256 } : {}),
      ...(audio ? { audio_sha256: audio.sha256, audio_length_bytes: audio.length_bytes, duration_seconds: duration } : {}),
      committed_at: request.created_at };
  }
  const publication = publicationRequestSchema.parse({ schema_version: 1, request, commit, staged_uploads: ids });
  const prepared = validatePublicationClientState({ schema_version: 1, identity: serviceOperationIdentity(config), publication, phase: "prepared",
    manifest_sha256: createHash("sha256").update(JSON.stringify(publication)).digest("hex") });
  const guarded = createLocalPublicationEffects(config, prepared, adminKey, local, client);
  const checkStages = () => {
    for (let index = 0; index < ids.length; index++) {
      if (JSON.stringify(readLocalStagingOperation(root, config, ids[index]!)) !== JSON.stringify(snapshots[index])) {
        throw new Error("Acknowledged local staging records or lock observations changed before publication");
      }
    }
  };
  const checkLocalInputs = async () => { checkStages(); await guarded.checkLocalInputs!(); checkStages(); };
  await checkLocalInputs();
  const journal = createPublicationJournal(root, config, publication);
  const current = readLocalPublicationJob(root, config, request.job_id);
  if (current.lock_present || journal.load().phase !== "prepared") throw new Error("Publication job changed while its local inputs were prepared");
  return { journal, effects: { ...guarded, checkLocalInputs }, local };
}
