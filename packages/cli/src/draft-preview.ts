import { parseEpisodeDraft } from "@castloop/shared";
import type { SqliteServiceConfig } from "@castloop/shared";
import type { SqliteDraftRecord, SqliteDraftTarget } from "./sqlite-draft-journal";
import { readSqliteDraftRecord } from "./sqlite-draft-journal";
import { loadLocalInput } from "./local-input";
import { inspectLocalStagingSource } from "./staging-sources";
import { sha256HexSync as sha256 } from "./sha256";
import { AgentError } from "./agent-output";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function draftPreview(root: string, config: SqliteServiceConfig,
  target: Pick<SqliteDraftTarget, "kind" | "show_id" | "episode_id">, retained?: SqliteDraftRecord) {
  for (const parent of [root, join(root, target.show_id)]) {
    if (!(await lstat(parent)).isDirectory()) throw new AgentError("invalid_directory", "Preview parents must be real directories.");
  }
  const record = retained ?? await readSqliteDraftRecord(root, config, target);
  const file = join(root, target.show_id, target.kind === "show" ? "show.toml" : `episode-${target.episode_id}.toml`);
  const { bytes, value } = await loadLocalInput(target.kind, file);
  if ("show_id" in value ? value.show_id !== target.show_id : "episode_id" in value && value.episode_id !== target.episode_id) {
    throw new AgentError("target_mismatch", "Local metadata targets a different object.");
  }
  const metadataHash = sha256(bytes);
  const assets = [];
  for (const entry of record?.assets ?? []) {
    const current = await inspectLocalStagingSource(entry.source_path, entry.upload.asset);
    assets.push({ asset: entry.upload.asset, staged_sha256: entry.upload.sha256, local_sha256: current.payload.sha256,
      matches_staged: current.payload.sha256 === entry.upload.sha256 && current.payload.length_bytes === entry.upload.length_bytes });
  }
  const metadata = record?.assets.find((entry) => entry.upload.asset.endsWith("metadata"));
  const metadataMatches = metadata ? metadata.upload.sha256 === metadataHash : record?.target.base_metadata_sha256 ?
    sha256(JSON.stringify(parseEpisodeDraft(bytes.toString("utf8")))) === record.target.base_metadata_sha256 : false;
  const cover = record?.assets.find((entry) => entry.upload.asset.startsWith("cover_"));
  const coverPathMatches = target.kind !== "show" || !cover || "image_path" in value &&
    resolve(root, target.show_id, value.image_path) === resolve(cover.source_path);
  const manifest = { workspace: resolve(root), config, target: record?.target ?? target, assets: record?.assets ?? [],
    metadata_sha256: metadataHash, local_assets: assets, publication: record?.publication?.request_sha256 ?? null };
  return { target, job_id: record?.target.job_id ?? null, state: record?.publication ? "frozen" : record ? "staged" : "local_only",
    local: { metadata: value, sha256: metadataHash }, staged: { metadata_matches_local: metadataMatches,
      metadata: metadataMatches && metadata ? value : null, assets, cover_path_matches: coverPathMatches },
    published: { status: "not_checked", metadata: null, base_revision_id: record?.target.base_revision_id ?? null,
      note: "Published full metadata is not fetched; use the retained local original or administrator backup, never catalog summaries." },
    changes: { metadata: metadata ? "staged" : "reuse_base", audio: assets.some((asset) => asset.asset === "audio") ? "staged" : "reuse_base_or_missing",
      identity: "Runtime identity checks remain authoritative; published full metadata was not fetched." },
    inputs_match_staged: !!record && metadataMatches && coverPathMatches && assets.every((entry) => entry.matches_staged),
    input_fingerprint: sha256(JSON.stringify(manifest)), remote_readiness: "not_checked" };
}
