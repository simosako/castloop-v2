import { z } from "zod";
import { m6ServiceAdminResponseSchema, parseEpisodeDraft, parseShowMetadata, publicationAdminResponseSchema,
  serviceOperationIdentity, targetInspectionResponseSchema } from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";
import { localJournalEntryExists as present, syncLocalJournalDirectory } from "./local-journal-path";
import { createLocalJournalStorage, writeSyncedLocalFile } from "./local-journal-storage";
import { readLocalMetadata } from "./local-metadata-read";
import { M6_COMMAND_ARGUMENTS, runM6Command } from "./m6-commands";
import { LocalUpdateInspectionError } from "./m6-local-update";
import { readLocalDraft } from "./local-draft-journal";
import { RemoteOperationStatusError } from "./remote-operation-status";
import { receiveRssAsset } from "./rss-import-download";
import { parseRssImportFeed } from "./rss-import-feed";
import { hashRssImportFile } from "./rss-import-local";
import { prepareRssImportPublication } from "./rss-import-preflight";
import type { PreparedRssImport } from "./rss-import-preflight";
import { createHash, randomUUID } from "node:crypto";
import { constants, renameSync } from "node:fs";
import { copyFile, open } from "node:fs/promises";
import { join, resolve } from "node:path";

const MEASUREMENT_WAIT_MS = 300_000;

const stateSchema = z.object({ schema_version: z.literal(1), import_id: z.uuid(), identity: z.object({ service_id: z.string(),
  account_id: z.string(), worker_name: z.string(), public_base_url: z.string() }).strict(), public_base_url: z.string(),
  source_directory: z.string(), input_sha256: z.string(), step: z.number().int().nonnegative(),
  phase: z.enum(["ready", "command_requested", "waiting", "completed"]), waiting_job_id: z.uuid().optional(),
  created_show_sha256: z.string().optional(), reconciled_unstarted_update_step: z.number().int().nonnegative().optional() }).strict();
export type RssPublicationEffects = { command: (command: string, args: string[]) => Promise<unknown>;
  readFeed: (url: string) => Promise<string>; wait: () => Promise<void>;
  report: (summary: { show_id: string; episode_count: number; audio_bytes: number; public_base_url: string }) => void };

export function createRssPublicationEffects(root: string, config: ServiceConfig,
  workerSource: () => Promise<string>): RssPublicationEffects {
  if (process.env.CLOUDFLARE_ACCOUNT_ID !== config.account_id || !process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for this service before publishing an RSS import");
  }
  return { command: (command, args) => {
    if (!Object.hasOwn(M6_COMMAND_ARGUMENTS, command)) throw new Error("Invalid RSS publication command");
    return runM6Command(root, config, command, args, { workerSource });
  }, async readFeed(url) {
    const chunks: Buffer[] = [];
    await receiveRssAsset(url, 32_000_000, async (bytes) => { chunks.push(Buffer.from(bytes)); });
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks));
  }, wait: () => Bun.sleep(1000), report: (summary) => { console.error(JSON.stringify({ event: "rss_import_publication", ...summary })); } };
}

function metadataText(bytes: Buffer): string { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }

async function writeImportedMetadata(source: string, target: string, expected: object): Promise<void> {
  const bytes = await readLocalMetadata(source);
  const actual = target.endsWith("show.toml") ? parseShowMetadata(metadataText(bytes)) : parseEpisodeDraft(metadataText(bytes));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Import metadata changed after publication preparation");
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeSyncedLocalFile(temporary, () => bytes.toString("utf8"));
  renameSync(temporary, target);
  syncLocalJournalDirectory(resolve(target, ".."));
}

export async function publishRssImport(root: string, config: ServiceConfig, output: string,
  effects: RssPublicationEffects): Promise<unknown> {
  const prepared = await prepareRssImportPublication(output);
  const showId = prepared.show.show_id;
  const directory = join(root, showId);
  const storage = createLocalJournalStorage(root, "rss-imports", config.service_id, `${prepared.importId}.json`);
  const identity = serviceOperationIdentity(config);
  const initial = { schema_version: 1 as const, import_id: prepared.importId, identity, public_base_url: config.public_base_url,
    source_directory: prepared.root, input_sha256: prepared.inputSha256, step: 0, phase: "ready" as const };
  const service = m6ServiceAdminResponseSchema.parse(await effects.command("service-status", []));
  if (!service.external_episode_guids || service.admission.state !== "open") {
    throw new Error("RSS publication requires an open M7-compatible Worker; update and explicitly resume first");
  }
  if (!present(storage.path)) {
    if (present(directory)) throw new Error("RSS publication requires a new local Show");
    const target = targetInspectionResponseSchema.parse(await effects.command("target-show", [showId]));
    if (target.show) throw new Error("RSS publication cannot adopt an existing or deleted Show ID");
    storage.initialize(initial);
  }
  return storage.exclusively(async () => {
    let state = stateSchema.parse(storage.read());
    for (const field of ["import_id", "identity", "public_base_url", "source_directory", "input_sha256"] as const) {
      if (JSON.stringify(state[field]) !== JSON.stringify(initial[field])) throw new Error("RSS publication inputs or service changed; preserve the retained operation");
    }
    if (state.phase === "command_requested") {
      const index = (state.step - 5) / 4;
      const episode = Number.isInteger(index) && index >= 0 ? prepared.episodes[index] : undefined;
      if (!episode || state.waiting_job_id) {
        throw new Error("RSS publication command outcome is unknown; inspect the existing operation journals without replaying mutations");
      }
      const target = { kind: "episode" as const, show_id: showId, episode_id: episode.metadata.episode_id };
      const before = readLocalDraft(root, config, target);
      if (before.client_state || before.lock_present) {
        throw new Error("RSS publication command outcome is unknown; preserve the existing draft and operation journals without replaying mutations");
      }
      const local = parseEpisodeDraft(metadataText(await readLocalMetadata(join(directory, `episode-${target.episode_id}.toml`))));
      if (JSON.stringify(local) !== JSON.stringify(episode.metadata)) throw new Error("Imported Episode draft changed; unstarted update cannot be reconciled");
      const snapshot = targetInspectionResponseSchema.parse(await effects.command("target-episode", [showId, target.episode_id]));
      if (snapshot.request.service_id !== config.service_id || snapshot.request.kind !== "episode" ||
        snapshot.request.show_id !== showId || snapshot.request.episode_id !== target.episode_id ||
        snapshot.admission_state !== "open" || snapshot.show?.lifecycle !== "active" || snapshot.unfinished_show_operation ||
        snapshot.episode || snapshot.current_revision || JSON.stringify(readLocalDraft(root, config, target)) !== JSON.stringify(before)) {
        throw new Error("Unstarted update cannot be verified; preserve the retained command and ownership");
      }
      state = { ...state, phase: "ready", reconciled_unstarted_update_step: state.step };
      storage.replace(stateSchema.parse(state));
    }
    effects.report({ show_id: showId, episode_count: prepared.episodes.length, audio_bytes: prepared.audioBytes, public_base_url: config.public_base_url });
    const actions: Array<() => Promise<{ jobId?: string; createdShowHash?: string }>> = [];
    actions.push(async () => {
      await effects.command("create-show", [showId, prepared.show.site_url]);
      return { createdShowHash: createHash("sha256").update(await readLocalMetadata(join(directory, "show.toml"))).digest("hex") };
    });
    actions.push(async () => {
      const existing = createHash("sha256").update(await readLocalMetadata(join(directory, "show.toml"))).digest("hex");
      if (existing !== state.created_show_sha256) throw new Error("Created Show draft changed before import installation");
      const destination = join(directory, prepared.show.image_path);
      await copyFile(prepared.coverPath, destination, constants.COPYFILE_EXCL);
      const copied = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await copied.sync(); } finally { await copied.close(); }
      if ((await hashRssImportFile(destination, 5_000_000)).sha256 !== prepared.coverSha256) {
        throw new Error("Cover changed while copying");
      }
      await writeImportedMetadata(join(prepared.root, "show.toml"), join(directory, "show.toml"), prepared.show);
      return {};
    });
    const command = (name: string, args: string[], publication = false) => async () => {
      const result = await effects.command(name, args);
      return publication ? { jobId: z.object({ result: z.literal("publication-committed"), job_id: z.uuid() }).strict().parse(result).job_id } : {};
    };
    actions.push(command("update-show", [showId]), command("publish-show", [showId], true));
    for (const episode of prepared.episodes) {
      const id = episode.metadata.episode_id;
      actions.push(async () => {
        const audio = await hashRssImportFile(episode.audioPath, 300_000_000);
        if (audio.length !== episode.length || audio.sha256 !== episode.sha256) throw new Error("Import audio changed before publication");
        await effects.command("create-episode", [showId, id]);
        await writeImportedMetadata(join(prepared.root, `episode-${id}.toml`), join(directory, `episode-${id}.toml`), episode.metadata);
        return {};
      });
      actions.push(command("update-episode", [showId, id]), command("update-episode-audio", [showId, id, episode.audioPath]),
        command("publish-episode", [showId, id, episode.audioPath], true));
    }
    if (state.step > actions.length || state.phase === "completed" && state.step !== actions.length ||
      (state.phase === "waiting") !== (state.waiting_job_id !== undefined)) throw new Error("RSS publication progress is inconsistent");
    const save = () => storage.replace(stateSchema.parse(state));
    const waitForJob = async () => {
      const deadline = performance.now() + MEASUREMENT_WAIT_MS;
      for (let attempt = 0; attempt < 300 && performance.now() < deadline; attempt++) {
        let result: { server_status?: unknown };
        try {
          result = await effects.command("operation-status", ["publication", state.waiting_job_id!]) as { server_status?: unknown };
        } catch (error) {
          if (!(error instanceof RemoteOperationStatusError) || error.reasonCode !== "publication_status_changed") throw error;
          await effects.wait();
          continue;
        }
        const server = publicationAdminResponseSchema.parse(result.server_status);
        if (server.result !== "status") throw new Error("Publication returned an unexpected status receipt");
        if (server.status?.state === "published" && server.ownership === "released") {
          state = { ...state, phase: "ready", waiting_job_id: undefined }; save(); return;
        }
        if (server.status?.state === "failed" || server.ownership === "superseded") throw new Error("RSS publication failed or was superseded; inspect the retained job");
        if (server.execution_active && server.dead_letter_present) {
          throw new Error("Publication job is frozen with its retained execution token after dead-lettering; " +
            "inspect the retained job and run publication-release before resuming this import");
        }
        await effects.wait();
      }
      throw new Error("RSS publication is still pending; rerun this import only to inspect its acknowledged job");
    };
    if (state.phase === "waiting") await waitForJob();
    while (state.step < actions.length) {
      state = { ...state, phase: "command_requested" }; save();
      let result: { jobId?: string; createdShowHash?: string };
      try { result = await actions[state.step]!(); }
      catch (error) {
        if (error instanceof LocalUpdateInspectionError) { state = { ...state, phase: "ready" }; save(); }
        throw error;
      }
      state = { ...state, step: state.step + 1, phase: result.jobId ? "waiting" : "ready",
        ...(result.createdShowHash ? { created_show_sha256: result.createdShowHash } : {}),
        ...(result.jobId ? { waiting_job_id: result.jobId } : {}) };
      save();
      if (state.phase === "waiting") await waitForJob();
    }
    const feedUrl = `${config.public_base_url}/podcasts/${showId}/feed.xml`;
    await verifyImportedFeed(prepared, feedUrl, await effects.readFeed(feedUrl));
    state = { ...state, phase: "completed" }; save();
    return { result: "rss-import-published", import_id: prepared.importId, show_id: showId, episode_count: prepared.episodes.length,
      feed_url: feedUrl, subscriber_migration_completed: false };
  });
}

function verifyImportedFeed(prepared: PreparedRssImport, feedUrl: string, source: string): void {
  const published = parseRssImportFeed(source, prepared.show.show_id, feedUrl, 32_000_000);
  for (const field of ["title", "description", "language", "author", "owner_name", "owner_email", "site_url", "explicit", "show_type", "copyright"] as const) {
    if (published.show[field] !== prepared.show[field]) throw new Error("Published RSS Show metadata differs from the import");
  }
  if (published.episodes.length !== prepared.episodes.length) throw new Error("Published RSS Episode count differs from the import");
  if (JSON.stringify(published.show.categories) !== JSON.stringify(prepared.show.categories)) throw new Error("Published RSS categories differ from the import");
  const episodesByGuid = new Map(published.episodes.map((episode) => [episode.metadata.guid, episode]));
  for (const original of prepared.episodes) {
    const episode = episodesByGuid.get(original.metadata.guid);
    if (!episode || Date.parse(episode.metadata.published_at) !== Date.parse(original.metadata.published_at) ||
      episode.metadata.guid_is_permalink !== (original.metadata.guid_is_permalink ?? false)) throw new Error("Published RSS identity differs from the import");
    for (const field of ["title", "description", "explicit", "episode_type", "season_number", "episode_number"] as const) {
      if (episode.metadata[field] !== original.metadata[field]) throw new Error("Published RSS Episode metadata differs from the import");
    }
    const url = new URL(episode.audio_url);
    if (url.origin !== new URL(feedUrl).origin || !url.pathname.startsWith(`/podcasts/${prepared.show.show_id}/episodes/${original.metadata.episode_id}/`)) {
      throw new Error("Published RSS still references an external or unexpected audio URL");
    }
  }
}
