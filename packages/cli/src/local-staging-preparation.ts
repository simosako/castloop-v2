import { z } from "zod";
import { parseEpisodeDraft, parseShowMetadata, stageUploadRequestSchema } from "@castloop/shared";
import type { ServiceConfig, StagePayload, StageUploadRequest } from "@castloop/shared";
import { analyzeAudio } from "./audio";
import { readLocalMetadata } from "./local-metadata-read";
import { createStagingJournal, readLocalStagingOperation } from "./staging-journal";
import type { StagingJournal } from "./staging-journal";
import { assertLocalStagingSource, freezeStagingSources, inspectLocalStagingSource } from "./staging-sources";
import type { FrozenStagingSources } from "./staging-sources";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

const selectionSchema = z.discriminatedUnion("asset", [
  z.object({ asset: z.literal("show") }).strict(),
  z.object({ asset: z.literal("episode_metadata") }).strict(),
  z.object({ asset: z.literal("audio"), audio_path: z.string().min(1) }).strict(),
]);
const requestSchema = z.object({ schema_version: stageUploadRequestSchema.shape.schema_version,
  operation_id: stageUploadRequestSchema.shape.operation_id, draft_job_id: stageUploadRequestSchema.shape.draft_job_id,
  show_id: stageUploadRequestSchema.shape.show_id, kind: stageUploadRequestSchema.shape.kind,
  episode_id: stageUploadRequestSchema.shape.episode_id, expected_show_generation: stageUploadRequestSchema.shape.expected_show_generation,
  expected_episode_generation: stageUploadRequestSchema.shape.expected_episode_generation, created_at: stageUploadRequestSchema.shape.created_at }).strict();

export type LocalStagingSelection = z.infer<typeof selectionSchema>;
export type PreparedLocalStagingUpload = {
  journal: StagingJournal;
  sources: FrozenStagingSources;
  metadataPath: string;
  coverPath?: string;
  audioPath?: string;
  durationSeconds?: number;
};

function metadataPayload(asset: "show_metadata" | "episode_metadata", bytes: Buffer): StagePayload {
  return { asset, length_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function prepareLocalStagingUpload(root: string, config: ServiceConfig, input: Omit<StageUploadRequest, "payloads">,
  selectionInput: LocalStagingSelection): Promise<PreparedLocalStagingUpload> {
  const request = requestSchema.parse(input);
  const selection = selectionSchema.parse(selectionInput);
  const placeholder = { length_bytes: 1, sha256: "0".repeat(64) };
  stageUploadRequestSchema.parse({ ...request, payloads: selection.asset === "show" ? [
    { ...placeholder, asset: "show_metadata" }, { ...placeholder, asset: "cover_jpg" },
  ] : [{ ...placeholder, asset: selection.asset }] });
  const existing = readLocalStagingOperation(root, config, request.operation_id);
  if (existing.lock_present || existing.client_state && existing.client_state.phase !== "prepared") {
    throw new Error("Staging preparation cannot reopen a requested operation or a retained client lock");
  }
  for (const directory of [root, join(root, request.show_id)]) {
    if (!(await lstat(directory)).isDirectory()) throw new Error("Local staging parents must be real directories, not symlinks");
  }
  const directory = resolve(root, request.show_id);
  const metadataPath = join(directory, request.kind === "show" ? "show.toml" : `episode-${request.episode_id}.toml`);
  const metadata = await readLocalMetadata(metadataPath);
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(metadata);
  const payloads: StagePayload[] = [];
  const paths: string[] = [];
  let coverPath: string | undefined;
  let audioPath: string | undefined;
  let durationSeconds: number | undefined;
  if (request.kind === "show") {
    const show = parseShowMetadata(source);
    if (show.show_id !== request.show_id) throw new Error("Local Show metadata targets another Show");
    const asset = show.image_path.toLowerCase().endsWith(".png") ? "cover_png" : "cover_jpg";
    coverPath = join(directory, show.image_path);
    const cover = await inspectLocalStagingSource(coverPath, asset);
    const signature = asset === "cover_png" ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) : Buffer.from([255, 216, 255]);
    if (!cover.prefix.subarray(0, signature.length).equals(signature)) throw new Error("Local cover signature does not match its image extension");
    payloads.push(metadataPayload("show_metadata", metadata), cover.payload);
    paths.push(metadataPath, coverPath);
  } else {
    const episode = parseEpisodeDraft(source);
    if (episode.episode_id !== request.episode_id) throw new Error("Local Episode metadata targets another Episode");
    if (selection.asset === "audio") {
      audioPath = resolve(directory, selection.audio_path);
      const audio = await inspectLocalStagingSource(audioPath, "audio");
      const analysis = await analyzeAudio(audioPath);
      if (analysis.length !== audio.payload.length_bytes) throw new Error("Local audio changed before duration analysis completed");
      await assertLocalStagingSource(audioPath, audio.payload);
      durationSeconds = analysis.duration;
      payloads.push(audio.payload);
      paths.push(audioPath);
    } else {
      payloads.push(metadataPayload("episode_metadata", metadata));
      paths.push(metadataPath);
    }
  }
  if (!metadata.equals(await readLocalMetadata(metadataPath))) throw new Error("Local metadata changed while staging inputs were inspected");
  const upload = stageUploadRequestSchema.parse({ ...request, payloads });
  if (existing.client_state && JSON.stringify(existing.client_state.upload) !== JSON.stringify(upload)) {
    throw new Error("Existing staging operation has different frozen inputs; preserve its journal");
  }
  const sources = await freezeStagingSources(root, upload, paths);
  try {
    const journal = createStagingJournal(root, config, upload);
    const current = readLocalStagingOperation(root, config, request.operation_id);
    if (current.lock_present || journal.load().phase !== "prepared") throw new Error("Staging operation changed while its sources were prepared");
    return { journal, sources, metadataPath, ...(coverPath ? { coverPath } : {}), ...(audioPath ? { audioPath, durationSeconds } : {}) };
  } catch (error) { await sources.dispose(); throw error; }
}
