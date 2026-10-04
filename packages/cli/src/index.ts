#!/usr/bin/env bun

import { contentListResponseSchema, parseServiceConfig, serviceConfigSchema, stringifyToml, validateId } from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";
import { version } from "../../../package.json";
import { administratorKey } from "./administrator-key";
import { CloudflareApi } from "./cloudflare-api";
import { formatContentList } from "./content-list";
import { COMMAND_HELP, commandHelp } from "./help";
import { readLocalOperationStatus } from "./local-operation-status";
import { M6_COMMAND_ARGUMENTS, runM6Command } from "./m6-commands";
import { readLocalFreshM6Initialization } from "./m6-service-initialization";
import { MigrationAdminClient } from "./migration-client";
import { readLocalMigrationSetup } from "./migration-setup-journal";
import { embeddedWorkerSource } from "./worker-payload";
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
  return parseServiceConfig(readFileSync(join(root, "castloop.toml"), "utf8"));
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
    const config = serviceConfigSchema.parse({ schema_version: 1, service_id: serviceId, account_id: accountId,
      bucket_name: bucketName, worker_name: workerName, queue_name: workerName,
      dlq_name: `castloop-${serviceId}-dlq-${suffix}`, public_base_url: `https://${workerName}.${subdomain}.workers.dev` });
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
  const { positional, flags } = argsOf(rest, listing ? ["json", "include-deleted"] : command === "migration-status" ? ["local"] : []);
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
  } else {
    allowedFlags(flags, command === "migration-status" ? ["local"] : []);
  }
  if (["create-episode", "update-episode", "update-episode-audio", "publish-episode"].includes(command)) {
    positional.unshift(validateId(basename(root), "show"));
    root = resolve(root, "..");
  }
  if (command === "job-status") { command = "operation-status"; positional.unshift("publication"); }
  if (command === "retry-job") command = "publication-retry";
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
