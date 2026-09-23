#!/usr/bin/env bun

import {
  parseEpisodeDraft, parseServiceConfig, parseShowMetadata, serviceConfigSchema,
  showMetadataSchema, stringifyToml, validateId,
} from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

type LocalState = { shows: Record<string, { reservation_id: string; confirmed: boolean }>; init_steps: string[] };
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WRANGLER = join(SOURCE_ROOT, "node_modules/.bin/wrangler");

function argsOf(values: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const name = item.slice(2);
    if (!name || !values[index + 1] || values[index + 1].startsWith("--") || flags[name]) {
      throw new Error(`Invalid or missing value for ${item}`);
    }
    flags[name] = values[++index];
  }
  return { positional, flags };
}

function allowedFlags(flags: Record<string, string>, allowed: string[]): void {
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) throw new Error(`Unknown option: --${name}`);
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function ask(value: string | undefined, name: string, label: string): Promise<string> {
  if (value) return value;
  if (!process.stdin.isTTY) return required(value, name);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return required((await prompt.question(`${label}: `)).trim(), name);
  } finally {
    prompt.close();
  }
}

function statePath(root: string): string {
  return join(root, ".castloop", "state.json");
}

function loadState(root: string): LocalState {
  if (!existsSync(statePath(root))) return { shows: {}, init_steps: [] };
  const state: unknown = JSON.parse(readFileSync(statePath(root), "utf8"));
  if (!state || typeof state !== "object" || !("shows" in state) || !("init_steps" in state) ||
    !state.shows || typeof state.shows !== "object" || !Array.isArray(state.init_steps)) {
    throw new Error("Invalid .castloop/state.json");
  }
  return state as LocalState;
}

function saveState(root: string, state: LocalState): void {
  const file = statePath(root);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

function wrangler(root: string, ...command: string[]): void {
  const config = join(root, ".castloop", "wrangler.jsonc");
  try {
    execFileSync(WRANGLER, [...command, "--config", config], {
      cwd: root, env: process.env, stdio: "pipe", timeout: 120000,
    });
  } catch {
    throw new Error(`Wrangler ${command.slice(0, 3).join(" ")} failed; check account permissions and .castloop/state.json before retrying`);
  }
}

function createWranglerConfig(root: string, config: ServiceConfig): void {
  const contents = {
    name: config.worker_name,
    main: join(SOURCE_ROOT, "src/index.ts"),
    compatibility_date: "2026-09-23",
    observability: { enabled: true, traces: { enabled: true } },
    r2_buckets: [{ binding: "CASTLOOP_BUCKET", bucket_name: config.bucket_name }],
    queues: { consumers: [{ queue: config.queue_name, max_batch_size: 1,
      max_concurrency: 1, max_retries: 2, dead_letter_queue: config.dlq_name }] },
  };
  const file = join(root, ".castloop", "wrangler.jsonc");
  writeFileSync(file, JSON.stringify(contents, null, 2) + "\n", { mode: 0o600 });
}

async function provision(root: string, config: ServiceConfig, state: LocalState): Promise<void> {
  mkdirSync(join(root, ".castloop"), { recursive: true, mode: 0o700 });
  const keyFile = join(root, ".castloop", "secrets.json");
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, JSON.stringify({ CASTLOOP_ADMIN_KEY: randomBytes(32).toString("hex") }) + "\n",
      { flag: "wx", mode: 0o600 });
  }
  createWranglerConfig(root, config);
  const steps: Array<[string, () => void]> = [
    ["bucket", () => wrangler(root, "r2", "bucket", "create", config.bucket_name)],
    ["queue", () => wrangler(root, "queues", "create", config.queue_name)],
    ["dlq", () => wrangler(root, "queues", "create", config.dlq_name)],
    ["worker", () => wrangler(root, "deploy", "--secrets-file", keyFile)],
  ];
  for (const [step, run] of steps) {
    if (state.init_steps.includes(step)) continue;
    run();
    state.init_steps.push(step);
    saveState(root, state);
  }
  const key: unknown = JSON.parse(readFileSync(keyFile, "utf8"));
  if (!key || typeof key !== "object" || !("CASTLOOP_ADMIN_KEY" in key) ||
    typeof key.CASTLOOP_ADMIN_KEY !== "string") throw new Error("Local administrator key is missing");
  const health = await fetch(new URL("/admin/health", config.public_base_url), {
    headers: { "X-Castloop-Key": key.CASTLOOP_ADMIN_KEY, "User-Agent": "castloop-cli/0.1" },
    signal: AbortSignal.timeout(15000),
  });
  if (health.status !== 200) throw new Error(`Worker URL or administrator key is incorrect (HTTP ${health.status})`);
  if (!state.init_steps.includes("service")) {
    const file = join(root, "castloop.toml");
    wrangler(root, "r2", "object", "put", `${config.bucket_name}/system/service.toml`,
      "--remote", "--file", file, "--content-type", "application/toml");
    state.init_steps.push("service");
    saveState(root, state);
  }
  if (!state.init_steps.includes("notification")) {
    wrangler(root, "r2", "bucket", "notification", "create", config.bucket_name,
      "--event-type", "object-create", "--queue", config.queue_name,
      "--prefix", "staging/", "--suffix", "commit.json");
    state.init_steps.push("notification");
    saveState(root, state);
  }
}

async function init(target: string, flags: Record<string, string>): Promise<void> {
  allowedFlags(flags, ["service-id", "account-id", "bucket-name", "workers-subdomain"]);
  const root = resolve(target);
  mkdirSync(root, { recursive: true });
  const file = join(root, "castloop.toml");
  let config: ServiceConfig;
  if (existsSync(file)) {
    config = parseServiceConfig(readFileSync(file, "utf8"));
    if (Object.keys(flags).length > 0) throw new Error("Service already initialized; rerun init without flags to resume");
  } else {
    const serviceId = validateId(await ask(flags["service-id"], "service-id", "Service ID"), "service");
    const suffix = randomBytes(4).toString("hex");
    const accountId = await ask(flags["account-id"] ?? process.env.CLOUDFLARE_ACCOUNT_ID,
      "account-id", "Cloudflare account ID");
    const bucketName = await ask(flags["bucket-name"], "bucket-name", "Private R2 bucket name");
    const subdomain = await ask(flags["workers-subdomain"], "workers-subdomain", "workers.dev subdomain");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(subdomain)) throw new Error("Invalid workers.dev subdomain");
    const workerName = `castloop-${serviceId}-${suffix}`;
    config = serviceConfigSchema.parse({ schema_version: 1, service_id: serviceId,
      account_id: accountId, bucket_name: bucketName,
      worker_name: workerName, queue_name: `castloop-${serviceId}-${suffix}`,
      dlq_name: `castloop-${serviceId}-dlq-${suffix}`,
      public_base_url: `https://${workerName}.${subdomain}.workers.dev` });
    writeFileSync(file, stringifyToml(config), { flag: "wx" });
  }
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== config.account_id || !process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this service before provisioning");
  }
  const ignore = join(root, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "");
  const existing = readFileSync(ignore, "utf8");
  const additions = [".castloop/", "*.mp3"].filter((line) => !existing.split(/\r?\n/).includes(line));
  if (additions.length) appendFileSync(ignore, `${existing && !existing.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`);
  await provision(root, config, loadState(root));
  console.log(`Initialized ${config.service_id} in ${root}`);
}

function loadConfig(root: string): ServiceConfig {
  return parseServiceConfig(readFileSync(join(root, "castloop.toml"), "utf8"));
}

async function createShow(showArg: string, flags: Record<string, string>): Promise<void> {
  allowedFlags(flags, ["site-url"]);
  const root = process.cwd();
  const config = loadConfig(root);
  const showId = validateId(showArg, "show");
  const directory = join(root, showId);
  const file = join(directory, "show.toml");
  const state = loadState(root);
  let reservation = state.shows[showId];
  if (existsSync(directory)) {
    if (!reservation || !existsSync(file)) throw new Error(`Show directory already exists: ${directory}`);
    const metadata = parseShowMetadata(readFileSync(file, "utf8"));
    if (metadata.show_id !== showId) throw new Error("Local Show ID does not match the directory");
    if (flags["site-url"] && flags["site-url"] !== metadata.site_url) {
      throw new Error("The existing show.toml has a different site_url");
    }
  } else {
    const siteUrl = await ask(flags["site-url"], "site-url", "Show website URL");
    const draft = showMetadataSchema.parse({ schema_version: 1, show_id: showId,
      title: showId, description: "Edit this description before publication",
      language: "ja", author: "Edit author", owner_name: "Edit owner",
      owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
      site_url: siteUrl, image_path: "cover.jpg" });
    reservation = { reservation_id: randomUUID(), confirmed: false };
    mkdirSync(directory);
    writeFileSync(file, stringifyToml(draft), { flag: "wx" });
    state.shows[showId] = reservation;
    saveState(root, state);
  }
  const keyFile = join(root, ".castloop", "secrets.json");
  const key: unknown = JSON.parse(readFileSync(keyFile, "utf8"));
  if (!key || typeof key !== "object" || !("CASTLOOP_ADMIN_KEY" in key) ||
    typeof key.CASTLOOP_ADMIN_KEY !== "string") throw new Error("Local administrator key is missing");
  const url = new URL("/admin/shows/reserve", config.public_base_url);
  const response = await fetch(url, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Castloop-Key": key.CASTLOOP_ADMIN_KEY,
    "User-Agent": "castloop-cli/0.1",
  }, body: JSON.stringify({ show_id: showId, reservation_id: reservation.reservation_id }) });
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`Show ID reservation failed (HTTP ${response.status}); local draft retained for retry`);
  }
  reservation.confirmed = true;
  saveState(root, state);
  console.log(`Show ${showId} reserved; edit ${file} before publication`);
}

function createEpisode(episodeArg: string): void {
  const root = resolve(process.cwd(), "..");
  loadConfig(root);
  const showId = validateId(basename(process.cwd()), "show");
  const show = parseShowMetadata(readFileSync(join(process.cwd(), "show.toml"), "utf8"));
  if (show.show_id !== showId) throw new Error("Show directory and show.toml disagree");
  if (!loadState(root).shows[showId]?.confirmed) throw new Error("Reserve the Show ID before creating an Episode");
  const episodeId = validateId(episodeArg, "episode");
  const file = join(process.cwd(), `episode-${episodeId}.toml`);
  const draft = parseEpisodeDraft(stringifyToml({ schema_version: 1, episode_id: episodeId,
    guid: randomUUID(), title: episodeId, description: "Edit this description before publication",
    published_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  }));
  writeFileSync(file, stringifyToml(draft), { flag: "wx" });
  console.log(`Created ${file}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = argsOf(rest);
  if (command === "init" && positional.length <= 1) return init(positional[0] ?? ".", flags);
  if (command === "create-show" && positional.length === 1) return createShow(positional[0], flags);
  if (command === "create-episode" && positional.length === 1) {
    allowedFlags(flags, []);
    return createEpisode(positional[0]);
  }
  throw new Error("Usage: castloop init [dir] --service-id ID --bucket-name NAME --workers-subdomain NAME | create-show ID --site-url URL | create-episode ID");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
