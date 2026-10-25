import { parseEpisodeDraft, sameEpisodeIdentity } from "@castloop/shared";
import type { EpisodeDraft, ShowMetadata, SqliteServiceConfig } from "@castloop/shared";
import { diffEpisodeDraftFields, diffShowMetadataFields } from "../../shared/src/sqlite-revisions";
import type { SqliteContentSnapshot } from "../../shared/src/sqlite-revisions";
import type { SqliteDraftRecord, SqliteDraftTarget } from "./sqlite-draft-journal";
import { readSqliteDraftRecord } from "./sqlite-draft-journal";
import { loadLocalInput } from "./local-input";
import { inspectLocalStagingSource } from "./staging-sources";
import { sha256HexSync as sha256 } from "./sha256";
import { AgentError } from "./agent-output";
import { administratorKey } from "./administrator-key";
import { SqliteServiceClient } from "./sqlite-service-client";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

export type PreviewOptions = { mode?: "local" | "remote" | "auto"; client?: SqliteServiceClient };

export function draftBaseMatches(target: SqliteDraftTarget, snapshot: SqliteContentSnapshot): boolean {
  return target.expected_show_state_version === snapshot.expected_show_state_version &&
    ["draft", "published"].includes(snapshot.show_lifecycle) &&
    (target.base_show_metadata_sha256 === undefined || target.base_show_metadata_sha256 === snapshot.show_content?.metadata_sha256) &&
    (target.base_cover_sha256 === undefined || target.base_cover_sha256 === snapshot.show_content?.cover.sha256) &&
    (target.kind === "show" || snapshot.show_lifecycle === "published" &&
      ["missing", "published"].includes(snapshot.episode_lifecycle ?? "missing") &&
      (target.expected_episode_lifecycle_version ?? 0) === snapshot.expected_episode_lifecycle_version &&
      target.base_revision_id === snapshot.episode_content?.revision_id &&
      target.base_metadata_sha256 === snapshot.episode_content?.metadata_sha256);
}

async function previewClient(root: string, config: SqliteServiceConfig, options: PreviewOptions) {
  if (options.mode === "local") return null;
  if (options.client) return options.client;
  if (options.mode !== "remote") {
    try { await lstat(join(root, ".castloop")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  return new SqliteServiceClient(config, administratorKey(root));
}

export async function draftPreview(root: string, config: SqliteServiceConfig,
  target: Pick<SqliteDraftTarget, "kind" | "show_id" | "episode_id">, retained?: SqliteDraftRecord, options: PreviewOptions = {}) {
  for (const parent of [root, join(root, target.show_id)]) {
    if (!(await lstat(parent)).isDirectory()) throw new AgentError("invalid_directory", "Preview parents must be real directories.");
  }
  const record = retained ?? await readSqliteDraftRecord(root, config, target);
  const file = join(root, target.show_id, target.kind === "show" ? "show.toml" : `episode-${target.episode_id}.toml`);
  const { bytes, value } = await loadLocalInput(target.kind, file);
  if ("show_id" in value ? value.show_id !== target.show_id : !("episode_id" in value) || value.episode_id !== target.episode_id) {
    throw new AgentError("target_mismatch", "Local metadata targets a different object.");
  }
  const metadataHash = sha256(bytes);
  const assets = [];
  for (const entry of record?.assets ?? []) {
    const current = await inspectLocalStagingSource(entry.source_path, entry.upload.asset);
    assets.push({ asset: entry.upload.asset, staged_sha256: entry.upload.sha256, local_sha256: current.payload.sha256,
      staged_length_bytes: entry.upload.length_bytes, local_length_bytes: current.payload.length_bytes,
      duration_seconds: entry.upload.duration_seconds ?? null, source_path: entry.source_path,
      matches_staged: current.payload.sha256 === entry.upload.sha256 && current.payload.length_bytes === entry.upload.length_bytes });
  }
  const metadata = record?.assets.find((entry) => entry.upload.asset.endsWith("metadata"));
  const metadataMatches = metadata ? metadata.upload.sha256 === metadataHash : record?.target.base_metadata_sha256 ?
    sha256(JSON.stringify(parseEpisodeDraft(bytes.toString("utf8")))) === record.target.base_metadata_sha256 : false;
  const cover = record?.assets.find((entry) => entry.upload.asset.startsWith("cover_"));
  const audio = record?.assets.find((entry) => entry.upload.asset === "audio");
  const coverPathMatches = target.kind !== "show" || !cover || "image_path" in value &&
    resolve(root, target.show_id, value.image_path) === resolve(cover.source_path);
  const inputsMatch = !!record && metadataMatches && coverPathMatches && assets.every((entry) => entry.matches_staged);
  const client = await previewClient(root, config, options);
  const snapshot = client ? await client.content(target.show_id, target.episode_id) : null;
  const publishedMetadata = target.kind === "show" ? snapshot?.show_content?.metadata : snapshot?.episode_content?.metadata;
  const baseMatches = record && snapshot ? draftBaseMatches(record.target, snapshot) : null;
  const identity = !snapshot ? "not_checked" : !publishedMetadata ? "initial" : target.kind === "episode" ?
    sameEpisodeIdentity(value as EpisodeDraft, publishedMetadata as EpisodeDraft) ? "preserved" : "changed_invalid" :
    snapshot.show_content?.cover.extension === ((value as ShowMetadata).image_path.toLowerCase().endsWith(".png") ? "png" : "jpg") ? "preserved" : "changed_invalid";
  const localFields = !snapshot ? null : target.kind === "show" ?
    diffShowMetadataFields(publishedMetadata as ShowMetadata ?? null, value as ShowMetadata) :
    diffEpisodeDraftFields(publishedMetadata as EpisodeDraft ?? null, value as EpisodeDraft);
  const effectiveMetadata = metadata ? metadataMatches ? value : null : snapshot?.episode_content?.metadata ?? null;
  const effectiveFields = !snapshot || !effectiveMetadata ? null : target.kind === "show" ?
    diffShowMetadataFields(publishedMetadata as ShowMetadata ?? null, effectiveMetadata as ShowMetadata) :
    diffEpisodeDraftFields(publishedMetadata as EpisodeDraft ?? null, effectiveMetadata as EpisodeDraft);
  const remoteBase = snapshot ? {
    worker_version_id: snapshot.worker_version_id, service_config_sha256: snapshot.service_config_sha256,
    admission_window_id: snapshot.admission_window_id, state: snapshot.state,
    show_lifecycle: snapshot.show_lifecycle, show_state_version: snapshot.expected_show_state_version,
    feed_generation: snapshot.feed_generation, show_revision_id: snapshot.show_content?.revision_id ?? null,
    show_metadata_sha256: snapshot.show_content?.metadata_sha256 ?? null, cover: snapshot.show_content?.cover ?? null,
    episode_lifecycle: snapshot.episode_lifecycle ?? null, episode_lifecycle_version: snapshot.expected_episode_lifecycle_version ?? null,
    base_revision_id: snapshot.episode_content?.revision_id ?? null, base_metadata_sha256: snapshot.episode_content?.metadata_sha256 ?? null,
    audio: snapshot.episode_content?.audio ?? null,
  } : null;
  const manifest = { version: 2, workspace: resolve(root), config, target: record?.target ?? target, assets: record?.assets ?? [],
    metadata_sha256: metadataHash, local_assets: assets, publication: record?.publication?.request_sha256 ?? null, remote_base: remoteBase };
  const sameAudio = !!audio && audio.upload.sha256 === snapshot?.episode_content?.audio.sha256 &&
    audio.upload.length_bytes === snapshot.episode_content.audio.length_bytes;
  return { target, job_id: record?.target.job_id ?? null, state: record?.publication ? "frozen" : record ? "staged" : "local_only",
    local: { metadata: value, sha256: metadataHash }, staged: { metadata_matches_local: metadataMatches,
      metadata: metadataMatches && metadata ? value : null, assets, cover_path_matches: coverPathMatches },
    published: { status: !snapshot ? "not_checked" : publishedMetadata ? "checked" : "unpublished_initial",
      metadata: publishedMetadata ?? null, snapshot, base_revision_id: snapshot?.episode_content?.revision_id ?? record?.target.base_revision_id ?? null },
    changes: { metadata_fields: effectiveFields, local_fields: localFields, status: snapshot ? "checked" : "not_checked",
      identity_status: identity,
      audio: { mode: target.kind === "show" ? "not_applicable" : !snapshot ? "not_checked" : audio ? sameAudio ? "replace_audio_same_content" : "replace_audio" :
        snapshot.episode_content ? "reuse_published" : "missing_required", published: snapshot?.episode_content?.audio ?? null,
        candidate: audio?.upload ?? snapshot?.episode_content?.audio ?? null },
      cover: { content_changed: !snapshot || !cover ? null : cover.upload.sha256 !== snapshot.show_content?.cover.sha256 ||
        cover.upload.length_bytes !== snapshot.show_content?.cover.length_bytes, published: snapshot?.show_content?.cover ?? null,
        candidate: cover?.upload ?? null } },
    inputs_match_staged: inputsMatch, uncommitted_local_edits: !inputsMatch, base_matches: baseMatches,
    publishable: snapshot ? inputsMatch && !record?.publication && baseMatches === true && identity !== "changed_invalid" && snapshot.state === "open" &&
      (target.kind === "show" ? !!metadata && !!cover : !!snapshot.episode_content || !!metadata && !!audio) : null,
    input_fingerprint: sha256(JSON.stringify(manifest)), remote_readiness: snapshot ? "checked" : "not_checked",
    verification_paths: assets.map(({ asset, source_path }) => ({ asset, local_source_path: source_path })),
  };
}
