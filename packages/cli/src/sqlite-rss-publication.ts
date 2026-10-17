import { z } from "zod";
import { parseEpisodeDraft, parseShowMetadata } from "@castloop/shared";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqlitePublicationStatusSchema } from "../../shared/src/sqlite-publication";
import { prepareRssImportPublication } from "./rss-import-preflight";
import { verifyImportedFeed, writeImportedMetadata } from "./rss-import-publication";
import { hashRssImportFile } from "./rss-import-local";
import { receiveRssAsset } from "./rss-import-download";
import { createLocalJournalStorage } from "./local-journal-storage";
import { localJournalEntryExists as present, syncLocalJournalDirectory } from "./local-journal-path";
import { readLocalMetadata } from "./local-metadata-read";
import { administratorKey } from "./administrator-key";
import { SqliteServiceClient } from "./sqlite-service-client";
import { readSqliteDraftRecord } from "./sqlite-draft-journal";
import { SqliteDraft } from "./sqlite-draft";
import { runSqliteCommand } from "./sqlite-commands";
import type { SqliteCommandOptions } from "./sqlite-commands";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z.object({ protocol: z.literal("sqlite-sequential-v1"), service_id: z.string(), service_config_sha256: hash,
  import_id: z.uuid(), source_directory: z.string().max(4096), input_sha256: hash, step: z.number().int().nonnegative(),
  phase: z.enum(["ready", "command_requested", "completed"]), created_show_sha256: hash.optional(), publication_job_id: z.uuid().optional() }).strict();
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
  const prepared = await prepareRssImportPublication(resolve(root, output)), key = administratorKey(root);
  const client = new SqliteServiceClient(config, key, options.transport), health = await client.health();
  if (!health.publication_ready || health.state !== "open") throw new Error("SQLite RSS publication requires a ready, open service");
  const showId = prepared.show.show_id, directory = join(root, showId);
  const initial = stateSchema.parse({ protocol: "sqlite-sequential-v1", service_id: config.service_id,
    service_config_sha256: await sqliteServiceConfigHash(config), import_id: prepared.importId, source_directory: prepared.root,
    input_sha256: prepared.inputSha256, step: 0, phase: "ready" });
  const journal = createLocalJournalStorage(root, "sqlite-rss-imports", config.service_id, `${prepared.importId}.json`);
  if (!present(journal.path)) {
    if (present(directory) || (await client.inspect(showId)).show_lifecycle !== "missing") throw new Error("SQLite RSS import requires a new Show; never adopt existing local, published or deleted identities");
    journal.initialize(initial);
  }
  return journal.exclusively(async () => {
    let state = stateSchema.parse(journal.read());
    for (const field of ["protocol", "service_id", "service_config_sha256", "import_id", "source_directory", "input_sha256"] as const) {
      if (state[field] !== initial[field]) throw new Error("SQLite RSS import inputs changed; preserve its frozen operation");
    }
    const save = () => journal.replace(stateSchema.parse(state));
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const actions: Array<() => Promise<void>> = [];
    actions.push(async () => {
      await effects.command("create-show", [showId, prepared.show.site_url]);
      state = { ...state, created_show_sha256: digest(await readLocalMetadata(join(directory, "show.toml"))) };
    });
    actions.push(async () => {
      if (digest(await readLocalMetadata(join(directory, "show.toml"))) !== state.created_show_sha256) throw new Error("Created Show draft changed before RSS installation");
      const destination = join(directory, prepared.show.image_path);
      await copyFile(prepared.coverPath, destination, constants.COPYFILE_EXCL);
      const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await file.sync(); } finally { await file.close(); }
      syncLocalJournalDirectory(directory);
      if ((await hashRssImportFile(destination, 5_000_000)).sha256 !== prepared.coverSha256) throw new Error("Import cover changed during installation");
      await writeImportedMetadata(join(prepared.root, "show.toml"), join(directory, "show.toml"), prepared.show);
    });
    const command = (name: string, args: string[]) => async () => {
      const result = await effects.command(name, args);
      if (name.startsWith("publish-")) {
        const status = sqlitePublicationStatusSchema.parse(result);
        if (status.state !== "succeeded" || status.job_id !== state.publication_job_id) throw new Error("SQLite RSS publication did not confirm the frozen job");
      }
    };
    actions.push(command("update-show", [showId]), command("publish-show", [showId]));
    for (const episode of prepared.episodes) {
      const id = episode.metadata.episode_id;
      actions.push(async () => {
        const audio = await hashRssImportFile(episode.audioPath, 300_000_000);
        if (audio.sha256 !== episode.sha256 || audio.length !== episode.length) throw new Error("Import audio changed before publication");
        await effects.command("create-episode", [showId, id]);
        await writeImportedMetadata(join(prepared.root, `episode-${id}.toml`), join(directory, `episode-${id}.toml`), episode.metadata);
      });
      actions.push(command("update-episode", [showId, id]), command("update-episode-audio", [showId, id, episode.audioPath]),
        command("publish-episode", [showId, id, episode.audioPath]));
    }
    if (state.step > actions.length || state.phase === "completed" && state.step !== actions.length || state.step > 0 && !state.created_show_sha256) throw new Error("SQLite RSS progress is inconsistent");
    const publicationTarget = (step: number) => {
      const index = (step - 7) / 4;
      const episode = Number.isInteger(index) && index >= 0 ? prepared.episodes[index] : undefined;
      return step === 3 ? { kind: "show" as const, show_id: showId } : episode ? { kind: "episode" as const, show_id: showId, episode_id: episode.metadata.episode_id } : null;
    };
    if ((state.phase === "command_requested" && publicationTarget(state.step) !== null) !== (state.publication_job_id !== undefined)) throw new Error("SQLite RSS publication identity is inconsistent");
    if (state.phase === "command_requested") {
      const target = publicationTarget(state.step);
      if (!target) throw new Error("SQLite RSS command outcome is unknown; preserve upload/registration journals without replaying it");
      const record = await readSqliteDraftRecord(root, config, target);
      if (!record?.publication || record.target.job_id !== state.publication_job_id) throw new Error("SQLite RSS submission is unconfirmed or changed; never replay an unknown command");
      const draft = await SqliteDraft.open(root, config, record.target, { administratorKey: key, managementTransport: options.transport, r2: options.cloudflare });
      if (!await draft.observe()) throw new Error("SQLite RSS submission is unknown; preserve its frozen request without resending");
      await draft.wait();
      state = { ...state, step: state.step + 1, phase: "ready", publication_job_id: undefined }; save();
    }
    while (state.step < actions.length) {
      const target = publicationTarget(state.step), record = target ? await readSqliteDraftRecord(root, config, target) : null;
      if (target && (!record || record.publication)) throw new Error("SQLite RSS publication requires its exact staged, unpublished draft");
      if (record) {
        const episode = record.target.kind === "episode" ? prepared.episodes.find((entry) => entry.metadata.episode_id === record.target.episode_id)! : undefined;
        const metadata = await readLocalMetadata(join(directory, episode ? `episode-${episode.metadata.episode_id}.toml` : "show.toml"));
        const parsed = episode ? parseEpisodeDraft(metadata.toString("utf8")) : parseShowMetadata(metadata.toString("utf8"));
        if (JSON.stringify(parsed) !== JSON.stringify(episode?.metadata ?? prepared.show) || record.target.base_revision_id ||
          record.target.expected_show_state_version !== (episode ? 1 : 0) || record.assets.length !== 2 ||
          record.assets.some(({ upload }) => upload.sha256 !== (upload.asset.endsWith("metadata") ? digest(metadata) : episode ? episode.sha256 : prepared.coverSha256))) {
          throw new Error("SQLite RSS staged inputs differ from the reviewed import; no publication was submitted");
        }
      }
      state = { ...state, phase: "command_requested", ...(record ? { publication_job_id: record.target.job_id } : {}) }; save();
      console.error(JSON.stringify({ event: "sqlite_rss_publication", import_id: prepared.importId, step: state.step, phase: "started" }));
      await actions[state.step]();
      state = { ...state, step: state.step + 1, phase: "ready", publication_job_id: undefined }; save();
      console.error(JSON.stringify({ event: "sqlite_rss_publication", import_id: prepared.importId, step: state.step, phase: "completed" }));
    }
    const feedUrl = `${config.public_base_url}/podcasts/${showId}/feed.xml`;
    verifyImportedFeed(prepared, feedUrl, await effects.readFeed(feedUrl));
    state = { ...state, phase: "completed" }; save();
    return { result: "rss-import-published", protocol: "sqlite-sequential-v1", import_id: prepared.importId, show_id: showId,
      episode_count: prepared.episodes.length, feed_url: feedUrl, subscriber_migration_completed: false };
  });
}
