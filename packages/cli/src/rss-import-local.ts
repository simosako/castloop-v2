import TOML from "@iarna/toml";
import { z } from "zod";
import { validateId } from "@castloop/shared";
import { analyzeAudio } from "./audio";
import { localJournalEntryExists as present, syncLocalJournalDirectory } from "./local-journal-path";
import { createLocalJournalStorage, writeSyncedLocalFile } from "./local-journal-storage";
import { readLocalMetadata } from "./local-metadata-read";
import { receiveRssAsset, validateRssSourceUrl } from "./rss-import-download";
import type { RssAssetTransport } from "./rss-import-download";
import { parseRssImportFeed, RSS_IMPORT_MAXIMUM_BYTES } from "./rss-import-feed";
import { sha256HexSync } from "./sha256";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const rssImportControlSchema = z.object({ schema_version: z.literal(1), import_id: z.uuid(), show_id: z.string(), source_url: z.string().max(3072),
  feed_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), final_url: z.string().max(3072).optional() }).strict();
export const rssImportAssetSchema = z.object({ schema_version: z.literal(1), file: z.string(), length: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export async function hashRssImportFile(file: string, maximum: number): Promise<{ length: number; sha256: string }> {
  const source = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum)) throw new Error("Import file exceeds its type/size budget");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(65536);
    let length = 0;
    while (length < maximum + 1) {
      const read = await source.read(buffer, 0, Math.min(buffer.length, maximum + 1 - length), null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await source.stat({ bigint: true });
    if (BigInt(length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("Import file changed during inspection");
    }
    return { length, sha256: hash.digest("hex") };
  } finally { await source.close(); }
}

export async function readRssImportSnapshot(file: string): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readLocalMetadata(file, RSS_IMPORT_MAXIMUM_BYTES));
}

export async function rssImportCoverExtension(file: string): Promise<"jpg" | "png"> {
  const image = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await image.stat();
    if (!stat.isFile() || stat.size < 3 || stat.size > 5_000_000) throw new Error("Imported cover size/type is invalid");
    const header = Buffer.alloc(8);
    await image.read(header, 0, 8, 0);
    if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "jpg";
    if (header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
    throw new Error("Imported cover must be JPEG or PNG");
  } finally { await image.close(); }
}

async function fetchFeed(url: string, transport?: RssAssetTransport): Promise<{ source: string; url: string }> {
  const chunks: Buffer[] = [];
  const result = await receiveRssAsset(url, RSS_IMPORT_MAXIMUM_BYTES, async (bytes) => { chunks.push(Buffer.from(bytes)); }, transport);
  return { source: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks)), url: result.url };
}

export async function inspectRssImport(showId: string, sourceUrl: string, transport?: RssAssetTransport): Promise<unknown> {
  validateId(showId, "show");
  const fetched = await fetchFeed(sourceUrl, transport);
  const feed = parseRssImportFeed(fetched.source, showId, fetched.url);
  const total = feed.episodes.reduce((sum, episode) => sum + (episode.declared_length ?? 0), 0);
  return { result: "rss-import-preview", show_id: showId, episode_count: feed.episodes.length,
    declared_audio_bytes: Number.isSafeInteger(total) ? total : null,
    audio_sizes_complete: Number.isSafeInteger(total) && feed.episodes.every((episode) => episode.declared_length !== undefined),
    missing_fields: feed.missing_fields, warnings: feed.warnings, cloudflare_changed: false };
}

export async function importRssLocally(showId: string, sourceUrl: string, output: string, transport?: RssAssetTransport): Promise<unknown> {
  validateId(showId, "show");
  sourceUrl = validateRssSourceUrl(sourceUrl).href;
  const root = resolve(output);
  if (realpathSync(dirname(root)) !== dirname(root)) throw new Error("Import parent must not use symlinks");
  if (!present(root)) mkdirSync(root, { mode: 0o700 });
  if (!lstatSync(root).isDirectory()) throw new Error("Import directory must be a real directory");
  const storage = createLocalJournalStorage(root, "rss-import-downloads", undefined, "control.json");
  if (!present(storage.path) && readdirSync(root).length) throw new Error("Use an empty directory for a new RSS import");
  storage.initialize(rssImportControlSchema.parse({ schema_version: 1, import_id: randomUUID(), show_id: showId, source_url: sourceUrl }));
  let state = rssImportControlSchema.parse(storage.read());
  if (state.show_id !== showId || state.source_url !== sourceUrl) throw new Error("Import belongs to another Show or RSS URL");
  const snapshot = join(root, "source.xml");
  if (!present(snapshot)) {
    const fetched = await fetchFeed(sourceUrl, transport);
    parseRssImportFeed(fetched.source, showId, fetched.url);
    const sha256 = sha256HexSync(fetched.source);
    if (state.feed_sha256 && (state.feed_sha256 !== sha256 || state.final_url !== fetched.url)) {
      throw new Error("RSS changed after import preparation; keep the original import and use a new directory");
    }
    state = rssImportControlSchema.parse({ ...state, feed_sha256: sha256, final_url: fetched.url });
    storage.replace(state);
    const temporary = `${snapshot}.${randomUUID()}.part`;
    writeSyncedLocalFile(temporary, () => fetched.source);
    await link(temporary, snapshot);
    await unlink(temporary);
    syncLocalJournalDirectory(root);
  }
  const source = await readRssImportSnapshot(snapshot);
  if (!state.feed_sha256 || !state.final_url || sha256HexSync(source) !== state.feed_sha256) {
    throw new Error("RSS snapshot does not match its retained import record");
  }
  const feed = parseRssImportFeed(source, showId, state.final_url);
  if (!present(join(root, ".gitignore"))) writeSyncedLocalFile(join(root, ".gitignore"), () => "*\n");

  async function asset(name: string, url: string, maximum: number): Promise<string> {
    const record = createLocalJournalStorage(root, "rss-import-downloads", undefined, `${name}.json`);
    const file = join(root, name === "cover" ? "cover.bin" : `${name}.mp3`);
    let expected: z.infer<typeof rssImportAssetSchema> | undefined;
    if (present(record.path)) {
      const retained = rssImportAssetSchema.parse(record.read());
      if (retained.file !== file) throw new Error("Import asset belongs to another output path");
      expected = retained;
      if (present(file)) {
        const actual = await hashRssImportFile(file, maximum);
        if (retained.length !== actual.length || retained.sha256 !== actual.sha256) throw new Error("Completed import asset was changed");
        return file;
      }
    }
    if (present(file)) throw new Error("Import asset exists without its completion record; preserve it for inspection");
    const temporary = `${file}.${randomUUID()}.part`;
    const target = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let length = 0;
    try {
      const result = await receiveRssAsset(url, maximum, async (bytes) => {
        let offset = 0;
        while (offset < bytes.length) {
          const written = await target.write(bytes, offset, bytes.length - offset, null);
          if (!written.bytesWritten) throw new Error("Import asset write made no progress");
          offset += written.bytesWritten;
        }
        hash.update(bytes);
      }, transport);
      length = result.length;
      await target.sync();
      await target.close();
      const completed = { schema_version: 1 as const, file, length, sha256: hash.digest("hex") };
      if (expected && (expected.length !== completed.length || expected.sha256 !== completed.sha256)) {
        throw new Error("Source asset changed after import preparation; retain the original import");
      }
      record.initialize(completed);
      await link(temporary, file);
      await unlink(temporary);
      syncLocalJournalDirectory(root);
      return file;
    } catch (error) {
      await target.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  let coverName: string | undefined;
  if (feed.cover_url) {
    const file = await asset("cover", feed.cover_url, 5_000_000);
    coverName = `cover.${await rssImportCoverExtension(file)}`;
    if (!present(join(root, coverName))) { await link(file, join(root, coverName)); syncLocalJournalDirectory(root); }
    else if (JSON.stringify(await hashRssImportFile(file, 5_000_000)) !== JSON.stringify(await hashRssImportFile(join(root, coverName), 5_000_000))) {
      throw new Error("Imported cover alias was changed");
    }
  }
  const writeMetadata = (name: string, metadata: object) => {
    const file = join(root, name);
    if (present(file)) {
      if (!lstatSync(file).isFile()) throw new Error("Import metadata must be a regular file, not a symlink");
      return;
    }
    writeSyncedLocalFile(file, () => TOML.stringify(metadata as TOML.JsonMap));
    syncLocalJournalDirectory(root);
  };
  writeMetadata("show.toml", { ...feed.show, ...(coverName ? { image_path: coverName } : {}) });
  for (const episode of feed.episodes) {
    const file = await asset(episode.metadata.episode_id, episode.audio_url, 300_000_000);
    await analyzeAudio(file);
    writeMetadata(`episode-${episode.metadata.episode_id}.toml`, episode.metadata);
  }
  if (!present(join(root, "import.json"))) {
    writeSyncedLocalFile(join(root, "import.json"), () => JSON.stringify({ schema_version: 1, import_id: state.import_id,
      source_url: state.source_url, feed_sha256: state.feed_sha256, ...feed }, null, 2));
    syncLocalJournalDirectory(root);
  }
  return { result: "rss-import-downloaded", import_id: state.import_id, directory: root, episode_count: feed.episodes.length,
    missing_fields: feed.missing_fields, warnings: feed.warnings, cloudflare_changed: false };
}
