#!/usr/bin/env bun

import {
  episodeCommitSchema, episodeDraftFromRevision, episodeRevisionSchema, jobStatusSchema,
  parseEpisodeDraft, parseServiceConfig, parseShowMetadata,
  serviceConfigSchema, showCommitSchema, showMetadataSchema, stringifyToml, validateId,
} from "@castloop/shared";
import type { EpisodeCommit, EpisodeRevision, ServiceConfig, ShowCommit } from "@castloop/shared";
import { analyzeAudio } from "./audio";
import { CloudflareApi, hashFile } from "./cloudflare-api";
import { waitForWorkerHealth } from "./health";
import { embeddedWorkerSource, WORKER_COMPATIBILITY_DATE } from "./worker-payload";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync,
  statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

type ShowDraft = {
  job_id: string;
  metadata_sha256: string;
  cover_sha256: string;
  cover_extension: "jpg" | "png";
  staged: boolean;
  committed: boolean;
};
type EpisodeStage = {
  job_id: string;
  base_revision_id?: string;
  metadata_sha256?: string;
  audio_sha256?: string;
  audio_length_bytes?: number;
  duration_seconds?: number;
  audio_path?: string;
  committed_at?: string;
  committed: boolean;
};
type LocalState = {
  shows: Record<string, { reservation_id: string; confirmed: boolean }>;
  init_steps: string[];
  drafts: Record<string, ShowDraft>;
  episodes: Record<string, EpisodeStage>;
};
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI_VERSION = "0.1.0";
const USAGE = "Usage: castloop init [dir] --service-id ID --bucket-name NAME --workers-subdomain NAME | " +
  "create-show ID --site-url URL | create-episode ID | update-show ID | publish-show ID | " +
  "update-episode ID | update-episode-audio ID MP3 | publish-episode ID | " +
  "job-status JOB --show ID [--episode ID] | retry-job JOB --show ID [--episode ID] | " +
  "cleanup-job JOB --show ID --episode ID | deploy";

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
  if (!existsSync(statePath(root))) return { shows: {}, init_steps: [], drafts: {}, episodes: {} };
  const state: unknown = JSON.parse(readFileSync(statePath(root), "utf8"));
  if (!state || typeof state !== "object" || !("shows" in state) || !("init_steps" in state) ||
    !state.shows || typeof state.shows !== "object" || !Array.isArray(state.init_steps)) {
    throw new Error("Invalid .castloop/state.json");
  }
  return { ...(state as LocalState), drafts: ("drafts" in state && state.drafts &&
    typeof state.drafts === "object" ? state.drafts : {}) as Record<string, ShowDraft>,
  episodes: ("episodes" in state && state.episodes && typeof state.episodes === "object"
    ? state.episodes : {}) as Record<string, EpisodeStage> };
}

function saveState(root: string, state: LocalState): void {
  const file = statePath(root);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

async function workerSource(): Promise<string> {
  if (Bun.isStandaloneExecutable) {
    if (!embeddedWorkerSource) throw new Error("The executable does not contain a Worker bundle");
    return embeddedWorkerSource;
  }
  const result = await Bun.build({ entrypoints: [join(SOURCE_ROOT, "src/index.ts")],
    target: "browser", minify: true });
  if (!result.success || result.outputs.length !== 1) throw new Error("Worker bundle build failed");
  return result.outputs[0].text();
}

async function provision(root: string, config: ServiceConfig, state: LocalState): Promise<void> {
  mkdirSync(join(root, ".castloop"), { recursive: true, mode: 0o700 });
  const keyFile = join(root, ".castloop", "secrets.json");
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, JSON.stringify({ CASTLOOP_ADMIN_KEY: randomBytes(32).toString("hex") }) + "\n",
      { flag: "wx", mode: 0o600 });
  }
  const api = new CloudflareApi(config);
  const steps: Array<[string, () => Promise<void>]> = [
    ["bucket", () => api.createBucket(config.bucket_name)],
    ["queue", () => api.createQueue(config.queue_name)],
    ["dlq", () => api.createQueue(config.dlq_name)],
    ["worker", async () => api.deployWorker(config, await workerSource(), adminKey(root), WORKER_COMPATIBILITY_DATE)],
    ["consumer", async () => api.ensureConsumer(await api.queueId(config.queue_name), config, false)],
    ["dlq-consumer", async () => api.ensureConsumer(await api.queueId(config.dlq_name), config, true)],
  ];
  for (const [step, run] of steps) {
    if (state.init_steps.includes(step)) continue;
    await run();
    state.init_steps.push(step);
    saveState(root, state);
  }
  const key: unknown = JSON.parse(readFileSync(keyFile, "utf8"));
  if (!key || typeof key !== "object" || !("CASTLOOP_ADMIN_KEY" in key) ||
    typeof key.CASTLOOP_ADMIN_KEY !== "string") throw new Error("Local administrator key is missing");
  await waitForWorkerHealth(config.public_base_url, key.CASTLOOP_ADMIN_KEY);
  if (!state.init_steps.includes("service")) {
    const file = join(root, "castloop.toml");
    await api.putObject(config.bucket_name, "system/service.toml", file, "application/toml",
      await hashFile(file));
    state.init_steps.push("service");
    saveState(root, state);
  }
  if (!state.init_steps.includes("notification")) {
    await api.createNotification(config, await api.queueId(config.queue_name));
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

function adminKey(root: string): string {
  const key: unknown = JSON.parse(readFileSync(join(root, ".castloop", "secrets.json"), "utf8"));
  if (!key || typeof key !== "object" || !("CASTLOOP_ADMIN_KEY" in key) ||
    typeof key.CASTLOOP_ADMIN_KEY !== "string") throw new Error("Local administrator key is missing");
  return key.CASTLOOP_ADMIN_KEY;
}

async function adminCall(root: string, path: string, body?: object): Promise<{ response: Response; data: unknown }> {
  const config = loadConfig(root);
  const response = await fetch(new URL(path, config.public_base_url), {
    method: body ? "POST" : "GET",
    headers: { "X-Castloop-Key": adminKey(root), "User-Agent": "castloop-cli/0.1",
      ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  return { response, data: await response.json() as unknown };
}

function digest(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function showInputs(root: string, showId: string): {
  metadata: string; image: string; cover: Buffer; extension: "jpg" | "png";
} {
  const directory = join(root, showId);
  const metadata = readFileSync(join(directory, "show.toml"), "utf8");
  const show = parseShowMetadata(metadata);
  if (show.show_id !== showId) throw new Error("Show ID in show.toml does not match the directory");
  const image = join(directory, show.image_path);
  const size = statSync(image).size;
  if (size > 5_000_000 || size === 0) {
    throw new Error("Cover image must be at most 5 MB and nonempty");
  }
  const cover = readFileSync(image);
  const extension = show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
  const valid = extension === "jpg" ? cover.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    : cover.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!valid) throw new Error("Cover image format does not match image_path");
  return { metadata, image, cover, extension };
}

function requireShow(root: string, showId: string): void {
  if (!loadState(root).shows[showId]?.confirmed) throw new Error("Reserve the Show ID first");
}

async function updateShow(showArg: string): Promise<void> {
  const root = process.cwd();
  const config = loadConfig(root);
  const showId = validateId(showArg, "show");
  requireShow(root, showId);
  const input = showInputs(root, showId);
  const state = loadState(root);
  let draft = state.drafts[showId];
  if (draft && !draft.committed) {
    const remote = await inspectJob(root, showId, draft.job_id);
    if (remote.marker) {
      draft.committed = true;
      saveState(root, state);
    } else if (remote.owner?.job_id === draft.job_id && remote.owner.state !== "free") {
      throw new Error(`Job ${draft.job_id} already claimed; finish publish-show before editing this draft`);
    }
  }
  if (!draft || draft.committed) {
    draft = { job_id: randomUUID(), metadata_sha256: "", cover_sha256: "",
      cover_extension: input.extension, staged: false, committed: false };
    state.drafts[showId] = draft;
    saveState(root, state);
  }
  const prefix = `staging/shows/${showId}/${draft.job_id}`;
  const api = new CloudflareApi(config);
  await api.putObject(config.bucket_name, `${prefix}/show.toml`, join(root, showId, "show.toml"),
    "application/toml", digest(input.metadata));
  await api.putObject(config.bucket_name, `${prefix}/cover.${input.extension}`, input.image,
    input.extension === "jpg" ? "image/jpeg" : "image/png", digest(input.cover));
  draft.metadata_sha256 = digest(input.metadata);
  draft.cover_sha256 = digest(input.cover);
  draft.cover_extension = input.extension;
  draft.staged = true;
  saveState(root, state);
  console.log(`Show draft staged: ${draft.job_id}`);
}

function showCommit(showId: string, draft: ShowDraft): ShowCommit {
  return showCommitSchema.parse({ schema_version: 1, kind: "show", show_id: showId,
    job_id: draft.job_id, metadata_sha256: draft.metadata_sha256,
    cover_sha256: draft.cover_sha256, cover_extension: draft.cover_extension });
}

async function inspectJob(root: string, showId: string, jobId: string, episodeId?: string): Promise<{
  owner: { job_id: string; state: string } | null;
  marker: unknown;
  status: { state: string; reason?: string } | null;
  dlq: boolean;
}> {
  const query = new URLSearchParams({ show: showId, ...(episodeId ? { episode: episodeId } : {}) });
  const { response, data } = await adminCall(root, `/admin/jobs/${jobId}?${query}`);
  if (response.status !== 200 || !data || typeof data !== "object") throw new Error("Cannot read publication job");
  const record = data as Record<string, unknown>;
  const marker = record.marker ?? null;
  const status = record.status ? jobStatusSchema.parse(record.status) : null;
  const owner = record.owner as { job_id: string; state: string } | null;
  return { owner, marker, status, dlq: record.dlq === true };
}

async function publishShow(showArg: string): Promise<void> {
  const root = process.cwd();
  const config = loadConfig(root);
  const showId = validateId(showArg, "show");
  requireShow(root, showId);
  const state = loadState(root);
  const draft = state.drafts[showId];
  if (!draft?.staged) throw new Error("Run update-show before publish-show");
  const input = showInputs(root, showId);
  if (digest(input.metadata) !== draft.metadata_sha256 || digest(input.cover) !== draft.cover_sha256 ||
    input.extension !== draft.cover_extension) {
    throw new Error("Local Show metadata or cover changed after staging; run update-show again");
  }
  const commit = showCommit(showId, draft);
  const previous = await inspectJob(root, showId, draft.job_id);
  if (previous.marker) {
    if (JSON.stringify(showCommitSchema.parse(previous.marker)) !== JSON.stringify(commit)) {
      throw new Error("Remote commit differs from local draft");
    }
    draft.committed = true;
    saveState(root, state);
    console.log(`Show publication already submitted: ${draft.job_id} (${previous.status?.state ?? "queued"})`);
    return;
  }
  if (draft.committed) throw new Error("Committed Show marker is missing; inspect job before retrying");
  const { response, data } = await adminCall(root, "/admin/publications/claim",
    { show_id: showId, job_id: draft.job_id });
  if (response.status !== 200 && response.status !== 201) {
    const owner = data && typeof data === "object" && "job_id" in data ? String(data.job_id) : "unknown";
    throw new Error(`Show publication not admitted (HTTP ${response.status}, current job: ${owner})`);
  }
  const file = join(root, ".castloop", `commit-${draft.job_id}.json`);
  writeFileSync(file, JSON.stringify(commit) + "\n", { mode: 0o600 });
  await new CloudflareApi(config).putObject(config.bucket_name,
    `staging/shows/${showId}/${draft.job_id}/commit.json`, file, "application/json",
    await hashFile(file));
  draft.committed = true;
  saveState(root, state);
  console.log(`Show publication queued: ${draft.job_id}`);
}

async function jobStatus(jobId: string, flags: Record<string, string>): Promise<void> {
  allowedFlags(flags, ["show", "episode"]);
  const showId = validateId(required(flags.show, "show"), "show");
  const episodeId = flags.episode ? validateId(flags.episode, "episode") : undefined;
  const record = await inspectJob(process.cwd(), showId, jobId, episodeId);
  console.log(JSON.stringify(record, null, 2));
}

async function retryJob(jobId: string, flags: Record<string, string>): Promise<void> {
  allowedFlags(flags, ["show", "episode"]);
  const showId = validateId(required(flags.show, "show"), "show");
  const episodeId = flags.episode ? validateId(flags.episode, "episode") : undefined;
  const { response } = await adminCall(process.cwd(), "/admin/jobs/retry", {
    show_id: showId, job_id: jobId, kind: episodeId ? "episode" : "show",
    ...(episodeId ? { episode_id: episodeId } : {}),
  });
  if (response.status !== 202) throw new Error(`Job cannot be requeued (HTTP ${response.status})`);
  console.log(`Job requeued: ${jobId}`);
}

async function cleanupJob(jobId: string, flags: Record<string, string>): Promise<void> {
  allowedFlags(flags, ["show", "episode"]);
  const showId = validateId(required(flags.show, "show"), "show");
  const episodeId = validateId(required(flags.episode, "episode"), "episode");
  const { response, data } = await adminCall(process.cwd(), "/admin/jobs/cleanup", {
    show_id: showId, episode_id: episodeId, job_id: jobId,
  });
  if (response.status !== 200) throw new Error(`Staging cleanup refused (HTTP ${response.status})`);
  console.log(JSON.stringify(data));
}

async function deployService(): Promise<void> {
  const root = process.cwd();
  const config = loadConfig(root);
  const api = new CloudflareApi(config);
  await api.deployWorker(config, await workerSource(), adminKey(root), WORKER_COMPATIBILITY_DATE);
  await api.ensureConsumer(await api.queueId(config.queue_name), config, false);
  await api.ensureConsumer(await api.queueId(config.dlq_name), config, true);
  console.log("Worker deployed");
}

function episodeContext(episodeArg: string): { root: string; showId: string; episodeId: string;
  config: ServiceConfig; file: string; key: string } {
  const directory = process.cwd();
  const root = resolve(directory, "..");
  const config = loadConfig(root);
  const showId = validateId(basename(directory), "show");
  requireShow(root, showId);
  const episodeId = validateId(episodeArg, "episode");
  const file = join(directory, `episode-${episodeId}.toml`);
  const show = parseShowMetadata(readFileSync(join(directory, "show.toml"), "utf8"));
  if (show.show_id !== showId) throw new Error("Show directory does not match show.toml");
  return { root, showId, episodeId, config, file, key: `${showId}/${episodeId}` };
}

async function editableEpisodeStage(root: string, showId: string, episodeId: string,
  key: string): Promise<{ state: LocalState; stage: EpisodeStage }> {
  const state = loadState(root);
  let stage = state.episodes[key];
  const current = await currentEpisode(root, showId, episodeId);
  if (stage && !stage.committed) {
    const remote = await inspectJob(root, showId, stage.job_id, episodeId);
    if (remote.marker) {
      stage.committed = true;
      saveState(root, state);
    } else if (remote.owner?.job_id === stage.job_id && remote.owner.state !== "free") {
      throw new Error(`Job ${stage.job_id} is claimed; finish publish-episode before changing this draft`);
    }
  }
  if (!stage || stage.committed) {
    stage = { job_id: randomUUID(), committed: false,
      ...(current ? { base_revision_id: current.revision_id } : {}) };
    state.episodes[key] = stage;
    saveState(root, state);
  } else if (stage.base_revision_id !== current?.revision_id) {
    throw new Error("Episode changed since this draft was created; inspect the current revision before editing");
  }
  return { state, stage };
}

async function currentEpisode(root: string, showId: string, episodeId: string): Promise<EpisodeRevision | null> {
  const { response, data } = await adminCall(root, `/admin/episodes/${showId}/${episodeId}/current`);
  if (response.status !== 200 || !data || typeof data !== "object" || !("revision" in data)) {
    throw new Error("Cannot read current Episode revision");
  }
  return data.revision === null ? null : episodeRevisionSchema.parse(data.revision);
}

async function updateEpisode(episodeArg: string): Promise<void> {
  const context = episodeContext(episodeArg);
  const source = readFileSync(context.file, "utf8");
  const draft = parseEpisodeDraft(source);
  if (draft.episode_id !== context.episodeId) throw new Error("Episode ID does not match filename");
  const { state, stage } = await editableEpisodeStage(context.root, context.showId, context.episodeId, context.key);
  const current = await currentEpisode(context.root, context.showId, context.episodeId);
  if (current && (draft.guid !== current.guid || draft.published_at !== current.published_at)) {
    throw new Error("Episode GUID and published_at must remain unchanged");
  }
  await new CloudflareApi(context.config).putObject(context.config.bucket_name,
    `staging/episodes/${context.showId}/${context.episodeId}/${stage.job_id}/episode.toml`,
    context.file, "application/toml", digest(source));
  stage.metadata_sha256 = digest(source);
  saveState(context.root, state);
  console.log(`Episode metadata staged: ${stage.job_id}`);
}

async function updateEpisodeAudio(episodeArg: string, audioArg: string): Promise<void> {
  const context = episodeContext(episodeArg);
  const audio = resolve(process.cwd(), audioArg);
  const { length, duration } = await analyzeAudio(audio);
  const checksum = await hashFile(audio);
  const { state, stage } = await editableEpisodeStage(context.root, context.showId, context.episodeId, context.key);
  await new CloudflareApi(context.config).putObject(context.config.bucket_name,
    `staging/episodes/${context.showId}/${context.episodeId}/${stage.job_id}/audio.mp3`,
    audio, "audio/mpeg", checksum);
  stage.audio_path = audio;
  stage.audio_sha256 = checksum;
  stage.audio_length_bytes = length;
  stage.duration_seconds = duration;
  saveState(context.root, state);
  console.log(`Episode audio staged: ${stage.job_id}`);
}

async function publishEpisode(episodeArg: string): Promise<void> {
  const { root, showId, episodeId, config, file, key } = episodeContext(episodeArg);
  const state = loadState(root);
  const stage = state.episodes[key];
  if (!stage || (!stage.metadata_sha256 && !stage.audio_sha256) ||
    (!stage.base_revision_id && (!stage.metadata_sha256 || !stage.audio_sha256))) {
    throw new Error("Stage Episode changes (both metadata and audio for an initial publication)");
  }
  const current = await currentEpisode(root, showId, episodeId);
  if (current?.revision_id !== stage.base_revision_id && current?.revision_id !== stage.job_id) {
    throw new Error("Episode revision changed since staging; publish is stale");
  }
  if (stage.metadata_sha256) {
    const metadata = readFileSync(file, "utf8");
    const draft = parseEpisodeDraft(metadata);
    if (draft.episode_id !== episodeId || digest(metadata) !== stage.metadata_sha256) {
      throw new Error("Local Episode metadata changed after staging; run update-episode again");
    }
    if (current && (draft.guid !== current.guid || draft.published_at !== current.published_at)) {
      throw new Error("Episode GUID and published_at must match the published revision");
    }
  } else if (current && existsSync(file) &&
    JSON.stringify(parseEpisodeDraft(readFileSync(file, "utf8"))) !==
      JSON.stringify(episodeDraftFromRevision(current))) {
    throw new Error("Local Episode metadata differs from published metadata; stage it with update-episode");
  }
  if (stage.audio_sha256) {
    if (!stage.audio_path || !stage.audio_length_bytes || !stage.duration_seconds) {
      throw new Error("Staged Episode audio is incomplete");
    }
    const info = await analyzeAudio(stage.audio_path);
    if (info.length !== stage.audio_length_bytes || info.duration !== stage.duration_seconds ||
      await hashFile(stage.audio_path) !== stage.audio_sha256) {
      throw new Error("Local MP3 changed after staging; run update-episode-audio again");
    }
  }
  stage.committed_at ??= new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  saveState(root, state);
  const commit: EpisodeCommit = episodeCommitSchema.parse({ schema_version: 1, kind: "episode",
    show_id: showId, episode_id: episodeId, job_id: stage.job_id,
    ...(stage.base_revision_id ? { base_revision_id: stage.base_revision_id } : {}),
    ...(stage.metadata_sha256 ? { metadata_sha256: stage.metadata_sha256 } : {}),
    ...(stage.audio_sha256 ? { audio_sha256: stage.audio_sha256,
      audio_length_bytes: stage.audio_length_bytes, duration_seconds: stage.duration_seconds } : {}),
    committed_at: stage.committed_at });
  const previous = await inspectJob(root, showId, stage.job_id, episodeId);
  if (previous.marker) {
    if (JSON.stringify(episodeCommitSchema.parse(previous.marker)) !== JSON.stringify(commit)) {
      throw new Error("Remote Episode commit differs from local draft");
    }
    stage.committed = true;
    saveState(root, state);
    console.log(`Episode publication already submitted: ${stage.job_id} (${previous.status?.state ?? "queued"})`);
    return;
  }
  if (stage.committed) throw new Error("Committed Episode marker is missing; inspect job before retrying");
  const { response, data } = await adminCall(root, "/admin/publications/claim",
    { show_id: showId, job_id: stage.job_id });
  if (response.status !== 200 && response.status !== 201) {
    const owner = data && typeof data === "object" && "job_id" in data ? String(data.job_id) : "unknown";
    throw new Error(`Episode publication not admitted (HTTP ${response.status}, current job: ${owner})`);
  }
  const path = join(root, ".castloop", `commit-${stage.job_id}.json`);
  writeFileSync(path, JSON.stringify(commit) + "\n", { mode: 0o600 });
  await new CloudflareApi(config).putObject(config.bucket_name,
    `staging/episodes/${showId}/${episodeId}/${stage.job_id}/commit.json`, path, "application/json",
    await hashFile(path));
  stage.committed = true;
  saveState(root, state);
  console.log(`Episode publication queued: ${stage.job_id}`);
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
  if ((command === "help" || command === "--help") && rest.length === 0) {
    console.log(USAGE);
    return;
  }
  if ((command === "version" || command === "--version") && rest.length === 0) {
    console.log(CLI_VERSION);
    return;
  }
  const { positional, flags } = argsOf(rest);
  if (command === "init" && positional.length <= 1) return init(positional[0] ?? ".", flags);
  if (command === "create-show" && positional.length === 1) return createShow(positional[0], flags);
  if (command === "create-episode" && positional.length === 1) {
    allowedFlags(flags, []);
    return createEpisode(positional[0]);
  }
  if (command === "update-show" && positional.length === 1) {
    allowedFlags(flags, []);
    return updateShow(positional[0]);
  }
  if (command === "publish-show" && positional.length === 1) {
    allowedFlags(flags, []);
    return publishShow(positional[0]);
  }
  if (command === "job-status" && positional.length === 1) return jobStatus(positional[0], flags);
  if (command === "retry-job" && positional.length === 1) return retryJob(positional[0], flags);
  if (command === "cleanup-job" && positional.length === 1) return cleanupJob(positional[0], flags);
  if (command === "update-episode" && positional.length === 1) {
    allowedFlags(flags, []);
    return updateEpisode(positional[0]);
  }
  if (command === "update-episode-audio" && positional.length === 2) {
    allowedFlags(flags, []);
    return updateEpisodeAudio(positional[0], positional[1]);
  }
  if (command === "publish-episode" && positional.length === 1) {
    allowedFlags(flags, []);
    return publishEpisode(positional[0]);
  }
  if (command === "deploy" && positional.length === 0) {
    allowedFlags(flags, []);
    return deployService();
  }
  throw new Error(USAGE);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
