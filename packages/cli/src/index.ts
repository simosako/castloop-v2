#!/usr/bin/env bun

import { stringifyToml, validateId } from "@castloop/shared";
import { version } from "../../../package.json";
import { COMMAND_HELP, commandHelp } from "./help";
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
  if (!process.stdin.isTTY) throw new Error(`Missing --${name}`);
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

async function init(target: string, flags: Record<string, string>): Promise<unknown> {
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
  } else {
    await loadWorkspaceConfig(root);
    if (Object.keys(flags).some((name) => !["operation-id", "publication-protocol"].includes(name))) throw new Error("Do not change retained initialization inputs");
  }
  const config = await loadWorkspaceConfig(root);
  const { runSqliteCommand } = await import("./sqlite-commands");
  return runSqliteCommand(root, config, "init", flags["operation-id"] ? [flags["operation-id"]] : [], { workerSource: sqliteWorkerSource });
}

async function main(): Promise<unknown> {
  let [command, ...rest] = process.argv.slice(2);
  if (!command || (["help", "--help", "-h"].includes(command) && !rest.length)) return USAGE;
  if (command === "help" && rest.length === 1) return commandHelp(rest[0]!);
  if (rest.includes("--help") || rest.includes("-h")) return commandHelp(command);
  if (["version", "--version"].includes(command) && !rest.length) return CLI_VERSION;
  if (!Object.hasOwn(COMMAND_HELP, command)) throw new Error(`Unknown command: ${command}`);
  const listing = command === "list-shows" || command === "list-episodes";
  const operationRead = command === "operation-list" || command === "operation-status";
  const { positional, flags } = argsOf(rest, listing ? ["json", "include-deleted"] : operationRead ? ["local", "remote", "incomplete", "json"] : command === "import-rss" ? ["dry-run"] : []);
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
    const config = await loadWorkspaceConfig(root);
    const { publishSqliteRssImport } = await import("./sqlite-rss-publication");
    return publishSqliteRssImport(root, config, positional[0]!);
  }
  if (command === "init") {
    if (positional.length > 1) throw new Error(commandHelp(command));
    return init(positional[0] ?? ".", flags);
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
  } else if (operationRead) {
    allowedFlags(flags, command === "operation-list" ? ["local", "remote", "incomplete", "cursor", "parent", "json"] : ["local", "remote", "after-version", "request-cursor", "json"]);
    if (flags.local && flags.remote) throw new Error("Choose --local or --remote");
  } else {
    allowedFlags(flags, []);
  }
  const count = SQLITE_COMMAND_ARGUMENTS[command];
  if (count === undefined || !count.includes(positional.length)) throw new Error(commandHelp(command === "update-service" ? "deploy" : command));
  if (["preview-show-lifecycle", "preview-episode-lifecycle"].includes(command) && !["unpublish", "restore"].includes(positional.at(-1)!) ||
    command === "lifecycle-execute" && positional[2] !== "confirm") throw new Error(commandHelp(command));
  if (["create-episode", "update-episode", "update-episode-audio", "publish-episode"].includes(command)) {
    positional.unshift(validateId(basename(root), "show"));
    root = resolve(root, "..");
  }
  const workspace = await loadWorkspaceConfig(root);
  const { runSqliteCommand } = await import("./sqlite-commands");
  const result = await runSqliteCommand(root, workspace, command, positional, { workerSource: sqliteWorkerSource,
    ...(operationRead ? { operationOptions: { local: !!flags.local, incomplete: !!flags.incomplete, cursor: flags.cursor, parent: flags.parent,
      afterVersion: flags["after-version"] === undefined ? undefined : Number(flags["after-version"]), requestCursor: flags["request-cursor"] } } : {}),
    ...(listing ? { listOptions: { cursor: flags.cursor, includeDeleted: !!flags["include-deleted"] } } : {}) });
  if (listing && !flags.json) {
    const { formatSqliteCatalog } = await import("./sqlite-catalog");
    const { sqliteCatalogResponseSchema } = await import("../../shared/src/sqlite-catalog");
    return formatSqliteCatalog(sqliteCatalogResponseSchema.parse(result));
  }
  return result;
}

try {
  const result = await main();
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
}
