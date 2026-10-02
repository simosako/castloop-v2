import { episodeDraftSchema, parseShowMetadata, showMetadataSchema, stringifyToml, validateId } from "@castloop/shared";
import type { ServiceConfig } from "@castloop/shared";
import { readLocalMetadata } from "./local-metadata-read";
import { createShowRegistrationJournal, readLocalShowRegistration } from "./show-registration-journal";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function requireDirectory(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error("Local draft parent must be a real directory, not a symlink");
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeNewDraft(file: string, source: string, directory: string): void {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, source); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(directory);
}

async function withRegisteredShow<T>(root: string, config: ServiceConfig, showId: string, action: () => Promise<T>): Promise<T> {
  requireDirectory(root);
  const local = readLocalShowRegistration(root, config, showId);
  if (local.client_state?.phase !== "registered") {
    throw new Error("A durably saved Show registration receipt is required; preserve unknown outcomes without replay");
  }
  const journal = createShowRegistrationJournal(root, config, local.client_state.reserve);
  return journal.exclusively(async () => {
    if (journal.load().phase !== "registered") throw new Error("Local Show registration changed before draft creation");
    return action();
  });
}

export async function createM6LocalShowDraft(root: string, config: ServiceConfig, showArg: string, siteUrl: string): Promise<string> {
  const showId = validateId(showArg, "show");
  const draft = showMetadataSchema.parse({ schema_version: 1, show_id: showId,
    title: showId, description: "Edit this description before publication",
    language: "ja", author: "Edit author", owner_name: "Edit owner",
    owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
    site_url: siteUrl, image_path: "cover.jpg" });
  return withRegisteredShow(root, config, showId, async () => {
    const directory = join(root, showId);
    const file = join(directory, "show.toml");
    mkdirSync(directory, { mode: 0o700 });
    syncDirectory(root);
    writeNewDraft(file, stringifyToml(draft), directory);
    return file;
  });
}

export async function createM6LocalEpisodeDraft(root: string, config: ServiceConfig, showArg: string, episodeArg: string): Promise<string> {
  const showId = validateId(showArg, "show");
  const episodeId = validateId(episodeArg, "episode");
  return withRegisteredShow(root, config, showId, async () => {
    const directory = join(root, showId);
    requireDirectory(directory);
    const source = await readLocalMetadata(join(directory, "show.toml"));
    const show = parseShowMetadata(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source));
    if (show.show_id !== showId) throw new Error("Local Show ID does not match its registered directory");
    const draft = episodeDraftSchema.parse({ schema_version: 1, episode_id: episodeId,
      guid: randomUUID(), title: episodeId, description: "Edit this description before publication",
      published_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") });
    requireDirectory(directory);
    const file = join(directory, `episode-${episodeId}.toml`);
    writeNewDraft(file, stringifyToml(draft), directory);
    return file;
  });
}
