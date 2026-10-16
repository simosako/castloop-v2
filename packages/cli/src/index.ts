#!/usr/bin/env bun

import { contentListResponseSchema, serviceConfigSchema, stringifyToml, validateId } from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";
import { version } from "../../../package.json";
import { administratorKey } from "./administrator-key";
import { CloudflareApi } from "./cloudflare-api";
import { formatContentList } from "./content-list";
import { runDomainCommand } from "./domain-operation";
import { COMMAND_HELP, commandHelp } from "./help";
import { readLocalOperationStatus } from "./local-operation-status";
import { M6_COMMAND_ARGUMENTS, runM6Command } from "./m6-commands";
import { readLocalFreshM6Initialization } from "./m6-service-initialization";
import { MigrationAdminClient } from "./migration-client";
import { readLocalMigrationSetup } from "./migration-setup-journal";
import { embeddedWorkerSource, embeddedSqliteWorkerSource } from "./worker-payload";
import { loadWorkspaceConfig } from "./workspace-config";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import { writeSyncedLocalFile } from "./local-journal-storage";
import { syncLocalJournalDirectory } from "./local-journal-path";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  if (!process.stdin.isTTY) throw new Error(`Missing --${name}`);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${label}: `)).trim();
    if (!answer) throw new Error(`Missing --${name}`);
    return answer;
  } finally { prompt.close(); }
}

async function workerSource(): Promise<string> {
  if (embeddedWorkerSource) return embeddedWorkerSource;
  if (Bun.isStandaloneExecutable) throw new Error("The executable does not contain a Worker bundle");
  const result = await Bun.build({ entrypoints: [join(SOURCE_ROOT, "src/worker.ts")],
    target: "browser", minify: true, external: ["cloudflare:workers"] });
  if (!result.success || result.outputs.length !== 1) throw new Error("Worker bundle build failed");
  return result.outputs[0]!.text();
}

function loadConfig(root: string): ServiceConfig {
  const config = loadWorkspaceConfig(root);
  if (config.schema_version !== 1) throw new Error("This command is not implemented for sqlite-sequential-v1; no legacy fallback");
  return config;
}

async function sqliteWorkerSource(): Promise<string> {
  if (embeddedSqliteWorkerSource) return embeddedSqliteWorkerSource;
  if (Bun.isStandaloneExecutable) throw new Error("The executable does not contain its SQLite Worker bundle");
  const result = await Bun.build({ entrypoints: [join(SOURCE_ROOT, "src/sqlite-worker.ts")], target: "browser", minify: true, external: ["cloudflare:workers"] });
  if (!result.success || result.outputs.length !== 1) throw new Error("SQLite Worker bundle build failed");
  return result.outputs[0].text();
}

async function initSqlite(target: string, flags: Record<string, string>): Promise<unknown> {
  allowedFlags(flags, ["publication-protocol", "service-id", "account-id", "bucket-name", "workers-subdomain", "operation-id"]);
  if (flags["publication-protocol"] && flags["publication-protocol"] !== "sqlite-sequential-v1") throw new Error("Unknown publication protocol");
  const root = resolve(target); mkdirSync(root, { recursive: true });
  if (!lstatSync(root).isDirectory()) throw new Error("Workspace must be a real directory");
  const file = join(root, "castloop.toml");
  if (!existsSync(file)) {
    if (existsSync(join(root, ".castloop"))) throw new Error("Fresh SQLite initialization cannot adopt retained local state");
    const id = validateId(await ask(flags["service-id"], "service-id", "Service ID"), "service");
    const worker = `castloop-${id}-${randomBytes(4).toString("hex")}`;
    const subdomain = await ask(flags["workers-subdomain"], "workers-subdomain", "workers.dev subdomain");
    const origin = `https://${worker}.${subdomain}.workers.dev`;
    const config = sqliteServiceConfigSchema.parse({ schema_version: 2, publication_protocol: "sqlite-sequential-v1", service_id: id,
      account_id: await ask(flags["account-id"] ?? process.env.CLOUDFLARE_ACCOUNT_ID, "account-id", "Cloudflare account ID"),
      bucket_name: await ask(flags["bucket-name"], "bucket-name", "Private R2 bucket name"), worker_name: worker,
      public_base_url: origin, workers_dev_base_url: origin });
    writeSyncedLocalFile(file, () => stringifyToml(config));
    syncLocalJournalDirectory(root);
  } else if (Object.keys(flags).some((name) => !["operation-id", "publication-protocol"].includes(name))) throw new Error("Do not change retained initialization inputs");
  const config = loadWorkspaceConfig(root);
  if (config.schema_version !== 2) throw new Error("Existing service config is not converted to sqlite-sequential-v1");
  const { runSqliteCommand } = await import("./sqlite-commands");
  return runSqliteCommand(root, config, "init", flags["operation-id"] ? [flags["operation-id"]] : [], { workerSource: sqliteWorkerSource });
}

async function init(target: string, flags: Record<string, string>): Promise<unknown> {
  allowedFlags(flags, ["service-id", "account-id", "bucket-name", "workers-subdomain", "operation-id"]);
  const root = resolve(target);
  mkdirSync(root, { recursive: true });
  if (!lstatSync(root).isDirectory()) throw new Error("Workspace must be a real directory");
  if (existsSync(join(root, ".castloop", "state.json"))) throw new Error("Legacy workspaces are not converted; initialize a new M6 workspace");
  const file = join(root, "castloop.toml");
  if (!existsSync(file)) {
    const serviceId = validateId(await ask(flags["service-id"], "service-id", "Service ID"), "service");
    const suffix = randomBytes(4).toString("hex");
    const accountId = await ask(flags["account-id"] ?? process.env.CLOUDFLARE_ACCOUNT_ID, "account-id", "Cloudflare account ID");
    const bucketName = await ask(flags["bucket-name"], "bucket-name", "Private R2 bucket name");
    const subdomain = await ask(flags["workers-subdomain"], "workers-subdomain", "workers.dev subdomain");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain)) throw new Error("Invalid workers.dev subdomain");
    const workerName = `castloop-${serviceId}-${suffix}`;
    const workersDevBaseUrl = `https://${workerName}.${subdomain}.workers.dev`;
    const config = serviceConfigSchema.parse({ schema_version: 1, service_id: serviceId, account_id: accountId,
      bucket_name: bucketName, worker_name: workerName, queue_name: workerName,
      dlq_name: `castloop-${serviceId}-dlq-${suffix}`, public_base_url: workersDevBaseUrl, workers_dev_base_url: workersDevBaseUrl });
    writeFileSync(file, stringifyToml(config), { flag: "wx" });
  } else if (Object.keys(flags).some((name) => name !== "operation-id")) {
    throw new Error("Workspace configuration already exists; do not change its initialization inputs");
  }
  const config = loadConfig(root);
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== config.account_id || !process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this service before provisioning");
  }
  const retained = readLocalFreshM6Initialization(root, config);
  if (retained.lockPresent || retained.state && retained.state.phase !== "prepared") {
    throw new Error("Initialization already started; inspect its journal or use init-reconcile only for an acknowledged completed initialization");
  }
  const ignore = join(root, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "");
  const existing = readFileSync(ignore, "utf8");
  const additions = [".castloop/", "*.mp3"].filter((line) => !existing.split(/\r?\n/).includes(line));
  if (additions.length) appendFileSync(ignore, `${existing && !existing.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`);
  return runM6Command(root, config, "init", [flags["operation-id"] ?? retained.state?.request.operation_id ?? randomUUID()], { workerSource });
}

async function main(): Promise<unknown> {
  let [command, ...rest] = process.argv.slice(2);
  if (!command || (["help", "--help", "-h"].includes(command) && !rest.length)) return USAGE;
  if (command === "help" && rest.length === 1) return commandHelp(rest[0]!);
  if (rest.includes("--help") || rest.includes("-h")) return commandHelp(command);
  if (["version", "--version"].includes(command) && !rest.length) return CLI_VERSION;
  if (!Object.hasOwn(COMMAND_HELP, command)) throw new Error(`Unknown command: ${command}`);
  const listing = command === "list-shows" || command === "list-episodes";
  const { positional, flags } = argsOf(rest, listing ? ["json", "include-deleted"] : command === "migration-status" ? ["local"] : command === "import-rss" ? ["dry-run"] : []);
  if (command === "import-rss") {
    allowedFlags(flags, ["dry-run", "output"]);
    if (positional.length !== 2 || Boolean(flags["dry-run"]) === Boolean(flags.output)) throw new Error(commandHelp(command));
    const { importRssLocally, inspectRssImport } = await import("./rss-import-local");
    return flags["dry-run"] ? inspectRssImport(positional[0]!, positional[1]!) : importRssLocally(positional[0]!, positional[1]!, flags.output!);
  }
  if (command === "publish-rss-import") {
    allowedFlags(flags, []);
    if (positional.length !== 1) throw new Error(commandHelp(command));
    const root = process.cwd();
    const config = loadConfig(root);
    const { createRssPublicationEffects, publishRssImport } = await import("./rss-import-publication");
    return publishRssImport(root, config, positional[0]!, createRssPublicationEffects(root, config, workerSource));
  }
  if (command === "init") {
    if (positional.length > 1) throw new Error(commandHelp(command));
    const root = resolve(positional[0] ?? ".");
    if (flags["publication-protocol"] || existsSync(join(root, "castloop.toml")) && loadWorkspaceConfig(root).schema_version === 2) return initSqlite(root, flags);
    return init(positional[0] ?? ".", flags);
  }
  if (command === "domain") {
    allowedFlags(flags, ["operation-id"]);
    const action = positional[0];
    if (!["add", "list", "remove"].includes(action ?? "") || positional.length !== (action === "add" ? 2 : 1) ||
      action === "list" && flags["operation-id"]) throw new Error(commandHelp(command));
    return runDomainCommand(process.cwd(), loadConfig(process.cwd()), action as "add" | "list" | "remove", positional[1], flags["operation-id"]);
  }
  let root = process.cwd();
  if (command === "create-show") {
    allowedFlags(flags, ["site-url"]);
    if (positional.length !== 1) throw new Error(commandHelp(command));
    positional.push(await ask(flags["site-url"], "site-url", "Show website URL"));
  } else if (command === "deploy") {
    allowedFlags(flags, ["operation-id"]);
    if (positional.length) throw new Error(commandHelp(command));
    command = "update-service";
    positional.push(flags["operation-id"] ?? randomUUID());
  } else if (listing) {
    allowedFlags(flags, ["json", "include-deleted", "cursor"]);
  } else {
    allowedFlags(flags, command === "migration-status" ? ["local"] : []);
  }
  if (["create-episode", "update-episode", "update-episode-audio", "publish-episode"].includes(command)) {
    positional.unshift(validateId(basename(root), "show"));
    root = resolve(root, "..");
  }
  if (listing && positional.length !== M6_COMMAND_ARGUMENTS[command]) throw new Error(commandHelp(command));
  const workspace = loadWorkspaceConfig(root);
  if (workspace.schema_version === 2) {
    const { runSqliteCommand } = await import("./sqlite-commands");
    const result = await runSqliteCommand(root, workspace, command, positional, { workerSource: sqliteWorkerSource,
      ...(listing ? { listOptions: { cursor: flags.cursor, includeDeleted: !!flags["include-deleted"] } } : {}) });
    if (listing && !flags.json) {
      const { formatSqliteCatalog } = await import("./sqlite-catalog");
      const { sqliteCatalogResponseSchema } = await import("../../shared/src/sqlite-catalog");
      return formatSqliteCatalog(sqliteCatalogResponseSchema.parse(result));
    }
    return result;
  }
  if (command === "job-status") { command = "operation-status"; positional.unshift("publication"); }
  if (command === "retry-job") command = "publication-retry";
  if (command === "release-job") command = "publication-release";
  if (Object.hasOwn(M6_COMMAND_ARGUMENTS, command)) {
    const count = command === "publish-episode" && positional.length === 2 ? 2 : M6_COMMAND_ARGUMENTS[command];
    if (positional.length !== count) throw new Error(listing ? commandHelp(command) : "Invalid command arguments; use --help");
    const result = await runM6Command(root, loadConfig(root), command, positional, { workerSource,
      ...(listing ? { listOptions: { cursor: flags.cursor, includeDeleted: !!flags["include-deleted"] } } : {}) });
    return listing && !flags.json ? formatContentList(contentListResponseSchema.parse(result)) : result;
  }
  const config = loadConfig(root);
  if (command === "local-operation-status" && positional.length === 2) return readLocalOperationStatus(root, config, positional[0]!, positional[1]!);
  if (command === "migration-preflight" && positional.length === 1) return new CloudflareApi(config).inspectLegacyService(config, positional[0]!);
  if (command === "migration-status" && !positional.length) return flags.local ? readLocalMigrationSetup(root, config) : new MigrationAdminClient(config, administratorKey(root)).status();
  throw new Error("Invalid command arguments; use --help");
}

try {
  const result = await main();
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}
