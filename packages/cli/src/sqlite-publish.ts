import type { SqliteServiceConfig } from "@castloop/shared";
import { administratorKey } from "./administrator-key";
import { AgentError } from "./agent-output";
import { draftPreview } from "./draft-preview";
import type { PreviewTarget } from "./draft-preview";
import { SqliteServiceClient } from "./sqlite-service-client";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { uploadSqliteMedia } from "./sqlite-media-upload";
import type { SqliteCommandOptions } from "./sqlite-commands";
import { loadLocalInput } from "./local-input";
import { sha256HexSync } from "./sha256";
import { join } from "node:path";

export async function prepareSqlitePublication(root: string, config: SqliteServiceConfig, target: PreviewTarget, options: SqliteCommandOptions) {
  const key = administratorKey(root), client = new SqliteServiceClient(config, key, options.transport);
  const preview = await draftPreview(root, config, target, { mode: "remote", client });
  if (!preview.publishable || !preview.request) throw new Error("Publication requires valid local inputs, an available target and audio for the initial Episode");
  if (options.expectedPreview && options.expectedPreview !== preview.input_fingerprint && !preview.unchanged) throw new Error("Publication inputs or reviewed base changed; preview again");
  return preview;
}

type MediaReference = { sha256: string; length_bytes: number; extension?: string } | null;

function sqliteMediaChanged(local: MediaReference, published: MediaReference): boolean {
  if (!local) return false;
  if (!published) return true;
  return local.sha256 !== published.sha256 || local.length_bytes !== published.length_bytes ||
    local.extension !== undefined && local.extension !== published.extension;
}

export async function placeSqlitePublicationMedia(root: string, config: SqliteServiceConfig,
  preview: Awaited<ReturnType<typeof prepareSqlitePublication>>, options: SqliteCommandOptions) {
  const media = preview.local.cover ?? preview.local.audio;
  const published = preview.local.cover ? preview.changes.cover.published : preview.changes.audio.published;
  if (sqliteMediaChanged(media, published)) {
    await uploadSqliteMedia(root, config, preview.target.show_id, preview.local.media_path!, media!,
      options.cloudflare ?? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" });
  }
  const target = preview.target;
  const file = join(root, target.show_id, target.kind === "show" ? "show.toml" : `episode-${target.episode_id}.toml`);
  const current = await loadLocalInput(target.kind, file);
  if (sha256HexSync(current.bytes) !== preview.local.sha256) throw new Error("Local publication metadata changed during media placement; preview again");
}

export async function publishSqliteContent(root: string, config: SqliteServiceConfig, target: PreviewTarget, options: SqliteCommandOptions) {
  const preview = await prepareSqlitePublication(root, config, target, options);
  if (!preview.unchanged) {
    if (preview.warnings.length && !options.allowFuturePublishedAt &&
      !await options.confirmFuturePublishedAt?.(preview.warnings[0]!.published_at)) throw new AgentError("future_published_at", "Confirm immediate publication with --allow-future-published-at, or schedule the Episode instead.");
    await placeSqlitePublicationMedia(root, config, preview, options);
  }
  return new SqlitePublicationClient(config, administratorKey(root), options.transport).submit(preview.request!);
}
