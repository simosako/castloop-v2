import { sameEpisodeIdentity } from "@castloop/shared";
import type { EpisodeDraft, ShowMetadata, SqliteServiceConfig } from "@castloop/shared";
import { parseSqliteDirectPublicationRequest, sameSqlitePublicationContent } from "../../shared/src/sqlite-direct-publication";
import type { SqliteDirectPublishRequest } from "../../shared/src/sqlite-direct-publication";
import type { SqliteAudioReference, SqliteCoverReference } from "../../shared/src/sqlite-media";
import { diffEpisodeDraftFields, diffShowMetadataFields } from "../../shared/src/sqlite-revisions";
import { administratorKey } from "./administrator-key";
import { AgentError } from "./agent-output";
import { inspectCover, inspectLocalAsset, loadLocalInput } from "./local-input";
import { analyzeAudio } from "./audio";
import { sha256HexSync as sha256 } from "./sha256";
import { SqliteServiceClient } from "./sqlite-service-client";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

export type PreviewTarget = { kind: "show" | "episode"; show_id: string; episode_id?: string; audio_path?: string };
export type PreviewOptions = { mode?: "local" | "remote" | "auto"; client?: SqliteServiceClient };

export async function draftPreview(root: string, config: SqliteServiceConfig, target: PreviewTarget, options: PreviewOptions = {}) {
  for (const parent of [root, join(root, target.show_id)]) {
    if (!(await lstat(parent)).isDirectory()) throw new AgentError("invalid_directory", "Content parents must be real directories.");
  }
  const file = join(root, target.show_id, target.kind === "show" ? "show.toml" : `episode-${target.episode_id}.toml`);
  const { bytes, value } = await loadLocalInput(target.kind, file);
  if ("show_id" in value ? value.show_id !== target.show_id : !("episode_id" in value) || value.episode_id !== target.episode_id) throw new Error("Local metadata targets another Show or Episode");
  const metadata = value as ShowMetadata | EpisodeDraft;
  let cover: SqliteCoverReference | null = null, audio: SqliteAudioReference | null = null, mediaPath: string | null = null;
  if (target.kind === "show") {
    mediaPath = join(root, target.show_id, (metadata as ShowMetadata).image_path);
    cover = await inspectCover(mediaPath);
  } else if (target.audio_path) {
    mediaPath = resolve(root, target.show_id, target.audio_path);
    const inspected = await inspectLocalAsset(mediaPath, 300_000_000), analysis = await analyzeAudio(mediaPath);
    if (analysis.length !== inspected.length_bytes) throw new Error("Local MP3 changed during analysis");
    audio = { sha256: inspected.sha256, length_bytes: inspected.length_bytes, duration_seconds: analysis.duration };
  }
  let client = options.client;
  if (options.mode !== "local" && !client) {
    let localOnly = false;
    if (options.mode !== "remote") {
      try { await lstat(join(root, ".castloop")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") localOnly = true; else throw error; }
    }
    if (!localOnly) client = new SqliteServiceClient(config, administratorKey(root));
  }
  const snapshot = options.mode === "local" || !client ? null : await client.content(target.show_id, target.episode_id);
  const published = target.kind === "show" ? snapshot?.show_content?.metadata : snapshot?.episode_content?.metadata;
  const effectiveAudio = audio ?? (snapshot?.episode_content ? { sha256: snapshot.episode_content.audio.sha256,
    length_bytes: snapshot.episode_content.audio.length_bytes, duration_seconds: snapshot.episode_content.audio.duration_seconds } : null);
  const identity = !snapshot ? "not_checked" : !published ? "initial" : target.kind === "episode" ?
    sameEpisodeIdentity(metadata as EpisodeDraft, published as EpisodeDraft) ? "preserved" : "changed_invalid" :
    snapshot.show_content?.cover.extension === cover?.extension ? "preserved" : "changed_invalid";
  const base = snapshot ? { service_config_sha256: snapshot.service_config_sha256,
    show_lifecycle: snapshot.show_lifecycle,
    show_state_version: snapshot.expected_show_state_version, show_revision_id: snapshot.show_content?.revision_id ?? null,
    episode_lifecycle: snapshot.episode_lifecycle, episode_lifecycle_version: snapshot.expected_episode_lifecycle_version,
    base_revision_id: snapshot.episode_content?.revision_id ?? null, feed_generation: snapshot.feed_generation } : null;
  let request: SqliteDirectPublishRequest | null = null;
  if (snapshot && snapshot.expected_show_state_version !== null && (target.kind === "show" ? cover : effectiveAudio)) {
    const parsed = parseSqliteDirectPublicationRequest({ schema_version: 1, protocol: "sqlite-sequential-v1", action: "publish",
      service_id: config.service_id, service_config_sha256: snapshot.service_config_sha256,
      show_id: target.show_id, expected_show_state_version: snapshot.expected_show_state_version,
      kind: target.kind, metadata, ...(target.kind === "show" ? { cover } : { episode_id: target.episode_id, audio: effectiveAudio,
        expected_episode_lifecycle_version: snapshot.expected_episode_lifecycle_version, base_revision_id: snapshot.episode_content?.revision_id }) });
    if (parsed.action !== "publish") throw new Error("Unexpected publication action");
    request = parsed;
  }
  const unchanged = !!request && !!snapshot && sameSqlitePublicationContent(request, snapshot);
  const localFingerprint = sha256(JSON.stringify({ metadata_sha256: sha256(bytes), cover, audio, media_path: mediaPath }));
  const future = target.kind === "episode" && Date.parse((metadata as EpisodeDraft).published_at) > Date.now();
  const fields = !snapshot ? null : target.kind === "show" ? diffShowMetadataFields(published as ShowMetadata ?? null, metadata as ShowMetadata) :
    diffEpisodeDraftFields(published as EpisodeDraft ?? null, metadata as EpisodeDraft);
  return { target, local: { metadata, sha256: sha256(bytes), cover, audio, media_path: mediaPath },
    published: { status: !snapshot ? "not_checked" : published ? "checked" : "unpublished_initial", metadata: published ?? null, snapshot },
    changes: { metadata_fields: fields, local_fields: fields, status: snapshot ? "checked" : "not_checked", identity_status: identity,
      audio: { mode: target.kind === "show" ? "not_applicable" : audio ? "replace_audio" : effectiveAudio ? "reuse_published" : "missing_required",
        published: snapshot?.episode_content?.audio ?? null, candidate: effectiveAudio },
      cover: { candidate: cover, published: snapshot?.show_content?.cover ?? null } },
    request, unchanged, publishable: !!request && !!snapshot && identity !== "changed_invalid" && (unchanged ||
      (target.kind === "show" ? ["draft", "published"].includes(snapshot.show_lifecycle) : snapshot.show_lifecycle === "published" &&
        ["missing", "published"].includes(snapshot.episode_lifecycle!))),
    local_fingerprint: localFingerprint, input_fingerprint: sha256(JSON.stringify({ config, target, local_fingerprint: localFingerprint, base })),
    remote_readiness: snapshot ? "checked" : "not_checked", verification_paths: mediaPath ? [{ local_source_path: mediaPath }] : [],
    warnings: future ? [{ code: "future_published_at", published_at: (metadata as EpisodeDraft).published_at,
      message: "Episode published_at is in the future. Immediate publication starts now; scheduled publication uses the schedule time instead." }] : [] };
}
