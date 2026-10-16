import { z } from "zod";
import { episodeDraftSchema, parseShowMetadata, showMetadataSchema, stringifyToml, validateId } from "@castloop/shared";
import { sqliteServiceConfigHash } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteRuntimeRequestSchema, sqliteHealthSchema } from "../../shared/src/sqlite-service-api";
import { administratorKey } from "./administrator-key";
import { SqliteDraft } from "./sqlite-draft";
import { readSqliteArchivedDraft, readSqliteDraftRecord, requireSqliteStatus } from "./sqlite-draft-journal";
import type { SqliteDraftTarget } from "./sqlite-draft-journal";
import { SqliteServiceClient } from "./sqlite-service-client";
import { SqlitePublicationClient } from "./sqlite-publication-client";
import { createLocalJournalStorage, writeSyncedLocalFile } from "./local-journal-storage";
import { ensureLocalJournalParents, syncLocalJournalDirectory } from "./local-journal-path";
import { continueSqliteInitialization, initializeSqliteService, reconcileSqliteInitialization, readSqliteInitialization } from "./sqlite-initialization";
import { readLocalMetadata } from "./local-metadata-read";
import { executeSqliteLifecycle, previewSqliteLifecycle, readSqliteLifecycleStatus } from "./sqlite-lifecycle";
import { readBoundedLocalJournal } from "./local-journal-read";
import { reconcileSqliteServiceUpdate, updateSqliteService } from "./sqlite-service-update";
import type { R2RestOptions, R2RestTransport } from "./verified-r2-put";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type SqliteCommandOptions = { workerSource?: () => Promise<string>; transport?: R2RestTransport; cloudflare?: R2RestOptions;
  listOptions?: { includeDeleted?: boolean; cursor?: string } };
const registrationSchema = z.object({ service_config_sha256: z.string().regex(/^[a-f0-9]{64}$/), show_id: z.string(), reservation_id: z.uuid(),
  phase: z.enum(["prepared", "requested", "registered"]) }).strict();
const controlSchema = z.object({ action: z.enum(["pause", "resume"]), request: sqliteRuntimeRequestSchema, window: z.uuid().optional(),
  phase: z.enum(["prepared", "requested", "confirmed"]), result: sqliteHealthSchema.optional() }).strict().superRefine((value, context) => {
  if ((value.action === "resume") !== (value.window !== undefined) || (value.phase === "confirmed") !== (value.result !== undefined)) {
    context.addIssue({ code: "custom", message: "Service control phase and evidence differ" });
  }
});

async function registeredShow(root: string, config: SqliteServiceConfig, showId: string, siteUrl: string, client: SqliteServiceClient): Promise<string> {
  const metadata = showMetadataSchema.parse({ schema_version: 1, show_id: showId, title: showId,
    description: "Edit this description before publication", language: "ja", author: "Edit author", owner_name: "Edit owner",
    owner_email: "owner@example.com", categories: ["Technology"], explicit: false, site_url: siteUrl, image_path: "cover.jpg" });
  const journal = createLocalJournalStorage(root, "sqlite-registrations", config.service_id, `${showId}.json`);
  let existing: z.infer<typeof registrationSchema> | null = null;
  try { existing = registrationSchema.parse(journal.read()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const configHash = await sqliteServiceConfigHash(config);
  if (existing && (existing.service_config_sha256 !== configHash || existing.show_id !== showId)) throw new Error("Retained Show registration differs");
  const health = await client.health();
  if (!health.publication_ready || health.state !== "open" || !health.admission_window_id) throw new Error("Show registration requires ready, open admission");
  const reservationId = existing?.reservation_id ?? crypto.randomUUID();
  journal.initialize({ service_config_sha256: configHash, show_id: showId, reservation_id: reservationId, phase: "prepared" });
  return journal.exclusively(async () => {
    const state = registrationSchema.parse(journal.read());
    if (state.reservation_id !== reservationId || state.show_id !== showId || state.service_config_sha256 !== configHash) throw new Error("Show registration changed concurrently");
    if (state.phase === "prepared") journal.replace({ ...state, phase: "requested" });
    const target = state.phase !== "prepared" ? await client.inspect(showId) : await client.register({ service_id: config.service_id, service_config_sha256: configHash,
      worker_version_id: health.worker_version_id, operation_id: crypto.randomUUID() }, health.admission_window_id!, showId, reservationId);
    if (state.reservation_id !== target.reservation_id || target.show_lifecycle !== "draft" || target.expected_show_state_version !== 0) {
      throw new Error("Registration is unknown or the Show has advanced/deleted; never recreate it or resend its request");
    }
    journal.replace({ ...state, phase: "registered" });
    const directory = join(root, showId), file = join(directory, "show.toml");
    if (!existsSync(directory)) { mkdirSync(directory, { mode: 0o700 }); syncLocalJournalDirectory(root); }
    if (!lstatSync(directory).isDirectory()) throw new Error("Show directory must not be a symlink");
    if (existsSync(file)) { if (parseShowMetadata((await readLocalMetadata(file)).toString("utf8")).show_id !== showId) throw new Error("Local Show identity differs"); return file; }
    writeSyncedLocalFile(file, () => stringifyToml(metadata)); syncLocalJournalDirectory(directory); return file;
  });
}

export async function runSqliteCommand(root: string, config: SqliteServiceConfig, command: string, args: string[],
  options: SqliteCommandOptions = {}): Promise<unknown> {
  const cf = options.cloudflare ?? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" };
  if (command === "init") {
    if (args.length > 1 || !options.workerSource) throw new Error("Invalid SQLite initialization arguments");
    return initializeSqliteService(root, config, args[0] ?? readSqliteInitialization(root, config)?.operation_id ?? crypto.randomUUID(),
      await options.workerSource(), cf);
  }
  const key = administratorKey(root), client = new SqliteServiceClient(config, key, options.transport);
  const draftOptions = { administratorKey: key, managementTransport: options.transport, r2: cf };
  if (command === "init-reconcile" && args.length === 1) return reconcileSqliteInitialization(root, config, args[0], cf);
  if (command === "init-continue-verification" && args.length === 1 && options.workerSource) return continueSqliteInitialization(root, config, args[0], await options.workerSource(), cf);
  if (command === "update-service" && args.length === 1 && options.workerSource) return updateSqliteService(root, config, args[0], await options.workerSource(), cf);
  if (command === "update-service-reconcile" && args.length === 1) return reconcileSqliteServiceUpdate(root, config, args[0], cf);
  if (command === "service-status" && !args.length) return client.health();
  if (command === "list-shows" && !args.length || command === "list-episodes" && args.length === 1) {
    return client.catalog({ kind: command === "list-shows" ? "show" : "episode", ...(command === "list-episodes" ? { show_id: validateId(args[0], "show") } : {}),
      include_deleted: options.listOptions?.includeDeleted ?? false, ...(options.listOptions?.cursor ? { cursor: options.listOptions.cursor } : {}) });
  }
  if (["service-pause", "service-resume"].includes(command) && args.length === 1) {
    const id = z.uuid().parse(args[0]), action = command === "service-pause" ? "pause" : "resume";
    const journal = createLocalJournalStorage(root, "sqlite-controls", config.service_id, `${id}.json`);
    let prior: z.infer<typeof controlSchema> | null = null;
    try { prior = controlSchema.parse(journal.read()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (prior) {
      if (prior.action !== action || prior.request.service_config_sha256 !== await sqliteServiceConfigHash(config)) throw new Error("Retained service control differs");
      if (prior.phase === "requested") throw new Error("Service control outcome is unknown; inspect service-status without replaying it");
      if (prior.phase === "confirmed") return client.health();
    }
    const health = await client.health();
    const request = sqliteRuntimeRequestSchema.parse({ service_id: config.service_id, service_config_sha256: health.service_config_sha256,
      worker_version_id: health.worker_version_id, operation_id: id });
    journal.initialize({ action, request, ...(action === "resume" ? { window: id } : {}), phase: "prepared" });
    return journal.exclusively(async () => {
      const state = controlSchema.parse(journal.read());
      if (state.phase === "confirmed") return client.health();
      if (state.phase !== "prepared" || state.action !== action || JSON.stringify(state.request) !== JSON.stringify(request)) throw new Error("Service control is uncertain or changed; do not replay it");
      journal.replace({ ...state, phase: "requested" });
      const result = await client.control(action, request, state.window); journal.replace({ ...state, phase: "confirmed", result }); return result;
    });
  }
  if (command === "create-show" && args.length === 2) return registeredShow(root, config, validateId(args[0], "show"), args[1], client);
  if (command === "create-episode" && args.length === 2) {
    const showId = validateId(args[0], "show"), episodeId = validateId(args[1], "episode"), inspection = await client.inspect(showId, episodeId);
    if (!["draft", "published"].includes(inspection.show_lifecycle) || inspection.episode_lifecycle !== "missing") throw new Error("Episode identity is unavailable");
    const directory = join(root, showId);
    if (!lstatSync(directory).isDirectory() || parseShowMetadata((await readLocalMetadata(join(directory, "show.toml"))).toString("utf8")).show_id !== showId) throw new Error("Local Show directory differs");
    const metadata = episodeDraftSchema.parse({ schema_version: 1, episode_id: episodeId, guid: crypto.randomUUID(), title: episodeId,
      description: "Edit this description before publication", published_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    const file = join(directory, `episode-${episodeId}.toml`); writeSyncedLocalFile(file, () => stringifyToml(metadata)); syncLocalJournalDirectory(directory); return file;
  }
  if (command === "target-show" && args.length === 1) return client.inspect(validateId(args[0], "show"));
  if (command === "target-episode" && args.length === 2) return client.inspect(validateId(args[0], "show"), validateId(args[1], "episode"));
  if (command === "preview-show-lifecycle" && args.length === 2) return previewSqliteLifecycle(config, key, validateId(args[0], "show"), args[1], undefined, options.transport);
  if (command === "preview-episode-lifecycle" && args.length === 3) return previewSqliteLifecycle(config, key, validateId(args[0], "show"), args[2], validateId(args[1], "episode"), options.transport);
  if (command === "lifecycle-execute" && args.length === 3) return executeSqliteLifecycle(root, config, key, readBoundedLocalJournal(resolve(root, args[0])), args[1], args[2], options.transport);
  if (command === "operation-status" && args.length === 2 && args[0] === "lifecycle") {
    const status = await readSqliteLifecycleStatus(root, config, key, args[1], options.transport);
    if (status === undefined) throw new Error("No matching SQLite lifecycle journal");
    return { job_id: args[1], status, snapshot_only: true, authorizes_recovery: false };
  }
  if (command === "job-status" && args.length === 1) {
    const jobId = z.uuid().parse(args[0]);
    const lifecycleStatus = await readSqliteLifecycleStatus(root, config, key, jobId, options.transport);
    if (lifecycleStatus !== undefined) return { job_id: jobId, status: lifecycleStatus, snapshot_only: true, authorizes_recovery: false };
    const archived = await readSqliteArchivedDraft(root, config, jobId);
    if (archived?.publication) {
      const status = await new SqlitePublicationClient(config, key, options.transport).observe(archived.publication.request);
      if (!status) throw new Error("Archived SQLite job is missing remotely; preserve its result");
      requireSqliteStatus(archived.publication.request, archived.publication.request_sha256, status, archived.publication.status);
      return { job_id: jobId, status, snapshot_only: true, authorizes_recovery: false };
    }
    for (const family of ["sqlite-drafts"] as const) {
      ensureLocalJournalParents(root, family, config.service_id);
      const folder = join(root, ".castloop", family, config.service_id);
      let names: string[] = [];
      try { names = readdirSync(folder).filter((name) => name.endsWith(".json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (names.length > 10000) throw new Error("Local job lookup exceeds its record budget");
      for (const name of names) {
        const raw = z.object({ target: z.object({ job_id: z.uuid(), kind: z.enum(["show", "episode"]), show_id: z.string(), episode_id: z.string().optional() }) }).parse(
          createLocalJournalStorage(root, family, config.service_id, name).read());
        if (raw.target.job_id !== jobId) continue;
        const record = await readSqliteDraftRecord(root, config, raw.target);
        if (!record?.publication) return { job_id: jobId, state: "draft" };
        const status = await new SqlitePublicationClient(config, key, options.transport).observe(record.publication.request);
        if (!status && record.publication.status) throw new Error("Previously acknowledged SQLite job is missing remotely; preserve its result");
        if (status) requireSqliteStatus(record.publication.request, record.publication.request_sha256, status, record.publication.status);
        return { job_id: jobId, status, snapshot_only: true, authorizes_recovery: false };
      }
    }
    throw new Error("No matching SQLite job journal");
  }
  const showCommand = ["update-show", "publish-show"].includes(command), episodeCommand = ["update-episode", "update-episode-audio", "publish-episode"].includes(command);
  if (!showCommand && !episodeCommand) throw new Error(`Command ${command} is not implemented for sqlite-sequential-v1; no legacy fallback`);
  if (args.length !== (showCommand ? 1 : command === "update-episode-audio" ? 3 : 2) && !(command === "publish-episode" && args.length === 3)) throw new Error("Invalid SQLite content command arguments");
  const targetId = { kind: showCommand ? "show" as const : "episode" as const, show_id: validateId(args[0], "show"),
    ...(episodeCommand ? { episode_id: validateId(args[1], "episode") } : {}) };
  let retained = await readSqliteDraftRecord(root, config, targetId);
  const publishing = command.startsWith("publish-");
  if (retained?.publication && !publishing) {
    const previous = await SqliteDraft.open(root, config, retained.target, draftOptions);
    const status = await previous.observe();
    if (!status || !["succeeded", "failed"].includes(status.state)) throw new Error("Publication remains frozen or uncertain; inspect its job without replacing it");
    retained = null;
  }
  let target: SqliteDraftTarget;
  if (retained) target = retained.target;
  else {
    if (publishing) throw new Error("Stage the current local inputs explicitly before publication");
    const inspected = await client.inspect(targetId.show_id, targetId.episode_id);
    if (inspected.state !== "open" || !["draft", "published"].includes(inspected.show_lifecycle) || inspected.expected_show_state_version === null ||
      episodeCommand && (inspected.show_lifecycle !== "published" || !["missing", "published"].includes(inspected.episode_lifecycle!))) throw new Error("SQLite target is not available for this draft");
    target = { ...targetId, job_id: crypto.randomUUID(), expected_show_state_version: inspected.expected_show_state_version,
      ...(episodeCommand ? { expected_episode_lifecycle_version: inspected.expected_episode_lifecycle_version } : {}),
      ...(inspected.base_revision_id ? { base_revision_id: inspected.base_revision_id, base_metadata_sha256: inspected.base_metadata_sha256 } : {}) };
  }
  const draft = await SqliteDraft.open(root, config, target, draftOptions);
  if (publishing) {
    if (args[2]) {
      const audio = (await draft.read()).assets.find((entry) => entry.upload.asset === "audio");
      if (!audio || audio.source_path !== resolve(root, targetId.show_id, args[2])) throw new Error("MP3 argument differs from its staged source");
    }
    await draft.publish(); return draft.wait();
  }
  const staged = await draft.stage(showCommand ? { asset: "show" } : command === "update-episode-audio" ? { asset: "audio", audio_path: args[2] } : { asset: "episode_metadata" });
  return { job_id: staged.target.job_id, state: "staged", assets: staged.assets.map((entry) => entry.upload.asset) };
}
