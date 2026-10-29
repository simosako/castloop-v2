import { z } from "zod";
import { parseEpisodeDraft, parseShowMetadata } from "@castloop/shared";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteDirectPublicationResultSchema } from "../../shared/src/sqlite-direct-publication";
import { prepareRssImportPublication } from "./rss-import-preflight";
import { verifyImportedFeed, writeImportedMetadata } from "./rss-publication-content";
import { hashRssImportFile } from "./rss-import-local";
import { receiveRssAsset } from "./rss-import-download";
import { createLocalJournalStorage, writeSyncedLocalFile } from "./local-journal-storage";
import { localJournalEntryExists as present, syncLocalJournalDirectory } from "./local-journal-path";
import { readLocalMetadata } from "./local-metadata-read";
import { readShowPublicationInput } from "./show-publication-input";
import { administratorKey } from "./administrator-key";
import { SqliteServiceClient } from "./sqlite-service-client";
import { AgentError } from "./agent-output";
import { runSqliteCommand } from "./sqlite-commands";
import type { SqliteCommandOptions } from "./sqlite-commands";
import { sha256HexSync as digest } from "./sha256";
import { constants } from "node:fs";
import { copyFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sqliteRssStateSchema = z.object({ schema_version: z.literal(3), protocol: z.literal("sqlite-sequential-v1"),
  service_id: z.string(), service_config_sha256: hash, import_id: z.uuid(), source_directory: z.string().max(4096), input_sha256: hash,
  step: z.number().int().nonnegative(), phase: z.enum(["ready", "publishing", "completed"]), installed: z.boolean(),
  created_show_sha256: hash.optional() }).strict();
export type SqliteRssEffects = { command: (name: string, args: string[]) => Promise<unknown>; readFeed: (url: string) => Promise<string> };
export type SqliteRssResult = { result: "rss-import-published"; protocol: "sqlite-sequential-v1"; import_id: string;
  show_id: string; episode_count: number; feed_url: string; subscriber_migration_completed: false };

export function createSqliteRssEffects(root: string, config: SqliteServiceConfig, options: SqliteCommandOptions = {}): SqliteRssEffects {
  return { command: (name, args) => runSqliteCommand(root, config, name, args, options), async readFeed(url) {
    const chunks: Buffer[] = [];
    await receiveRssAsset(url, 32_000_000, async (bytes) => { chunks.push(Buffer.from(bytes)); });
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } };
}

export async function publishSqliteRssImport(root: string, config: SqliteServiceConfig, output: string,
  options: SqliteCommandOptions = {}, effects = createSqliteRssEffects(root, config, options)): Promise<SqliteRssResult> {
  config = sqliteServiceConfigSchema.parse(config);
  const prepared = await prepareRssImportPublication(resolve(root, output), config.public_base_url), key = administratorKey(root);
  if (prepared.episodes.some((episode) => Date.parse(episode.metadata.published_at) > Date.now()) && !options.allowFuturePublishedAt) {
    throw new AgentError("future_published_at", "Imported Episodes include future published_at values. Use --allow-future-published-at to publish immediately.");
  }
  const client = new SqliteServiceClient(config, key, options.transport), showId = prepared.show.show_id, directory = join(root, showId);
  const initial = sqliteRssStateSchema.parse({ schema_version: 3, protocol: "sqlite-sequential-v1", service_id: config.service_id,
    service_config_sha256: await sqliteServiceConfigHash(config), import_id: prepared.importId, source_directory: prepared.root,
    input_sha256: prepared.inputSha256, step: 0, phase: "ready", installed: false });
  const journal = createLocalJournalStorage(root, "sqlite-rss-imports", config.service_id, `${prepared.importId}.json`);
  if (!present(journal.path)) {
    if (present(directory) || (await client.registration(showId)).state !== "missing") throw new Error("RSS import requires a new Show; existing identities are not adopted");
    journal.initialize(initial);
  }
  return journal.exclusively(async () => {
    let state = sqliteRssStateSchema.parse(journal.read());
    for (const field of ["service_id", "service_config_sha256", "import_id", "source_directory", "input_sha256"] as const) {
      if (state[field] !== initial[field]) throw new Error("RSS import inputs changed; preserve the retained batch record");
    }
    const save = () => journal.replace(sqliteRssStateSchema.parse(state));
    if (!state.created_show_sha256) {
      if (!(await client.registrationHealth()).publication_ready) throw new Error("RSS import requires a ready service");
      await effects.command("create-show", prepared.show.site_url === undefined ? [showId] : [showId, prepared.show.site_url]);
      state = { ...state, created_show_sha256: digest(await readLocalMetadata(join(directory, "show.toml"))) }; save();
    }
    const health = await client.health(showId);
    if (!health.publication_ready) throw new Error("RSS target Show is not ready");
    if (!state.installed) {
      const destination = join(directory, prepared.show.image_path);
      if (!present(destination)) await copyFile(prepared.coverPath, destination, constants.COPYFILE_EXCL);
      const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await file.sync(); } finally { await file.close(); }
      syncLocalJournalDirectory(directory);
      if ((await hashRssImportFile(destination, 5_000_000)).sha256 !== prepared.coverSha256) throw new Error("Import cover changed during installation");
      if (prepared.show.site_css_path !== undefined) writeSyncedLocalFile(join(directory, prepared.show.site_css_path), () => prepared.show.site_css!);
      await writeImportedMetadata(join(prepared.root, "show.toml"), join(directory, "show.toml"), prepared.show);
      for (const episode of prepared.episodes) {
        const id = episode.metadata.episode_id;
        await effects.command("create-episode", [showId, id]);
        await writeImportedMetadata(join(prepared.root, `episode-${id}.toml`), join(directory, `episode-${id}.toml`), episode.metadata);
      }
      state = { ...state, installed: true, phase: "ready" }; save();
    }
    if (state.step > prepared.episodes.length + 1) throw new Error("RSS batch progress is inconsistent");
    while (state.step <= prepared.episodes.length) {
      const episode = state.step === 0 ? undefined : prepared.episodes[state.step - 1]!;
      const source = episode ? await readLocalMetadata(join(directory, `episode-${episode.metadata.episode_id}.toml`)) : await readShowPublicationInput(join(directory, "show.toml"));
      const metadata = episode ? parseEpisodeDraft(source.toString("utf8")) : parseShowMetadata(source.toString("utf8"));
      if (JSON.stringify(metadata) !== JSON.stringify(episode?.metadata ?? prepared.show)) throw new Error("Installed metadata differs from the reviewed RSS import");
      if (episode) {
        const audio = await hashRssImportFile(episode.audioPath, 300_000_000);
        if (audio.sha256 !== episode.sha256 || audio.length !== episode.length) throw new Error("RSS audio changed before publication");
      } else if ((await hashRssImportFile(join(directory, prepared.show.image_path), 5_000_000)).sha256 !== prepared.coverSha256) throw new Error("RSS cover changed before publication");
      state = { ...state, phase: "publishing" }; save();
      const result = sqliteDirectPublicationResultSchema.parse(await effects.command(episode ? "publish-episode" : "publish-show",
        episode ? [showId, episode.metadata.episode_id, episode.audioPath] : [showId]));
      if (result.show_id !== showId || result.episode_id !== episode?.metadata.episode_id) throw new Error("RSS publication result target differs");
      state = { ...state, step: state.step + 1, phase: "ready" }; save();
    }
    const feedUrl = `${config.public_base_url}/podcasts/${showId}/feed.xml`;
    verifyImportedFeed(prepared, feedUrl, await effects.readFeed(feedUrl));
    state = { ...state, phase: "completed" }; save();
    return { result: "rss-import-published", protocol: "sqlite-sequential-v1", import_id: prepared.importId, show_id: showId,
      episode_count: prepared.episodes.length, feed_url: feedUrl, subscriber_migration_completed: false };
  });
}
