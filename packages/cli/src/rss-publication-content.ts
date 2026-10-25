import { parseEpisodeDraft, parseShowMetadata } from "@castloop/shared";
import { sitePageUrl } from "../../shared/src/website";
import { syncLocalJournalDirectory } from "./local-journal-path";
import { writeSyncedLocalFile } from "./local-journal-storage";
import { readLocalMetadata } from "./local-metadata-read";
import { parseRssImportFeed } from "./rss-import-feed";
import type { PreparedRssImport } from "./rss-import-preflight";
import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { resolve } from "node:path";

export async function writeImportedMetadata(source: string, target: string, expected: object): Promise<void> {
  const bytes = await readLocalMetadata(source);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const actual = target.endsWith("show.toml") ? parseShowMetadata(text) : parseEpisodeDraft(text);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Import metadata changed after publication preparation");
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeSyncedLocalFile(temporary, () => bytes.toString("utf8"));
  renameSync(temporary, target);
  syncLocalJournalDirectory(resolve(target, ".."));
}

export function verifyImportedFeed(prepared: PreparedRssImport, feedUrl: string, source: string): void {
  const published = parseRssImportFeed(source, prepared.show.show_id, feedUrl, 32_000_000);
  const siteUrl = prepared.show.site_mode === "builtin" ? sitePageUrl(new URL(feedUrl).origin,
    { kind: "listing", showId: prepared.show.show_id, page: 1 }) : prepared.show.site_url;
  if (published.show.site_url !== siteUrl) throw new Error("Published RSS site URL differs from the import");
  for (const field of ["title", "description", "language", "author", "owner_name", "owner_email", "explicit", "show_type", "copyright"] as const) {
    if (published.show[field] !== prepared.show[field]) throw new Error("Published RSS Show metadata differs from the import");
  }
  if (published.episodes.length !== prepared.episodes.length) throw new Error("Published RSS Episode count differs from the import");
  if (JSON.stringify(published.show.categories) !== JSON.stringify(prepared.show.categories)) throw new Error("Published RSS categories differ from the import");
  const episodesByGuid = new Map(published.episodes.map((episode) => [episode.metadata.guid, episode]));
  for (const original of prepared.episodes) {
    const episode = episodesByGuid.get(original.metadata.guid);
    if (!episode || Date.parse(episode.metadata.published_at) !== Date.parse(original.metadata.published_at) ||
      episode.metadata.guid_is_permalink !== (original.metadata.guid_is_permalink ?? false)) throw new Error("Published RSS identity differs from the import");
    for (const field of ["title", "description", "explicit", "episode_type", "season_number", "episode_number"] as const) {
      if (episode.metadata[field] !== original.metadata[field]) throw new Error("Published RSS Episode metadata differs from the import");
    }
    const url = new URL(episode.audio_url);
    if (url.origin !== new URL(feedUrl).origin || !url.pathname.startsWith(`/podcasts/${prepared.show.show_id}/episodes/${original.metadata.episode_id}/`)) {
      throw new Error("Published RSS still references an external or unexpected audio URL");
    }
  }
}
