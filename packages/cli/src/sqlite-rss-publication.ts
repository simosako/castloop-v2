import { z } from "zod";
import { parseEpisodeDraft, parseShowMetadata } from "@castloop/shared";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqlitePublicationStatusSchema } from "../../shared/src/sqlite-publication";
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
import { readSqliteDraftRecord } from "./sqlite-draft-journal";
import { SqliteDraft } from "./sqlite-draft";
import { runSqliteCommand } from "./sqlite-commands";
import type { SqliteCommandOptions } from "./sqlite-commands";
import { sha256HexSync as digest } from "./sha256";
import { operationCommandSchema } from "../../shared/src/sqlite-operations";
import type { OperationCommand } from "../../shared/src/sqlite-operations";
import { SqliteOperationClient } from "./sqlite-operation-client";
import { readSqliteUploadRecord } from "./sqlite-upload";
import { constants } from "node:fs";
import { copyFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sqliteRssStateSchema = z.object({ schema_version: z.literal(2).optional(), protocol: z.literal("sqlite-sequential-v1"), service_id: z.string(), service_config_sha256: hash,
  import_id: z.uuid(), source_directory: z.string().max(4096), input_sha256: hash, step: z.number().int().nonnegative(),
  phase: z.enum(["ready", "command_requested", "completed"]), created_show_sha256: hash.optional(), publication_job_id: z.uuid().optional(),
  registration: operationCommandSchema.optional(), root_registered: z.boolean().optional(), pending: operationCommandSchema.optional(),
  step_registration: operationCommandSchema.optional(), upload_operation_id: z.uuid().optional(),
  bootstrap_state: z.enum(["prepared", "create_requested", "created", "resume_requested", "opened"]).optional(), bootstrap_window: z.uuid().optional() }).strict();
const stateSchema = sqliteRssStateSchema;
type RssCommandContext = Pick<SqliteCommandOptions, "parentOperationId" | "importId" | "onUploadPrepared">;
export type SqliteRssEffects = { command: (name: string, args: string[], context?: RssCommandContext) => Promise<unknown>; readFeed: (url: string) => Promise<string> };
export type SqliteRssResult = { result: "rss-import-published"; protocol: "sqlite-sequential-v1"; import_id: string;
  show_id: string; episode_count: number; feed_url: string; subscriber_migration_completed: false };

export function createSqliteRssEffects(root: string, config: SqliteServiceConfig, options: SqliteCommandOptions = {}): SqliteRssEffects {
  return { command: (name, args, context) => runSqliteCommand(root, config, name, args, { ...options, ...context }), async readFeed(url) {
    const chunks: Buffer[] = [];
    await receiveRssAsset(url, 32_000_000, async (bytes) => { chunks.push(Buffer.from(bytes)); });
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } };
}

export async function publishSqliteRssImport(root: string, config: SqliteServiceConfig, output: string,
  options: SqliteCommandOptions = {}, effects = createSqliteRssEffects(root, config, options)): Promise<SqliteRssResult> {
  config = sqliteServiceConfigSchema.parse(config);
  const prepared = await prepareRssImportPublication(resolve(root, output), config.public_base_url), key = administratorKey(root);
  const client = new SqliteServiceClient(config, key, options.transport);
  let health = await client.registrationHealth();
  if (!health.publication_ready) throw new Error("SQLite RSS publication requires a ready service outside shared maintenance");
  const showId = prepared.show.show_id, directory = join(root, showId);
  const registration = operationCommandSchema.parse({ schema_version: 1, service_id: config.service_id,
    worker_version_id: health.worker_version_id, service_config_sha256: health.service_config_sha256,
    operation_id: prepared.importId, request_id: crypto.randomUUID(), expected_version: 0, action: "register",
    estimated_operations: (prepared.episodes.length + 1) * 5,
    estimated_content_bytes: Buffer.byteLength(JSON.stringify({ show: prepared.show, episodes: prepared.episodes.map((episode) => episode.metadata) })) * 2,
    operation: { operation_id: prepared.importId,
      import_id: prepared.importId, kind: "rss_import", target_kind: "show", show_id: showId,
      worker_version_id: health.worker_version_id, service_config_sha256: health.service_config_sha256,
      input_sha256: prepared.inputSha256 } });
  const initial = stateSchema.parse({ schema_version: 2, protocol: "sqlite-sequential-v1", service_id: config.service_id, registration,
    service_config_sha256: await sqliteServiceConfigHash(config), import_id: prepared.importId, source_directory: prepared.root,
    input_sha256: prepared.inputSha256, step: 0, phase: "ready", bootstrap_state: "prepared", bootstrap_window: crypto.randomUUID() });
  const journal = createLocalJournalStorage(root, "sqlite-rss-imports", config.service_id, `${prepared.importId}.json`);
  if (!present(journal.path)) {
    if (present(directory) || (await client.registration(showId)).state !== "missing") throw new Error("SQLite RSS import requires a new Show; never adopt existing local, published or deleted identities");
    journal.initialize(initial);
  }
  return journal.exclusively(async () => {
    let state = stateSchema.parse(journal.read());
    for (const field of ["protocol", "service_id", "service_config_sha256", "import_id", "source_directory", "input_sha256"] as const) {
      if (state[field] !== initial[field]) throw new Error("SQLite RSS import inputs changed; preserve its frozen operation");
    }
    const save = () => journal.replace(stateSchema.parse(state));
    if (state.bootstrap_state === "create_requested" || state.bootstrap_state === "resume_requested") throw new Error("RSS Show initialization outcome is unknown; inspect without replaying it");
    if (state.bootstrap_state === "prepared") {
      state = { ...state, bootstrap_state: "create_requested" }; save();
      await effects.command("create-show", prepared.show.site_url === undefined ? [showId] : [showId, prepared.show.site_url]);
      state = { ...state, bootstrap_state: "created", created_show_sha256: digest(await readLocalMetadata(join(directory, "show.toml"))) }; save();
    }
    if (state.bootstrap_state === "created") {
      state = { ...state, bootstrap_state: "resume_requested" }; save();
      await effects.command("show-resume", [showId, state.bootstrap_window!]);
      state = { ...state, bootstrap_state: "opened" }; save();
    }
    health = await client.health(showId);
    if (!health.publication_ready || health.state !== "open" || !health.admission_window_id) throw new Error("RSS target Show is not ready and open");
    if (!state.root_registered && !state.pending && state.registration) {
      if (state.registration.worker_version_id !== health.worker_version_id) throw new Error("RSS prepared runtime changed");
      state = { ...state, registration: operationCommandSchema.parse({ ...state.registration,
        operation: { ...state.registration.operation!, admission_window_id: health.admission_window_id } }) }; save();
    }
    const operations = new SqliteOperationClient(config, key, options.transport, showId), tracked = state.schema_version === 2;
    if (!state.root_registered) {
      const capacity = (await operations.list()).capacity;
      if (capacity.warning === "critical" && (capacity.database_bytes ?? 0) + registration.estimated_operations! * 20000 +
        registration.estimated_content_bytes! + 10_000_000 > capacity.planning_limit_bytes) throw new Error("Insufficient operation record capacity for this import");
    }
    const send = async (command: OperationCommand) => {
      state = { ...state, pending: command }; save();
      const result = await operations.send(root, command);
      state = { ...state, pending: undefined }; save(); return result;
    };
    if (tracked && state.pending) {
      const result = await operations.observeRequest(root, state.pending);
      if (!result || result.request.outcome !== "applied") throw new Error("RSS operation instruction is unknown; preserve its request without replaying it");
      state = { ...state, ...(state.pending.action === "register" && state.pending.operation_id === prepared.importId ? { root_registered: true } : {}), pending: undefined }; save();
    }
    if (tracked && !state.root_registered) {
      if (!state.registration || state.registration.operation_id !== prepared.importId || state.registration.operation?.input_sha256 !== prepared.inputSha256) throw new Error("RSS operation registration differs");
      await send(state.registration); state = { ...state, root_registered: true }; save();
    }
    const change = async (id: string, phase: "command_requested" | "step_completed" | "completed") => {
      if (!tracked) return;
      const detail = await operations.detail(id);
      if (detail?.operation.state === "succeeded" && phase === "completed") return;
      if (!detail || detail.operation.state === "cancelled" || detail.operation.worker_version_id !== health.worker_version_id ||
        detail.operation.admission_window_id && detail.operation.admission_window_id !== health.admission_window_id) throw new Error("RSS operation runtime, admission or state changed");
      await send(operationCommandSchema.parse({ schema_version: 1, service_id: config.service_id,
        worker_version_id: health.worker_version_id, service_config_sha256: health.service_config_sha256,
        operation_id: id, request_id: crypto.randomUUID(), expected_version: detail.operation.version, action: "resume", phase }));
    };
    const context: RssCommandContext = tracked ? { parentOperationId: prepared.importId, importId: prepared.importId,
      onUploadPrepared: (id) => { state = { ...state, upload_operation_id: id }; save(); } } : {};
    const actions: Array<() => Promise<void>> = [];
    actions.push(async () => {
      if (!state.created_show_sha256 || digest(await readLocalMetadata(join(directory, "show.toml"))) !== state.created_show_sha256) throw new Error("Created Show draft differs");
    });
    actions.push(async () => {
      if (digest(await readLocalMetadata(join(directory, "show.toml"))) !== state.created_show_sha256) throw new Error("Created Show draft changed before RSS installation");
      const destination = join(directory, prepared.show.image_path);
      await copyFile(prepared.coverPath, destination, constants.COPYFILE_EXCL);
      const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await file.sync(); } finally { await file.close(); }
      syncLocalJournalDirectory(directory);
      if ((await hashRssImportFile(destination, 5_000_000)).sha256 !== prepared.coverSha256) throw new Error("Import cover changed during installation");
      if (prepared.show.site_css_path !== undefined) {
        if (present(join(directory, prepared.show.site_css_path))) throw new Error("Import CSS destination already exists");
        writeSyncedLocalFile(join(directory, prepared.show.site_css_path), () => prepared.show.site_css!);
        syncLocalJournalDirectory(directory);
      }
      await writeImportedMetadata(join(prepared.root, "show.toml"), join(directory, "show.toml"), prepared.show);
    });
    const command = (name: string, args: string[]) => async () => {
      const result = await effects.command(name, args, context);
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
        await effects.command("create-episode", [showId, id], context);
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
      if (!target && tracked && state.upload_operation_id) {
        const upload = await readSqliteUploadRecord(root, config, state.upload_operation_id);
        if (upload.registration.operation?.parent_operation_id !== prepared.importId) throw new Error("RSS upload belongs to another operation");
        const draft = await SqliteDraft.open(root, config, upload.target, { administratorKey: key, managementTransport: options.transport, r2: options.cloudflare });
        await draft.resumeUpload(state.upload_operation_id);
      } else if (!target && tracked && state.step_registration) {
        const child = await operations.detail(state.step_registration.operation_id);
        if (child?.operation.state !== "succeeded" || child.operation.parent_operation_id !== prepared.importId ||
          child.operation.input_sha256 !== digest(`${prepared.inputSha256}:${state.step}`)) {
          throw new Error("SQLite RSS command outcome is unknown; preserve local installation without replaying it");
        }
        if (state.step === 0) {
          if (!state.created_show_sha256 || digest(await readLocalMetadata(join(directory, "show.toml"))) !== state.created_show_sha256) {
            throw new Error("Completed Show registration differs from its local installation");
          }
        } else if (state.step === 1) {
          if (JSON.stringify(parseShowMetadata((await readShowPublicationInput(join(directory, "show.toml"))).toString("utf8"))) !== JSON.stringify(prepared.show) ||
            (await hashRssImportFile(join(directory, prepared.show.image_path), 5_000_000)).sha256 !== prepared.coverSha256) throw new Error("Completed Show installation differs from its reviewed import");
        } else {
          const episode = prepared.episodes[(state.step - 4) / 4];
          if (!episode || JSON.stringify(parseEpisodeDraft((await readLocalMetadata(join(directory, `episode-${episode.metadata.episode_id}.toml`))).toString("utf8"))) !==
            JSON.stringify(episode.metadata)) throw new Error("Completed Episode installation differs from its reviewed import");
        }
      } else if (!target) throw new Error("SQLite RSS command outcome is unknown; preserve upload/registration journals without replaying it");
      if (target) {
        const record = await readSqliteDraftRecord(root, config, target);
        if (!record?.publication || record.target.job_id !== state.publication_job_id) throw new Error("SQLite RSS submission is unconfirmed or changed; never replay an unknown command");
        const draft = await SqliteDraft.open(root, config, record.target, { administratorKey: key, managementTransport: options.transport, r2: options.cloudflare });
        if (!await draft.observe()) throw new Error("SQLite RSS submission is unknown; preserve its frozen request without resending");
        await draft.wait();
      }
      state = { ...state, step: state.step + 1, phase: "ready", publication_job_id: undefined, upload_operation_id: undefined, step_registration: undefined }; save();
      await change(prepared.importId, "step_completed");
    }
    while (state.step < actions.length) {
      const target = publicationTarget(state.step), record = target ? await readSqliteDraftRecord(root, config, target) : null;
      if (target && (!record || record.publication)) throw new Error("SQLite RSS publication requires its exact staged, unpublished draft");
      if (record) {
        const episode = record.target.kind === "episode" ? prepared.episodes.find((entry) => entry.metadata.episode_id === record.target.episode_id)! : undefined;
        const metadata = episode ? await readLocalMetadata(join(directory, `episode-${episode.metadata.episode_id}.toml`)) :
          await readShowPublicationInput(join(directory, "show.toml"));
        const parsed = episode ? parseEpisodeDraft(metadata.toString("utf8")) : parseShowMetadata(metadata.toString("utf8"));
        if (JSON.stringify(parsed) !== JSON.stringify(episode?.metadata ?? prepared.show) || record.target.base_revision_id ||
          record.target.expected_show_state_version !== (episode ? 1 : 0) || record.assets.length !== 2 ||
          record.assets.some(({ upload }) => upload.sha256 !== (upload.asset.endsWith("metadata") ? digest(metadata) : episode ? episode.sha256 : prepared.coverSha256))) {
          throw new Error("SQLite RSS staged inputs differ from the reviewed import; no publication was submitted");
        }
      }
      state = { ...state, phase: "command_requested", ...(record ? { publication_job_id: record.target.job_id } : {}) }; save();
      await change(prepared.importId, "command_requested");
      if (tracked && (state.step === 0 || state.step === 1 || state.step >= 4 && state.step % 4 === 0)) {
        const childId = crypto.randomUUID(), episode = state.step >= 4 ? prepared.episodes[(state.step - 4) / 4] : undefined;
        const child = operationCommandSchema.parse({ schema_version: 1, service_id: config.service_id,
          worker_version_id: health.worker_version_id, service_config_sha256: health.service_config_sha256,
          operation_id: childId, request_id: crypto.randomUUID(), expected_version: 0, action: "register", operation: {
            operation_id: childId, parent_operation_id: prepared.importId, import_id: prepared.importId,
            kind: state.step === 0 ? "show_registration" : "local_install", target_kind: episode ? "episode" : "show",
            show_id: showId, episode_id: episode?.metadata.episode_id, worker_version_id: health.worker_version_id,
            service_config_sha256: health.service_config_sha256, admission_window_id: health.admission_window_id,
            input_sha256: digest(`${prepared.inputSha256}:${state.step}`) } });
        state = { ...state, step_registration: child }; save();
        await send(child); await change(childId, "command_requested");
      }
      console.error(JSON.stringify({ event: "sqlite_rss_publication", import_id: prepared.importId, step: state.step, phase: "started" }));
      await actions[state.step]();
      if (state.step_registration) await change(state.step_registration.operation_id, "completed");
      state = { ...state, step: state.step + 1, phase: "ready", publication_job_id: undefined, upload_operation_id: undefined, step_registration: undefined }; save();
      await change(prepared.importId, "step_completed");
      console.error(JSON.stringify({ event: "sqlite_rss_publication", import_id: prepared.importId, step: state.step, phase: "completed" }));
    }
    const feedUrl = `${config.public_base_url}/podcasts/${showId}/feed.xml`;
    verifyImportedFeed(prepared, feedUrl, await effects.readFeed(feedUrl));
    await change(prepared.importId, "completed");
    state = { ...state, phase: "completed" }; save();
    return { result: "rss-import-published", protocol: "sqlite-sequential-v1", import_id: prepared.importId, show_id: showId,
      episode_count: prepared.episodes.length, feed_url: feedUrl, subscriber_migration_completed: false };
  });
}
