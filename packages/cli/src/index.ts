#!/usr/bin/env bun

import { stringifyToml, validateId } from "@castloop/shared";
import { z } from "zod";
import { version } from "../../../package.json";
import { COMMAND_HELP, commandHelp, commandOptions, describeCommand } from "./help";
import { CONTRACT_VERSION, INPUT_SCHEMAS, inputSchema } from "./agent-schema";
import { AgentError, agentEnvelope } from "./agent-output";
import { SQLITE_COMMAND_ARGUMENTS } from "./sqlite-commands";
import { embeddedSqliteWorkerSource } from "./worker-payload";
import { loadWorkspaceConfig } from "./workspace-config";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import { writeSyncedLocalFile } from "./local-journal-storage";
import { syncLocalJournalDirectory } from "./local-journal-path";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI_VERSION = version;
const USAGE = `Usage: castloop COMMAND [arguments]\n\nCommands:\n  ${Object.keys(COMMAND_HELP).join("\n  ")}\n\nUse castloop help COMMAND for details.`;

function argsOf(values: string[], switches: string[] = []): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index]!;
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const name = item.slice(2);
    if (!name || name === "__proto__" || Object.hasOwn(flags, name)) throw new Error(`Invalid or missing value for ${item}`);
    if (switches.includes(name)) { flags[name] = "true"; continue; }
    if (!values[index + 1] || values[index + 1]!.startsWith("--")) throw new Error(`Invalid or missing value for ${item}`);
    flags[name] = values[++index]!;
  }
  return { positional, flags };
}

function allowedFlags(flags: Record<string, string>, allowed: string[]): void {
  for (const name of Object.keys(flags)) if (!allowed.includes(name)) throw new Error(`Unknown option: --${name}`);
}

async function ask(value: string | undefined, name: string, label: string): Promise<string> {
  if (value) return value;
  if (!process.stdin.isTTY || process.argv.includes("--non-interactive") || process.argv.includes("--json")) throw new AgentError("missing_input", `Missing --${name}`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${label}: `)).trim();
    if (!answer) throw new Error(`Missing --${name}`);
    return answer;
  } finally { prompt.close(); }
}

async function sqliteWorkerSource(): Promise<string> {
  if (embeddedSqliteWorkerSource) return embeddedSqliteWorkerSource;
  if (Bun.isStandaloneExecutable) throw new Error("The executable does not contain its SQLite Worker bundle");
  const result = await Bun.build({ entrypoints: [join(SOURCE_ROOT, "src/sqlite-worker.ts")], target: "browser", minify: true, external: ["cloudflare:workers"] });
  if (!result.success || result.outputs.length !== 1) throw new Error("SQLite Worker bundle build failed");
  return result.outputs[0].text();
}

async function init(target: string, flags: Record<string, string>, onStart: () => void): Promise<unknown> {
  allowedFlags(flags, ["publication-protocol", "service-id", "account-id", "bucket-name", "workers-subdomain", "operation-id"]);
  if (flags["publication-protocol"] && flags["publication-protocol"] !== "sqlite-sequential-v1") throw new Error("Unknown publication protocol");
  if (flags["operation-id"]) z.uuid().parse(flags["operation-id"]);
  const root = resolve(target);
  if (existsSync(root) && !lstatSync(root).isDirectory()) throw new Error("Workspace must be a real directory");
  const file = join(root, "castloop.toml");
  if (!existsSync(file)) {
    if (existsSync(join(root, ".castloop"))) throw new Error("Fresh SQLite initialization cannot adopt retained local state");
    const id = validateId(await ask(flags["service-id"], "service-id", "Service ID"), "service");
    const worker = `castloop-${id}-${randomBytes(4).toString("hex")}`;
    const subdomain = await ask(flags["workers-subdomain"], "workers-subdomain", "workers.dev subdomain");
    const origin = `https://${worker}.${subdomain}.workers.dev`;
    const config = sqliteServiceConfigSchema.parse({ schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: id,
      account_id: await ask(flags["account-id"] ?? process.env.CLOUDFLARE_ACCOUNT_ID, "account-id", "Cloudflare account ID"),
      bucket_name: await ask(flags["bucket-name"], "bucket-name", "Private R2 bucket name"), worker_name: worker,
      public_base_url: origin, workers_dev_base_url: origin });
    onStart();
    mkdirSync(root, { recursive: true });
    writeSyncedLocalFile(file, () => stringifyToml(config));
    syncLocalJournalDirectory(root);
  } else {
    await loadWorkspaceConfig(root);
    if (Object.keys(flags).some((name) => !["operation-id", "publication-protocol"].includes(name))) throw new Error("Do not change retained initialization inputs");
  }
  const config = await loadWorkspaceConfig(root);
  const { runSqliteCommand } = await import("./sqlite-commands");
  onStart();
  return runSqliteCommand(root, config, "init", flags["operation-id"] ? [flags["operation-id"]] : [], { workerSource: sqliteWorkerSource });
}

type Invocation = { target: { workspace?: string; show_id?: string }; mutationStarted: boolean; failureResult?: () => Promise<unknown> };

async function main(context: Invocation): Promise<unknown> {
  let [command, ...rest] = process.argv.slice(2);
  if (!command || (["help", "--help", "-h"].includes(command) && !rest.length)) return USAGE;
  if (command === "help" && rest.length === 1) return commandHelp(rest[0]!);
  if (rest.includes("--help") || rest.includes("-h")) return commandHelp(command);
  if (["version", "--version"].includes(command) && !rest.length) return CLI_VERSION;
  if (!Object.hasOwn(COMMAND_HELP, command)) throw new Error(`Unknown command: ${command}`);
  const listing = command === "list-shows" || command === "list-episodes";
  const operationRead = command === "operation-list" || command === "operation-status";
  const options = commandOptions(command);
  const { positional, flags } = argsOf(rest, Object.keys(options).filter((name) => options[name] === "boolean"));
  allowedFlags(flags, Object.keys(options));
  if (command === "describe") {
    if (positional.length > 1) throw new Error(commandHelp(command));
    return { contract_version: CONTRACT_VERSION, cli_version: CLI_VERSION, protocol: "sqlite-sequential-v1", storage_layout: "show-v1", schemas: [...Object.keys(INPUT_SCHEMAS), "result"],
      commands: positional.length ? [describeCommand(positional[0]!)] : Object.keys(COMMAND_HELP).map(describeCommand) };
  }
  if (command === "schema") {
    if (positional.length !== 1 || flags.format && flags.format !== "json-schema") throw new Error(commandHelp(command));
    return inputSchema(positional[0]!);
  }
  if (command === "validate") {
    if (positional.length !== 2) throw new AgentError("invalid_arguments", "Expected validate KIND FILE.");
    const { validateLocalInput } = await import("./local-input");
    return validateLocalInput(positional[0]!, resolve(positional[1]!), { assets: !!flags.assets, audio: flags.audio });
  }
  if (command === "skill") {
    if (positional.join(" ") !== "export castloop" || !flags.output) throw new AgentError("invalid_arguments", "Expected skill export castloop --output DIRECTORY.");
    const { exportAdminSkill } = await import("./admin-skill");
    context.mutationStarted = true;
    return exportAdminSkill(flags.output);
  }
  if (command === "template") {
    if (positional.length !== 1) throw new AgentError("invalid_arguments", "Expected template service-config|admin-config|show|episode.");
    const { inputTemplate } = await import("./input-templates");
    return inputTemplate(positional[0]!);
  }
  if (command === "doctor") {
    if (positional.length) throw new AgentError("invalid_arguments", "doctor accepts no positional arguments.");
    const { diagnoseLocal, formatDoctor } = await import("./doctor");
    const root = resolve(flags.workspace ?? process.cwd()); context.target.workspace = root;
    const result = await diagnoseLocal(root);
    if (result.summary.fail) process.exitCode = 1;
    return flags.json ? result : formatDoctor(result);
  }
  if (command === "backup-create" || command === "backup-verify" || command === "backup-restore-preview" || command === "backup-restore") {
    delete flags.json;
    delete flags["non-interactive"];
    const { backupPassphrase } = await import("./backup-passphrase");
    if (command === "backup-create") {
      allowedFlags(flags, ["workspace", "output", "include-audio", "passphrase-file"]);
      if (!flags.output) throw new AgentError("missing_input", "Expected backup-create --output FILE");
      const root = resolve(flags.workspace ?? process.cwd());
      context.target.workspace = root;
      const { createLocalBackup, formatBackupCreate } = await import("./backup-create");
      const passphrase = await backupPassphrase(flags, true);
      context.mutationStarted = true;
      const result = await createLocalBackup(root, resolve(flags.output), { includeAudio: !!flags["include-audio"], passphrase });
      return process.argv.includes("--json") ? result : formatBackupCreate(result);
    }
    if (command === "backup-verify") {
      allowedFlags(flags, ["passphrase-file"]);
      if (positional.length !== 1) throw new AgentError("invalid_arguments", "Expected backup-verify ARCHIVE.");
      const { verifyLocalBackup, formatBackupVerify } = await import("./backup-restore");
      const result = verifyLocalBackup(resolve(positional[0]!), await backupPassphrase(flags, false));
      return process.argv.includes("--json") ? result : formatBackupVerify(result);
    }
    if (command === "backup-restore-preview") {
      allowedFlags(flags, ["dest", "passphrase-file"]);
      if (positional.length !== 1 || !flags.dest) throw new AgentError("invalid_arguments", "Expected backup-restore-preview ARCHIVE --dest PATH.");
      const { previewBackupRestore, formatBackupRestorePreview } = await import("./backup-restore");
      const result = previewBackupRestore(resolve(positional[0]!), flags.dest, await backupPassphrase(flags, false));
      return process.argv.includes("--json") ? result : formatBackupRestorePreview(result);
    }
    allowedFlags(flags, ["passphrase-file"]);
    if (positional.length !== 3 || positional[2] !== "confirm") throw new AgentError("invalid_arguments", "Expected backup-restore ARCHIVE DEST confirm.");
    const { restoreLocalBackup, formatBackupRestore } = await import("./backup-restore");
    const passphrase = await backupPassphrase(flags, false);
    context.mutationStarted = true;
    const result = restoreLocalBackup(resolve(positional[0]!), resolve(positional[1]!), passphrase);
    context.target.workspace = result.restored_to;
    return process.argv.includes("--json") ? result : formatBackupRestore(result);
  }
  if (command === "preview-schedule-time") {
    if (positional.length !== 1) throw new AgentError("invalid_arguments", "Expected preview-schedule-time DATETIME.");
    const root = resolve(flags.workspace ?? process.cwd()); context.target.workspace = root;
    const { loadAdminConfig } = await import("./admin-config");
    const { resolveScheduleTime } = await import("./schedule-time");
    const admin = await loadAdminConfig(root);
    try {
      return { ...resolveScheduleTime(positional[0]!, { timezone: flags.timezone, configuredTimezone: admin.timezone }),
        server_time_checked: false, publication_ready: false };
    } catch {
      throw new AgentError("invalid_schedule_time", "Expected a valid ISO date/time and supported IANA zone; resolve DST ambiguity with an explicit offset matching --timezone.");
    }
  }
  delete flags.json;
  delete flags["non-interactive"];
  const explicitRoot = flags.workspace === undefined ? undefined : resolve(flags.workspace);
  const explicitShow = flags.show;
  delete flags.workspace;
  const episodeCommand = ["create-episode", "update-episode", "update-episode-audio", "publish-episode", "preview-episode", "list-episode-revisions", "preview-episode-revision"].includes(command);
  if (episodeCommand && explicitRoot && !explicitShow) throw new AgentError("missing_show", "Explicit --workspace requires --show for Episode commands.");
  if (explicitShow) {
    validateId(explicitShow, "show");
    if (!episodeCommand && !command.startsWith("operation-") && command !== "sync-local-metadata") throw new AgentError("invalid_options", "This command does not accept --show; use its Show positional argument.");
  }
  if (episodeCommand) delete flags.show;
  const expectedPreview = flags["expect-preview"];
  delete flags["expect-preview"];
  if (expectedPreview && !/^[a-f0-9]{64}$/.test(expectedPreview)) throw new AgentError("invalid_fingerprint", "Expected a SHA-256 preview fingerprint.");
  context.target = { ...(explicitRoot ? { workspace: explicitRoot } : {}), ...(explicitShow ? { show_id: explicitShow } : {}) };
  if (command === "import-rss") {
    allowedFlags(flags, ["dry-run", "output"]);
    if (positional.length !== 2 || Boolean(flags["dry-run"]) === Boolean(flags.output)) throw new Error(commandHelp(command));
    const { importRssLocally, inspectRssImport } = await import("./rss-import-local");
    context.mutationStarted = !!flags.output;
    return flags["dry-run"] ? inspectRssImport(positional[0]!, positional[1]!) : importRssLocally(positional[0]!, positional[1]!, flags.output!);
  }
  if (command === "publish-rss-import") {
    allowedFlags(flags, []);
    if (positional.length !== 1) throw new Error(commandHelp(command));
    const root = explicitRoot ?? process.cwd();
    const config = await loadWorkspaceConfig(root);
    const { publishSqliteRssImport } = await import("./sqlite-rss-publication");
    context.mutationStarted = true;
    return publishSqliteRssImport(root, config, positional[0]!);
  }
  if (command === "init") {
    if (positional.length > 1) throw new Error(commandHelp(command));
    if (explicitRoot && positional[0] && resolve(positional[0]) !== explicitRoot) throw new AgentError("target_mismatch", "init target and --workspace differ.");
    context.target.workspace = explicitRoot ?? resolve(positional[0] ?? ".");
    return init(context.target.workspace, flags, () => { context.mutationStarted = true; });
  }
  let root = explicitRoot ?? process.cwd();
  const watchSignal = command === "watch" ? new AbortController() : undefined;
  if (watchSignal) process.once("SIGINT", () => watchSignal.abort());
  if (command === "create-show") {
    allowedFlags(flags, ["site-url", "site-mode"]);
    if (positional.length !== 1) throw new Error(commandHelp(command));
    if (flags["site-mode"] !== undefined && !["builtin", "external"].includes(flags["site-mode"])) throw new Error("Choose --site-mode builtin or external");
    if (flags["site-mode"] === "builtin") {
      if (flags["site-url"] !== undefined) throw new Error("Builtin sites do not accept --site-url");
    } else positional.push(await ask(flags["site-url"], "site-url", "Show website URL"));
  } else if (command === "deploy") {
    allowedFlags(flags, ["operation-id"]);
    if (positional.length) throw new Error(commandHelp(command));
    command = "update-service";
    positional.push(flags["operation-id"] ?? randomUUID());
  } else if (command === "domain") {
    const [action] = positional;
    allowedFlags(flags, action === "add" ? ["zone-id", "operation-id"] : action === "remove" ? ["operation-id"] : action === "status" ? ["cursor"] : []);
    if (action === "add" && (positional.length !== 2 || !flags["zone-id"]) ||
      ["status", "continue"].includes(action ?? "") && positional.length !== 2 ||
      ["list", "remove"].includes(action ?? "") && positional.length !== 1 ||
      !["add", "remove", "list", "status", "continue"].includes(action ?? "")) throw new Error(commandHelp(command));
    if (["add", "remove"].includes(action)) flags["operation-id"] ??= randomUUID();
  } else if (["preview-show", "preview-episode"].includes(command)) {
    allowedFlags(flags, ["local", "remote", "rss-output"]);
    if (flags.local && flags.remote || flags.local && flags["rss-output"]) throw new Error("Choose remote RSS export or local-only preview, not both");
  } else if (["list-show-revisions", "list-episode-revisions"].includes(command)) {
    allowedFlags(flags, ["cursor"]);
  } else if (command === "sync-local-metadata") {
    allowedFlags(flags, ["show", "episode", "expect-revision", "output"]);
    if (!explicitShow || !flags["expect-revision"]) throw new Error("Metadata export requires --show and --expect-revision");
    if (flags.episode) validateId(flags.episode, "episode");
  } else if (listing) {
    allowedFlags(flags, ["json", "include-deleted", "cursor"]);
  } else if (operationRead) {
    allowedFlags(flags, command === "operation-list" ? ["show", "local", "remote", "incomplete", "cursor", "parent", "json"] : ["show", "local", "remote", "after-version", "request-cursor", "json"]);
    if (flags.local && flags.remote) throw new Error("Choose --local or --remote");
  } else if (command.startsWith("operation-")) {
    allowedFlags(flags, ["show"]);
  } else if (command === "diagnose") {
    allowedFlags(flags, ["max-shows", "external"]);
  } else if (command === "progress") {
    allowedFlags(flags, []);
  } else if (command === "verify") {
    allowedFlags(flags, ["episode"]);
  } else if (command === "stats") {
    allowedFlags(flags, ["episode", "from", "to", "by-revision", "cursor"]);
  } else if (command === "stats-retention") {
    allowedFlags(flags, ["operation-id"]);
  } else if (command === "watch") {
    allowedFlags(flags, ["timeout", "interval"]);
  } else {
    allowedFlags(flags, []);
  }
  const count = SQLITE_COMMAND_ARGUMENTS[command];
  if (count === undefined || !count.includes(positional.length)) throw new Error(commandHelp(command === "update-service" ? "deploy" : command));
  if (["preview-show-lifecycle", "preview-episode-lifecycle"].includes(command) && !["unpublish", "restore"].includes(positional.at(-1)!) ||
    ["lifecycle-execute", "revision-execute"].includes(command) && positional[2] !== "confirm") throw new Error(commandHelp(command));
  if (episodeCommand) {
    const showId = validateId(explicitShow ?? basename(root), "show");
    positional.unshift(showId);
    if (!explicitRoot && !explicitShow) root = resolve(root, "..");
    context.target.show_id = showId;
  }
  if (command === "sync-local-metadata") positional.push(explicitShow!);
  context.target.workspace = root;
  const workspace = await loadWorkspaceConfig(root);
  if (["show-status", "show-pause", "show-resume", "show-admission-pause", "show-delivery-resume", "show-control-status"].includes(command)) {
    context.target.show_id = validateId(positional[0], "show");
  }
  if (command === "domain" && !["list", "status"].includes(positional[0])) {
    const operationId = positional[0] === "continue" ? positional[1] : flags["operation-id"];
    context.failureResult = async () => {
      const { readSqliteDomainJournal } = await import("./sqlite-domain-journal");
      const record = readSqliteDomainJournal(root, workspace, operationId);
      return record ? { operation_id: operationId, phase: record.phase, last_known_only: true } : null;
    };
  }
  if (["update-show", "publish-show", "update-episode", "update-episode-audio", "publish-episode"].includes(command)) {
    const showId = validateId(positional[0], "show"); context.target.show_id = showId;
    const target = { kind: episodeCommand ? "episode" as const : "show" as const, show_id: showId,
      ...(episodeCommand ? { episode_id: validateId(positional[1], "episode") } : {}) };
    context.failureResult = async () => {
      const { readSqliteDraftRecord } = await import("./sqlite-draft-journal");
      const record = await readSqliteDraftRecord(root, workspace, target);
      return record ? { job_id: record.target.job_id, state: record.publication?.status?.state ?? (record.publication ? "unknown" : "draft"),
        last_known_only: true, publication_requested: !!record.publication } : null;
    };
  }
  if (command === "revision-execute") {
    context.failureResult = async () => {
      const { revisionProgress } = await import("./sqlite-revision-commands");
      return revisionProgress(root, workspace, resolve(root, positional[0]!));
    };
  }
  const { runSqliteCommand } = await import("./sqlite-commands");
  const effects = describeCommand(command === "update-service" ? "deploy" : command).effects;
  context.mutationStarted = command === "domain" && ["list", "status"].includes(positional[0]) ? false : effects.remote === "may_mutate" || effects.local === "may_write_records";
  const result = await runSqliteCommand(root, workspace, command, positional, { workerSource: sqliteWorkerSource,
    previewOptions: { mode: flags.local ? "local" : flags.remote ? "remote" : "auto", rssOutput: flags["rss-output"] },
    revisionOptions: { cursor: flags.cursor, episodeId: flags.episode, expectedRevision: flags["expect-revision"], output: flags.output },
    ...(command === "domain" ? { domainOptions: { zoneId: flags["zone-id"], operationId: flags["operation-id"], cursor: flags.cursor } } : {}),
    ...(command.startsWith("operation-") ? { operationOptions: { showId: flags.show, local: !!flags.local, incomplete: !!flags.incomplete, cursor: flags.cursor, parent: flags.parent,
      afterVersion: flags["after-version"] === undefined ? undefined : Number(flags["after-version"]), requestCursor: flags["request-cursor"] } } : {}),
    ...(command === "diagnose" ? { diagnoseOptions: { maxShows: flags["max-shows"] === undefined ? undefined : Number(flags["max-shows"]),
      external: !!flags.external, environment: undefined } } : {}),
    ...(command === "verify" ? { verifyOptions: { episodeId: flags.episode } } : {}),
    ...(command === "stats" ? { statsOptions: { episodeId: flags.episode, from: flags.from, to: flags.to, cursor: flags.cursor } } : {}),
    ...(command === "stats-retention" ? { statsOptions: { retentionOperationId: flags["operation-id"] ?? randomUUID() } } : {}),
    ...(command === "watch" ? { watchOptions: { timeoutSeconds: flags.timeout === undefined ? undefined : Number(flags.timeout),
      intervalSeconds: flags.interval === undefined ? undefined : Number(flags.interval), signal: watchSignal?.signal } } : {}),
    ...(listing ? { listOptions: { cursor: flags.cursor, includeDeleted: !!flags["include-deleted"] } } : {}), expectedPreview });
  if (listing && !process.argv.includes("--json")) {
    const { formatSqliteCatalog } = await import("./sqlite-catalog");
    const { sqliteCatalogResponseSchema } = await import("../../shared/src/sqlite-catalog");
    return formatSqliteCatalog(sqliteCatalogResponseSchema.parse(result));
  }
  if (command === "diagnose") {
    const { diagnoseResultSchema, formatDiagnose } = await import("./diagnose");
    const diagnosed = diagnoseResultSchema.parse(result);
    if (diagnosed.summary.fail) process.exitCode = 1;
    if (!process.argv.includes("--json")) return formatDiagnose(diagnosed);
  }
  if (command === "progress" && !process.argv.includes("--json")) {
    const { formatProgress, progressResultSchema } = await import("./progress");
    return formatProgress(progressResultSchema.parse(result));
  }
  if (command === "verify") {
    const { verifyResultSchema, formatVerify } = await import("./verify");
    const verified = verifyResultSchema.parse(result);
    if (verified.summary.fail) process.exitCode = 1;
    if (!process.argv.includes("--json")) return formatVerify(verified);
  }
  if (command === "stats" && !process.argv.includes("--json")) {
    const { formatSqliteStatsDaily, formatSqliteStatsEpisodes } = await import("./stats");
    if (flags.episode) {
      const { sqliteStatsEpisodeDailyResponseSchema } = await import("../../shared/src/sqlite-stats");
      return formatSqliteStatsDaily(sqliteStatsEpisodeDailyResponseSchema.parse(result), !!flags["by-revision"]);
    }
    const { sqliteStatsEpisodesResponseSchema } = await import("../../shared/src/sqlite-stats");
    return formatSqliteStatsEpisodes(sqliteStatsEpisodesResponseSchema.parse(result));
  }
  if (command === "watch") {
    if (watchSignal?.signal.aborted) process.exit(130);
    const { watchResultSchema, formatWatch, watchExitCode } = await import("./watch");
    const watched = watchResultSchema.parse(result);
    process.exitCode = watchExitCode(watched);
    if (!process.argv.includes("--json")) return formatWatch(watched);
  }
  return result;
}

const invocation: Invocation = { target: {}, mutationStarted: false };
try {
  const result = await main(invocation);
  const command = process.argv[2] ?? "help";
  const output = process.argv.includes("--json") && !["schema", "describe"].includes(command) ? agentEnvelope(command, invocation.target, result,
    process.exitCode === 1 ? new AgentError("diagnostic_failed", "One or more local checks failed.") : undefined) : result;
  console.log(typeof output === "string" ? output : JSON.stringify(output, null, 2));
} catch (error) {
  let retained: unknown = null;
  if (invocation.failureResult) {
    try { retained = await invocation.failureResult(); }
    catch { retained = { records_unavailable: true }; }
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(agentEnvelope(process.argv[2] ?? "help", invocation.target, retained, error, invocation.mutationStarted), null, 2));
  else console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}
