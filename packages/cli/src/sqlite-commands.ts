import { z } from "zod";
import { parseShowMetadata, stringifyToml, validateId } from "@castloop/shared";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteAvailabilityActionSchema, sqliteAvailabilityRequestSchema } from "../../shared/src/sqlite-availability";
import { sqliteControlJournalSchema as controlSchema } from "./sqlite-control-journal";
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
import { continueSqliteServiceUpdateVerification, reconcileSqliteServiceUpdate, updateSqliteService } from "./sqlite-service-update";
import type { R2RestOptions, R2RestTransport } from "./verified-r2-put";
import { runSqliteOperationCommand } from "./sqlite-operation-commands";
import type { OperationReadOptions } from "./sqlite-operation-commands";
import { draftPreview } from "./draft-preview";
import { showTemplate, episodeTemplate } from "./input-templates";
import { continueSqliteDomainChange, listSqliteDomains, sqliteDomainOperationStatus, startSqliteDomainChange } from "./sqlite-domain-operation";
import { sqliteDomainHostnameSchema } from "../../shared/src/sqlite-domain";
import { completedDomainConfiguration } from "./sqlite-domain-local";
import { executeRevision, previewRevision, readRevisionPlanFile, readRevisionStatus, syncLocalMetadata } from "./sqlite-revision-commands";
import { exportPreviewRss } from "./preview-rss";
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type SqliteCommandOptions = { workerSource?: () => Promise<string>; transport?: R2RestTransport; cloudflare?: R2RestOptions;
  previewOptions?: { mode?: "auto" | "local" | "remote"; rssOutput?: string };
  revisionOptions?: { cursor?: string; episodeId?: string; expectedRevision?: string; output?: string };
  domainOptions?: { zoneId?: string; operationId?: string; cursor?: string };
  listOptions?: { includeDeleted?: boolean; cursor?: string }; operationOptions?: OperationReadOptions;
  parentOperationId?: string; importId?: string; onUploadPrepared?: (id: string) => void; expectedPreview?: string };
export const SQLITE_COMMAND_ARGUMENTS: Record<string, readonly number[]> = {
  "preview-show": [1], "preview-episode": [1],
  "list-show-revisions": [1], "list-episode-revisions": [1], "preview-show-revision": [2], "preview-episode-revision": [2],
  "revision-execute": [3], "sync-local-metadata": [0],
  "create-show": [2], "create-episode": [1], "update-show": [1], "publish-show": [1],
  "update-episode": [1], "update-episode-audio": [2], "publish-episode": [1, 2], "job-status": [1],
  "service-status": [0], "show-status": [1], "show-pause": [2], "show-resume": [2], "target-show": [1], "target-episode": [2],
  "show-admission-pause": [2], "show-delivery-resume": [2], "show-control-status": [2],
  "list-shows": [0], "list-episodes": [1], "preview-show-lifecycle": [2], "preview-episode-lifecycle": [3],
  "lifecycle-execute": [3], "operation-status": [2], "init-reconcile": [1], "init-continue-verification": [1],
  "update-service": [1], "update-service-verify": [1], "update-service-reconcile": [1],
  "operation-list": [0], "operation-resume": [2], "operation-cancel": [2], "operation-cleanup-preview": [2], "operation-cleanup": [4],
  domain: [1, 2],
};
const registrationSchema = z.object({ service_config_sha256: z.string().regex(/^[a-f0-9]{64}$/), show_id: z.string(), reservation_id: z.uuid(),
  phase: z.enum(["prepared", "requested", "registered"]) }).strict();

async function registeredShow(root: string, config: SqliteServiceConfig, showId: string, siteUrl: string, client: SqliteServiceClient): Promise<string> {
  const metadata = showTemplate(showId, siteUrl);
  const journal = createLocalJournalStorage(root, "sqlite-registrations", config.service_id, `${showId}.json`);
  let existing: z.infer<typeof registrationSchema> | null = null;
  try { existing = registrationSchema.parse(journal.read()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const configHash = await sqliteServiceConfigHash(config);
  if (existing && (existing.service_config_sha256 !== configHash || existing.show_id !== showId)) throw new Error("Retained Show registration differs");
  const health = await client.registrationHealth();
  if (health.scope !== "service" || !health.publication_ready) throw new Error("Show registration requires a ready service outside shared maintenance");
  const reservationId = existing?.reservation_id ?? crypto.randomUUID();
  journal.initialize({ service_config_sha256: configHash, show_id: showId, reservation_id: reservationId, phase: "prepared" });
  return journal.exclusively(async () => {
    const state = registrationSchema.parse(journal.read());
    if (state.reservation_id !== reservationId || state.show_id !== showId || state.service_config_sha256 !== configHash) throw new Error("Show registration changed concurrently");
    if (state.phase !== "prepared") {
      const registered = await client.registration(showId);
      if (registered.state !== "registered" || registered.reservation_id !== reservationId) throw new Error("Show registration remains uncertain; preserve its reservation without replay");
    }
    if (state.phase === "prepared") journal.replace({ ...state, phase: "requested" });
    const target = state.phase !== "prepared" ? await client.inspect(showId) : await client.register({ service_id: config.service_id, service_config_sha256: configHash,
      worker_version_id: health.worker_version_id, operation_id: crypto.randomUUID() }, showId, reservationId);
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
  config = sqliteServiceConfigSchema.parse(config);
  if (command === "preview-show" || command === "preview-episode") {
    const episode = command === "preview-episode";
    if (args.length !== (episode ? 2 : 1)) throw new Error("Invalid preview arguments");
    const mode = options.previewOptions?.mode ?? "auto";
    const client = mode === "local" || !options.transport ? undefined : new SqliteServiceClient(config, administratorKey(root), options.transport);
    const result = await draftPreview(root, config, { kind: episode ? "episode" : "show", show_id: validateId(args[0], "show"),
      ...(episode ? { episode_id: validateId(args[1], "episode") } : {}) }, undefined, { mode, client });
    const rss = options.previewOptions?.rssOutput ? await exportPreviewRss(root, config, result,
      client ?? new SqliteServiceClient(config, administratorKey(root), options.transport), options.previewOptions.rssOutput) : { status: "not_checked" };
    return { ...result, rss_preview: rss };
  }
  const cf = options.cloudflare ?? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" };
  if (command === "domain") {
    const [action, argument] = args, selected = options.domainOptions ?? {};
    if (action === "list" && args.length === 1 && !selected.zoneId && !selected.operationId && !selected.cursor) return listSqliteDomains(root, config, cf);
    if (action === "status" && args.length === 2 && !selected.zoneId && !selected.operationId) return sqliteDomainOperationStatus(root, config, z.uuid().parse(argument), cf, selected.cursor);
    if (action === "continue" && args.length === 2 && !selected.zoneId && !selected.operationId && !selected.cursor && options.workerSource) return continueSqliteDomainChange(root, config, z.uuid().parse(argument), await options.workerSource(), cf);
    if ((action === "add" && args.length === 2 && selected.zoneId || action === "remove" && args.length === 1 && !selected.zoneId) && !selected.cursor && options.workerSource) {
      const target = action === "add" ? { hostname: sqliteDomainHostnameSchema.parse(argument), zoneId: z.string().regex(/^[a-f0-9]{32}$/).parse(selected.zoneId) } : undefined;
      const id = z.uuid().parse(selected.operationId ?? crypto.randomUUID());
      return startSqliteDomainChange(root, config, action, id, await options.workerSource(), cf, target);
    }
    throw new Error("Expected domain add HOST --zone-id ID, remove, list, status UUID or continue UUID with only supported options");
  }
  if (command.startsWith("operation-") && !(command === "operation-status" && args[0] === "lifecycle" && !options.operationOptions?.local)) {
    return runSqliteOperationCommand(root, config, command, args, options.operationOptions, options.transport, cf);
  }
  if (command === "init") {
    if (args.length > 1 || !options.workerSource) throw new Error("Invalid SQLite initialization arguments");
    return initializeSqliteService(root, config, args[0] ?? readSqliteInitialization(root, config)?.operation_id ?? crypto.randomUUID(),
      await options.workerSource(), cf);
  }
  const key = administratorKey(root), client = new SqliteServiceClient(config, key, options.transport);
  if (command === "list-show-revisions" && args.length === 1 || command === "list-episode-revisions" && args.length === 2) {
    return client.revisions(validateId(args[0], "show"), args[1] === undefined ? undefined : validateId(args[1], "episode"), options.revisionOptions?.cursor);
  }
  if (command === "preview-show-revision" && args.length === 2 || command === "preview-episode-revision" && args.length === 3) {
    return previewRevision(config, key, validateId(args[0], "show"), z.uuid().parse(args.at(-1)),
      command === "preview-episode-revision" ? validateId(args[1], "episode") : undefined, options.transport);
  }
  if (command === "revision-execute" && args.length === 3) {
    return executeRevision(root, config, key, readRevisionPlanFile(resolve(root, args[0])), args[1], args[2], options.transport);
  }
  if (command === "sync-local-metadata" && args.length === 1 && options.revisionOptions?.expectedRevision) {
    return syncLocalMetadata(root, config, key, validateId(args[0], "show"), options.revisionOptions.expectedRevision,
      options.revisionOptions.episodeId, options.revisionOptions.output, options.transport);
  }
  const draftOptions = { administratorKey: key, managementTransport: options.transport, r2: cf,
    parentOperationId: options.parentOperationId, importId: options.importId, onUploadPrepared: options.onUploadPrepared };
  if (command === "init-reconcile" && args.length === 1) return reconcileSqliteInitialization(root, config, args[0], cf);
  if (command === "init-continue-verification" && args.length === 1 && options.workerSource) return continueSqliteInitialization(root, config, args[0], await options.workerSource(), cf);
  if (command === "update-service" && args.length === 1 && options.workerSource) return updateSqliteService(root, config, args[0], await options.workerSource(), cf);
  if (command === "update-service-verify" && args.length === 1 && options.workerSource) return continueSqliteServiceUpdateVerification(root, config, args[0], await options.workerSource(), cf);
  if (command === "update-service-reconcile" && args.length === 1) return reconcileSqliteServiceUpdate(root, config, args[0], cf);
  if (command === "service-status" && !args.length) return client.health();
  if (command === "show-status" && args.length === 1) return client.health(validateId(args[0], "show"));
  if (command === "list-shows" && !args.length || command === "list-episodes" && args.length === 1) {
    return client.catalog({ kind: command === "list-shows" ? "show" : "episode", ...(command === "list-episodes" ? { show_id: validateId(args[0], "show") } : {}),
      include_deleted: options.listOptions?.includeDeleted ?? false, ...(options.listOptions?.cursor ? { cursor: options.listOptions.cursor } : {}) });
  }
  if (command === "show-control-status" && args.length === 2) return client.controlStatus(validateId(args[0], "show"), z.uuid().parse(args[1]));
  if (["show-pause", "show-resume", "show-admission-pause", "show-delivery-resume"].includes(command) && args.length === 2) {
    const showId = validateId(args[0], "show"), id = z.uuid().parse(args[1]), action = sqliteAvailabilityActionSchema.parse(command.slice(5));
    const journal = createLocalJournalStorage(root, "sqlite-controls", config.service_id, `${id}.json`);
    let prior: z.infer<typeof controlSchema> | null = null;
    try { prior = controlSchema.parse(journal.read()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (prior) {
      if (prior.request.action !== action || prior.request.show_id !== showId || prior.request.service_config_sha256 !== await sqliteServiceConfigHash(config)) throw new Error("Retained Show control differs");
      if (prior.phase !== "prepared") return journal.exclusively(async () => {
        const state = controlSchema.parse(journal.read());
        const result = await client.controlStatus(showId, id);
        if (JSON.stringify(result.control.request) !== JSON.stringify(state.request)) throw new Error("Show control outcome is unknown or differs");
        journal.replace({ ...state, phase: "confirmed", result }); return result;
      });
    }
    const health = await client.health(showId);
    const request = prior?.request ?? sqliteAvailabilityRequestSchema.parse({ service_id: config.service_id, service_config_sha256: health.service_config_sha256,
      worker_version_id: health.worker_version_id, operation_id: id, action, show_id: showId,
      expected_availability_version: health.availability_version, ...(action === "resume" ? { admission_window_id: id } : {}) });
    journal.initialize({ schema_version: 2, request, phase: "prepared" });
    return journal.exclusively(async () => {
      const state = controlSchema.parse(journal.read());
      if (state.phase !== "prepared" || JSON.stringify(state.request) !== JSON.stringify(request)) throw new Error("Service control is uncertain or changed; do not replay it");
      journal.replace({ ...state, phase: "requested" });
      const result = await client.control(request); journal.replace({ ...state, phase: "confirmed", result }); return result;
    });
  }
  if (command === "create-show" && args.length === 2) return registeredShow(root, config, validateId(args[0], "show"), args[1], client);
  if (command === "create-episode" && args.length === 2) {
    const showId = validateId(args[0], "show"), episodeId = validateId(args[1], "episode"), inspection = await client.inspect(showId, episodeId);
    if (!["draft", "published"].includes(inspection.show_lifecycle) || inspection.episode_lifecycle !== "missing") throw new Error("Episode identity is unavailable");
    const directory = join(root, showId);
    if (!lstatSync(directory).isDirectory() || parseShowMetadata((await readLocalMetadata(join(directory, "show.toml"))).toString("utf8")).show_id !== showId) throw new Error("Local Show directory differs");
    const metadata = episodeTemplate(episodeId, crypto.randomUUID(), new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
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
    const revision = await readRevisionStatus(root, config, key, jobId, options.transport);
    if (revision !== undefined) return { job_id: jobId, status: revision, snapshot_only: true, authorizes_recovery: false };
    const lifecycleStatus = await readSqliteLifecycleStatus(root, config, key, jobId, options.transport);
    if (lifecycleStatus !== undefined) return { job_id: jobId, status: lifecycleStatus, snapshot_only: true, authorizes_recovery: false };
    const archived = await readSqliteArchivedDraft(root, config, jobId);
    if (archived?.publication) {
      const historical = await completedDomainConfiguration(root, config, archived.service_config_sha256);
      if (!historical) throw new Error("No exact completed domain transition permits this historical job lookup");
      const status = await new SqlitePublicationClient(historical, key, options.transport).observe(archived.publication.request);
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
        const record = await readSqliteDraftRecord(root, config, raw.target, true);
        if (!record?.publication) return { job_id: jobId, state: "draft" };
        const historical = await completedDomainConfiguration(root, config, record.service_config_sha256);
        if (!historical) throw new Error("No exact completed domain transition permits this historical job lookup");
        const status = await new SqlitePublicationClient(historical, key, options.transport).observe(record.publication.request);
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
  const publishing = command.startsWith("publish-");
  let retained = await readSqliteDraftRecord(root, config, targetId, !publishing);
  if (retained?.publication && !publishing) {
    let status;
    if (retained.service_config_sha256 !== await sqliteServiceConfigHash(config)) {
      const historical = await completedDomainConfiguration(root, config, retained.service_config_sha256);
      if (!historical) throw new Error("No exact completed domain transition permits archiving the old draft");
      status = await new SqlitePublicationClient(historical, key, options.transport).observe(retained.publication.request);
      if (status) requireSqliteStatus(retained.publication.request, retained.publication.request_sha256, status, retained.publication.status);
    } else {
      const previous = await SqliteDraft.open(root, config, retained.target, draftOptions);
      status = await previous.observe();
    }
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
      ...(inspected.base_show_metadata_sha256 ? { base_show_metadata_sha256: inspected.base_show_metadata_sha256,
        base_cover_sha256: inspected.base_cover_sha256 } : {}),
      ...(episodeCommand ? { expected_episode_lifecycle_version: inspected.expected_episode_lifecycle_version } : {}),
      ...(inspected.base_revision_id ? { base_revision_id: inspected.base_revision_id, base_metadata_sha256: inspected.base_metadata_sha256 } : {}) };
  }
  const draft = await SqliteDraft.open(root, config, target, draftOptions);
  if (publishing) {
    if (args[2]) {
      const audio = (await draft.read()).assets.find((entry) => entry.upload.asset === "audio");
      if (!audio || audio.source_path !== resolve(root, targetId.show_id, args[2])) throw new Error("MP3 argument differs from its staged source");
    }
    await draft.publish(options.expectedPreview); return draft.wait();
  }
  const staged = await draft.stage(showCommand ? { asset: "show" } : command === "update-episode-audio" ? { asset: "audio", audio_path: args[2] } : { asset: "episode_metadata" });
  return { job_id: staged.target.job_id, state: "staged", assets: staged.assets.map((entry) => entry.upload.asset) };
}
