import { z } from "zod";
import { parseShowMetadata, stringifyToml, validateId } from "@castloop/shared";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { administratorKey } from "./administrator-key";
import { SqliteServiceClient } from "./sqlite-service-client";
import { createLocalJournalStorage, writeSyncedLocalFile } from "./local-journal-storage";
import { syncLocalJournalDirectory } from "./local-journal-path";
import { initializeSqliteService, readSqliteInitialization } from "./sqlite-initialization";
import { readLocalMetadata } from "./local-metadata-read";
import { executeSqliteLifecycle, previewSqliteLifecycle } from "./sqlite-lifecycle";
import { readBoundedLocalJournal } from "./local-journal-read";
import { deploySqliteService } from "./sqlite-service-deploy";
import type { R2RestOptions, R2RestTransport } from "./verified-r2-put";
import { diagnoseShows } from "./diagnose";
import { draftPreview } from "./draft-preview";
import { showTemplate, episodeTemplate } from "./input-templates";
import { continueSqliteDomainChange, listSqliteDomains, sqliteDomainOperationStatus, startSqliteDomainChange } from "./sqlite-domain-operation";
import { sqliteDomainHostnameSchema } from "../../shared/src/sqlite-domain";
import { executeRevision, previewRevision, readRevisionPlanFile, syncLocalMetadata } from "./sqlite-revision-commands";
import { exportPreviewRss } from "./preview-rss";
import { SqliteScheduleClient } from "./sqlite-schedule-client";
import { cancelSqliteSchedule, previewCancelSqliteSchedule, previewRescheduleSqliteSchedule,
  rescheduleSqliteSchedule, publicationSchedule, reapproveSqliteSchedule } from "./sqlite-schedule";
import { publishSqliteContent } from "./sqlite-publish";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type SqliteCommandOptions = { workerSource?: () => Promise<string>; transport?: R2RestTransport; cloudflare?: R2RestOptions;
  previewOptions?: { mode?: "auto" | "local" | "remote"; rssOutput?: string };
  revisionOptions?: { cursor?: string; episodeId?: string; expectedRevision?: string; output?: string };
  domainOptions?: { zoneId?: string; operationId?: string; cursor?: string };
  listOptions?: { includeDeleted?: boolean; cursor?: string };
  diagnoseOptions?: { maxShows?: number; external?: boolean; environment?: Readonly<Record<string, string | undefined>> };
  verifyOptions?: { episodeId?: string };
  statsOptions?: { episodeId?: string; from?: string; to?: string; cursor?: string; retentionOperationId?: string };
  scheduleOptions?: { at?: string; timezone?: string; expectVersion?: string; cursor?: string };
  expectedPreview?: string;
  allowFuturePublishedAt?: boolean; confirmFuturePublishedAt?: (publishedAt: string) => Promise<boolean> };
export const SQLITE_COMMAND_ARGUMENTS: Record<string, readonly number[]> = {
  "preview-show": [1], "preview-episode": [1, 2],
  "list-show-revisions": [1], "list-episode-revisions": [1], "preview-show-revision": [2], "preview-episode-revision": [2],
  "revision-execute": [3], "sync-local-metadata": [0],
  "create-show": [1, 2], "create-episode": [1], "publish-show": [1], "publish-episode": [1, 2],
  "service-status": [0], "show-status": [1], "target-show": [1], "target-episode": [2],
  "list-shows": [0], "list-episodes": [1], "preview-show-lifecycle": [2], "preview-episode-lifecycle": [3],
  "lifecycle-execute": [3], "update-service": [0],
  diagnose: Array.from({ length: 20 }, (_, index) => index + 1),
  verify: [1],
  domain: [1, 2],
  stats: [1], "stats-retention": [2],
  "preview-episode-schedule": [1, 2], "schedule-episode": [1, 2],
  "preview-show-schedule": [1], "schedule-show": [1],
  "schedule-list": [1], "schedule-status": [2],
  "preview-schedule-reschedule": [2], "preview-schedule-cancel": [2], "preview-schedule-reapprove": [2],
  "schedule-reschedule": [2], "schedule-cancel": [2], "schedule-reapprove": [2],
};
const registrationSchema = z.object({ service_config_sha256: z.string().regex(/^[a-f0-9]{64}$/), show_id: z.string(), reservation_id: z.uuid(),
  phase: z.enum(["prepared", "registered"]) }).strict();

async function registeredShow(root: string, config: SqliteServiceConfig, showId: string, siteUrl: string | undefined, client: SqliteServiceClient): Promise<string> {
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
    let registered = state.phase === "registered";
    if (!registered) {
      const current = await client.registration(showId);
      if (current.state === "registered" && current.reservation_id === reservationId) registered = true;
    }
    const target = registered ? await client.inspect(showId) : await client.register({ service_id: config.service_id, service_config_sha256: configHash,
      operation_id: crypto.randomUUID() }, showId, reservationId);
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
    if (episode ? args.length < 2 || args.length > 3 : args.length !== 1) throw new Error("Invalid preview arguments");
    const mode = options.previewOptions?.mode ?? "auto";
    const client = mode === "local" || !options.transport ? undefined : new SqliteServiceClient(config, administratorKey(root), options.transport);
    const result = await draftPreview(root, config, { kind: episode ? "episode" : "show", show_id: validateId(args[0], "show"),
      ...(episode ? { episode_id: validateId(args[1], "episode"), audio_path: args[2] } : {}) }, { mode, client });
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
  if (command === "init") {
    if (args.length > 1 || !options.workerSource) throw new Error("Invalid SQLite initialization arguments");
    return initializeSqliteService(root, config, args[0] ?? readSqliteInitialization(root, config)?.operation_id ?? crypto.randomUUID(),
      await options.workerSource(), cf);
  }
  if (command === "verify" && args.length === 1) {
    const { verifyShowDelivery } = await import("./verify");
    return verifyShowDelivery(root, config, validateId(args[0], "show"), options.verifyOptions?.episodeId, options.transport);
  }
  if (command === "stats" && args.length === 1) {
    const { readSqliteStats } = await import("./stats");
    return readSqliteStats(root, config, args[0], { episodeId: options.statsOptions?.episodeId,
      from: options.statsOptions?.from, to: options.statsOptions?.to, cursor: options.statsOptions?.cursor, transport: options.transport });
  }
  if (command === "stats-retention" && args.length === 2) {
    const { setSqliteStatsRetention } = await import("./stats");
    return setSqliteStatsRetention(root, config, validateId(args[0], "show"), z.number().int().parse(Number(args[1])),
      z.uuid().parse(options.statsOptions?.retentionOperationId), options.transport);
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
  if (command === "schedule-list" && args.length === 1) {
    return new SqliteScheduleClient(config, key, options.transport).list(validateId(args[0], "show"), options.scheduleOptions?.cursor);
  }
  if (command === "schedule-status" && args.length === 2) {
    return new SqliteScheduleClient(config, key, options.transport).status(validateId(args[0], "show"), z.uuid().parse(args[1]));
  }
  if (command === "preview-schedule-cancel" && args.length === 2) {
    return previewCancelSqliteSchedule(config, key, validateId(args[0], "show"), z.uuid().parse(args[1]), options.transport);
  }
  if (command === "preview-schedule-reschedule" && args.length === 2) {
    return previewRescheduleSqliteSchedule(root, config, key, validateId(args[0], "show"), z.uuid().parse(args[1]),
      options.scheduleOptions?.at ?? "", options.scheduleOptions?.timezone, options.transport);
  }
  if (command === "preview-schedule-reapprove" && args.length === 2) {
    return reapproveSqliteSchedule(root, config, validateId(args[0], "show"), z.uuid().parse(args[1]), options, false);
  }
  if (command === "schedule-cancel" && args.length === 2) {
    return cancelSqliteSchedule(config, key, validateId(args[0], "show"), z.uuid().parse(args[1]),
      z.number().int().positive().parse(Number(options.scheduleOptions?.expectVersion)), options.expectedPreview, options.transport);
  }
  if (command === "schedule-reschedule" && args.length === 2) {
    return rescheduleSqliteSchedule(root, config, key, validateId(args[0], "show"), z.uuid().parse(args[1]),
      options.scheduleOptions?.at ?? "", options.scheduleOptions?.timezone,
      z.number().int().positive().parse(Number(options.scheduleOptions?.expectVersion)), options.expectedPreview, options.transport);
  }
  if (command === "schedule-reapprove" && args.length === 2) {
    return reapproveSqliteSchedule(root, config, validateId(args[0], "show"), z.uuid().parse(args[1]), options, true);
  }
  if (command === "update-service" && !args.length && options.workerSource) return deploySqliteService(root, config, await options.workerSource(), cf);
  if (command === "service-status" && !args.length) return client.health();
  if (command === "show-status" && args.length === 1) return client.health(validateId(args[0], "show"));
  if (command === "diagnose") {
    return diagnoseShows(root, config, args.map((id) => validateId(id, "show")),
      { transport: options.transport, cloudflare: cf, maxShows: options.diagnoseOptions?.maxShows,
        external: options.diagnoseOptions?.external, environment: options.diagnoseOptions?.environment });
  }
  if (command === "list-shows" && !args.length || command === "list-episodes" && args.length === 1) {
    return client.catalog({ kind: command === "list-shows" ? "show" : "episode", ...(command === "list-episodes" ? { show_id: validateId(args[0], "show") } : {}),
      include_deleted: options.listOptions?.includeDeleted ?? false, ...(options.listOptions?.cursor ? { cursor: options.listOptions.cursor } : {}) });
  }
  if (command === "create-show" && (args.length === 1 || args.length === 2)) return registeredShow(root, config, validateId(args[0], "show"), args[1], client);
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
  const schedulePreview = ["preview-episode-schedule", "preview-show-schedule"].includes(command);
  const scheduleCreate = ["schedule-episode", "schedule-show"].includes(command);
  if (schedulePreview || scheduleCreate) {
    const showKind = ["preview-show-schedule", "schedule-show"].includes(command);
    const targetId = { kind: showKind ? "show" as const : "episode" as const, show_id: validateId(args[0], "show"),
      ...(showKind ? {} : { episode_id: validateId(args[1], "episode"), audio_path: args[2] }) };
    return publicationSchedule(root, config, targetId, options, scheduleCreate);
  }
  const showCommand = command === "publish-show", episodeCommand = command === "publish-episode";
  if (!showCommand && !episodeCommand) throw new Error(`Command ${command} is not implemented for sqlite-sequential-v1; no legacy fallback`);
  if (showCommand ? args.length !== 1 : args.length !== 2 && args.length !== 3) throw new Error("Invalid SQLite content command arguments");
  const targetId = { kind: showCommand ? "show" as const : "episode" as const, show_id: validateId(args[0], "show"),
    ...(episodeCommand ? { episode_id: validateId(args[1], "episode"), audio_path: args[2] } : {}) };
  return publishSqliteContent(root, config, targetId, options);
}
