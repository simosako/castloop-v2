import { episodeRevisionSchema } from "@castloop/shared";
import type { EpisodeDraft, EpisodeRevision, ShowMetadata, SqliteServiceConfig } from "@castloop/shared";
import { renderPublicationFeed } from "../../../src/publication-inputs";
import { draftPreview } from "./draft-preview";
import type { SqliteServiceClient } from "./sqlite-service-client";
import { writeSyncedLocalFile } from "./local-journal-storage";
import { syncLocalJournalDirectory } from "./local-journal-path";
import { sha256HexSync } from "./sha256";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

export async function exportPreviewRss(root: string, config: SqliteServiceConfig, preview: Awaited<ReturnType<typeof draftPreview>>,
  client: SqliteServiceClient, output: string) {
  const snapshot = preview.published.snapshot;
  if (!snapshot || !preview.publishable) throw new Error("RSS export requires a publishable remote preview");
  const episodes: EpisodeRevision[] = [];
  const siteIds: Record<string, string> = {};
  let after: string | undefined;
  do {
    const page = await client.previewInventory(preview.target.show_id, snapshot.feed_generation!, after);
    if (page.worker_version_id !== snapshot.worker_version_id || episodes.length + page.episodes.length > 10000) throw new Error("RSS inventory base or budget differs");
    episodes.push(...page.episodes);
    Object.assign(siteIds, page.site_ids);
    after = page.next_cursor ?? undefined;
  } while (after);
  if (episodes.length !== snapshot.published_episode_count) throw new Error("RSS inventory count differs from its snapshot");
  let show = snapshot.show_content?.metadata;
  let extension = snapshot.show_content?.cover.extension;
  if (preview.target.kind === "show") {
    show = preview.local.metadata as ShowMetadata;
    extension = show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
  } else {
    const old = snapshot.episode_content;
    const audio = preview.local.audio;
    const metadata = preview.local.metadata as EpisodeDraft;
    const previewRevisionId = "00000000-0000-4000-8000-000000000000";
    const candidate = episodeRevisionSchema.parse({ ...metadata, revision_id: previewRevisionId, content_type: "audio/mpeg",
      enclosure_url: audio ? `${config.public_base_url}/podcasts/${preview.target.show_id}/episodes/${preview.target.episode_id}/${previewRevisionId}.mp3` : old!.audio.enclosure_url,
      length_bytes: audio?.length_bytes ?? old!.audio.length_bytes, duration_seconds: audio?.duration_seconds ?? old!.audio.duration_seconds,
      sha256: audio?.sha256 ?? old!.audio.sha256, updated_at: "2000-01-01T00:00:00Z" });
    const index = episodes.findIndex((episode) => episode.episode_id === candidate.episode_id);
    if (index === -1) episodes.push(candidate); else episodes[index] = candidate;
    siteIds[candidate.episode_id] = snapshot.episode_site_id!;
  }
  if (!show || !extension) throw new Error("RSS preview Show content is missing");
  const xml = renderPublicationFeed(show, episodes, config.public_base_url, extension, siteIds);
  const final = await draftPreview(root, config, preview.target, { mode: "remote", client });
  if (final.input_fingerprint !== preview.input_fingerprint || !final.publishable) throw new Error("RSS preview changed during collection; review again");
  const file = resolve(output);
  for (let parent = dirname(file);; parent = dirname(parent)) {
    if (!lstatSync(parent).isDirectory()) throw new Error("RSS output parents must be real directories");
    if (dirname(parent) === parent) break;
  }
  writeSyncedLocalFile(file, () => xml);
  syncLocalJournalDirectory(dirname(file));
  return { status: "generated_locally", path: file, sha256: sha256HexSync(xml), length_bytes: Buffer.byteLength(xml),
    episode_count: episodes.length, budget: "checked", publication_completed: false };
}
