import { assertPublicationInventoryBudget, assertPublicationRenderBudget, publicationCharacterLength,
  parseEpisodeDraft, parseShowMetadata, sameEpisodeIdentity, validateId } from "@castloop/shared";
import type { EpisodeDraft, ShowMetadata } from "@castloop/shared";
import { analyzeAudio } from "./audio";
import { localJournalEntryExists as present } from "./local-journal-path";
import { createLocalJournalStorage } from "./local-journal-storage";
import { readLocalMetadata } from "./local-metadata-read";
import { parseRssImportFeed } from "./rss-import-feed";
import { hashRssImportFile, readRssImportSnapshot, rssImportAssetSchema, rssImportControlSchema, rssImportCoverExtension } from "./rss-import-local";
import { sha256HexSync } from "./sha256";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export type PreparedRssImport = { importId: string; root: string; show: ShowMetadata;
  episodes: Array<{ metadata: EpisodeDraft; audioPath: string; length: number; duration: number; sha256: string }>;
  inputSha256: string; audioBytes: number; coverPath: string; coverSha256: string };

export async function prepareRssImportPublication(output: string, publicBaseUrl = ""): Promise<PreparedRssImport> {
  const root = resolve(output);
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error("Import directory must not use symlinks");
  const control = createLocalJournalStorage(root, "rss-import-downloads", undefined, "control.json");
  if (present(`${control.path}.lock`)) throw new Error("Import download is unfinished or locked; do not publish");
  const state = rssImportControlSchema.parse(control.read());
  validateId(state.show_id, "show");
  const source = await readRssImportSnapshot(join(root, "source.xml"));
  if (!state.final_url || sha256HexSync(source) !== state.feed_sha256) {
    throw new Error("RSS snapshot differs from its retained import record");
  }
  const feed = parseRssImportFeed(source, state.show_id, state.final_url);
  const text = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const showBytes = await readLocalMetadata(join(root, "show.toml"));
  const show = parseShowMetadata(text(showBytes));
  if (show.show_id !== state.show_id) throw new Error("Import Show ID changed");
  const coverPath = join(root, show.image_path);
  const cover = await hashRssImportFile(coverPath, 5_000_000);
  if (await rssImportCoverExtension(coverPath) !== (show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg")) {
    throw new Error("Import cover contents do not match their image type");
  }
  const hash = createHash("sha256").update(state.import_id).update(state.feed_sha256!).update(showBytes).update(cover.sha256);
  const episodes: PreparedRssImport["episodes"] = [];
  let metadataBytes = 0;
  let audioBytes = 0;
  for (const episode of feed.episodes) {
    const id = episode.metadata.episode_id;
    const bytes = await readLocalMetadata(join(root, `episode-${id}.toml`));
    const metadata = parseEpisodeDraft(text(bytes));
    if (!sameEpisodeIdentity(metadata, { ...metadata, episode_id: id, guid: episode.metadata.guid,
      guid_is_permalink: episode.metadata.guid_is_permalink, published_at: episode.metadata.published_at })) {
      throw new Error("Import Episode GUID, date or permalink meaning changed from the original RSS");
    }
    const audioPath = join(root, `${id}.mp3`);
    const record = createLocalJournalStorage(root, "rss-import-downloads", undefined, `${id}.json`);
    const expected = rssImportAssetSchema.parse(record.read());
    const audio = await hashRssImportFile(audioPath, 300_000_000);
    if (expected.file !== audioPath || expected.length !== audio.length || expected.sha256 !== audio.sha256) {
      throw new Error("Import audio differs from its downloaded completion record");
    }
    const analysis = await analyzeAudio(audioPath);
    if (analysis.length !== audio.length || JSON.stringify(await hashRssImportFile(audioPath, 300_000_000)) !== JSON.stringify(audio)) {
      throw new Error("Import audio changed during validation");
    }
    hash.update(bytes).update(audio.sha256);
    metadataBytes += bytes.length + 1024;
    audioBytes += audio.length;
    episodes.push({ metadata, audioPath, ...audio, duration: analysis.duration });
  }
  assertPublicationInventoryBudget(episodes.length * 2, episodes.reduce((length, episode) =>
    length + publicationCharacterLength(JSON.stringify(episode.metadata)) + 1024 + publicationCharacterLength(JSON.stringify(publicBaseUrl)), 0));
  assertPublicationRenderBudget(Buffer.byteLength(JSON.stringify({ show, episodes })) +
    episodes.length * (1024 + Buffer.byteLength(JSON.stringify(publicBaseUrl))), episodes.length);
  if (metadataBytes > 8_000_000) {
    throw new Error("RSS import exceeds the existing feed inventory or rendering budget");
  }
  if (present(`${control.path}.lock`) || JSON.stringify(rssImportControlSchema.parse(control.read())) !== JSON.stringify(state)) {
    throw new Error("Import record changed during publication preparation");
  }
  episodes.sort((left, right) => Date.parse(left.metadata.published_at) - Date.parse(right.metadata.published_at) ||
    left.metadata.episode_id.localeCompare(right.metadata.episode_id));
  return { importId: state.import_id, root, show, episodes, inputSha256: hash.digest("hex"), audioBytes, coverPath, coverSha256: cover.sha256 };
}
