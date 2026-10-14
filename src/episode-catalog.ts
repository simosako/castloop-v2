import { z } from "zod";
import { episodeRevisionSchema, parseEpisodeRevision, parseShowControl, validateId } from "../packages/shared/src/index";
import type { EpisodeRevision, ShowControl } from "../packages/shared/src/index";
import { readEpisodeLifecycle, requireShowExecution } from "./lifecycle-control";
import type { ShowExecution } from "./lifecycle-control";
import type { LifecycleFeedEnv } from "./lifecycle-feed";
import { canonicalEnclosureUrl } from "./media-url";
import { parsePublicAssetPath } from "./public-assets";

const MAXIMUM_BYTES = 8_000_000;
const MAXIMUM_OBJECTS = 10000;
const catalogSchema = z.object({
  schema_version: z.literal(1), show_id: z.string(),
  feed_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  applied_job_id: z.uuid().nullable(), request_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  entries: z.array(z.object({ active: z.boolean(), revision: episodeRevisionSchema }).strict()).max(MAXIMUM_OBJECTS),
}).strict();
export type EpisodeCatalog = z.infer<typeof catalogSchema>;
export type EpisodeCatalogSnapshot = { value: EpisodeCatalog; etag: string };

export function episodeCatalogKey(showId: string): string {
  return `public/podcasts/${validateId(showId, "show")}/episode-catalog.json`;
}

function validateCatalog(input: unknown, showId: string): EpisodeCatalog {
  const value = catalogSchema.parse(input);
  if (value.show_id !== showId) throw new Error("Episode catalog targets another Show");
  const ids = new Set<string>();
  const guids = new Set<string>();
  for (const { revision } of value.entries) {
    if (ids.has(revision.episode_id) || guids.has(revision.guid)) throw new Error("Episode catalog contains duplicate identities");
    ids.add(revision.episode_id);
    guids.add(revision.guid);
    canonicalEnclosureUrl(revision, showId, "https://catalog-validation.invalid");
  }
  return value;
}

export async function readEpisodeCatalog(env: LifecycleFeedEnv, control: ShowControl,
  execution?: ShowExecution): Promise<EpisodeCatalogSnapshot | null> {
  const object = await env.CASTLOOP_BUCKET.get(episodeCatalogKey(control.show_id));
  if (!object) {
    if (control.episode_catalog_initialized) throw new Error("Initialized Episode catalog is missing");
    return null;
  }
  if (object.size < 1 || object.size > MAXIMUM_BYTES) throw new Error("Episode catalog is oversized");
  const value = validateCatalog(await object.json<unknown>(), control.show_id);
  const settled = value.feed_generation === control.feed_generation && value.applied_job_id === (control.last_feed_job_id ?? null);
  const ownPending = execution && control.owner?.state === "processing" && control.owner.job_id === execution.jobId &&
    control.owner.execution_id === execution.executionId && control.generation === execution.generation &&
    value.feed_generation === control.feed_generation + 1 && value.applied_job_id === execution.jobId &&
    value.request_sha256 === control.owner.request_sha256;
  if (!settled && !ownPending) throw new Error("Episode catalog generation does not match its Show owner");
  return { value, etag: object.etag };
}

export async function verifyCatalogAudio(env: LifecycleFeedEnv, showId: string, revision: EpisodeRevision): Promise<void> {
  const asset = parsePublicAssetPath(new URL(canonicalEnclosureUrl(revision, showId, "https://catalog-validation.invalid")).pathname);
  if (asset?.kind !== "audio" || asset.showId !== showId || asset.episodeId !== revision.episode_id) {
    throw new Error("Episode has an invalid immutable audio reference");
  }
  const audio = await env.CASTLOOP_BUCKET.head(asset.key);
  if (!audio || audio.size !== revision.length_bytes) throw new Error("Episode audio is missing or its size changed");
}

async function inventory(env: LifecycleFeedEnv, prefix: string): Promise<R2Object[]> {
  const result: R2Object[] = [];
  const keys = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.CASTLOOP_BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) {
      if (!object.key.startsWith(prefix) || keys.has(object.key) || result.length >= MAXIMUM_OBJECTS) {
        throw new Error("Episode catalog inventory is inconsistent or oversized");
      }
      keys.add(object.key);
      result.push(object);
    }
    if (!page.truncated) return result;
    if (!page.cursor || cursors.has(page.cursor)) throw new Error("Episode catalog inventory cursor did not advance");
    cursors.add(page.cursor);
    cursor = page.cursor;
  } while (true);
}

export async function ensureEpisodeCatalog(env: LifecycleFeedEnv, execution: ShowExecution): Promise<EpisodeCatalogSnapshot> {
  const control = await requireShowExecution(env, execution);
  const existing = await readEpisodeCatalog(env, control.value, execution);
  if (existing) {
    if (!control.value.episode_catalog_initialized) await markCatalogInitialized(env, execution);
    return existing;
  }
  const metadataPrefix = `public/episodes/${execution.showId}/`;
  const lifecyclePrefix = `system/episode-lifecycle/${execution.showId}/`;
  const metadata = new Map<string, R2Object>();
  const ids = new Set<string>();
  for (const object of await inventory(env, metadataPrefix)) {
    const parts = object.key.slice(metadataPrefix.length).split("/");
    if (parts.at(-1) !== "metadata.toml") continue;
    if (parts.length !== 2) throw new Error("Invalid current Episode metadata key");
    const id = validateId(parts[0], "episode");
    metadata.set(id, object);
    ids.add(id);
  }
  for (const object of await inventory(env, lifecyclePrefix)) {
    const name = object.key.slice(lifecyclePrefix.length);
    if (!name.endsWith(".toml") || name.includes("/")) throw new Error("Invalid Episode lifecycle inventory key");
    ids.add(validateId(name.slice(0, -5), "episode"));
  }
  if (ids.size > MAXIMUM_OBJECTS) throw new Error("Episode catalog exceeds the Episode limit");
  const entries: EpisodeCatalog["entries"] = [];
  let bytes = 0;
  for (const id of ids) {
    const lifecycle = await readEpisodeLifecycle(env, execution.showId, id);
    if (!lifecycle) throw new Error("Known Episode has no lifecycle record");
    if (["deleted", "deleting"].includes(lifecycle.lifecycle)) continue;
    const listed = metadata.get(id);
    if (!listed) {
      if (lifecycle.lifecycle !== "draft") throw new Error("Published Episode has no current metadata");
      continue;
    }
    bytes += listed.size;
    if (!Number.isSafeInteger(listed.size) || listed.size < 1 || listed.size > 1_000_000 || bytes > MAXIMUM_BYTES) {
      throw new Error("Episode catalog exceeds its metadata budget");
    }
    const object = await env.CASTLOOP_BUCKET.get(listed.key);
    if (!object || object.etag !== listed.etag || object.size !== listed.size) {
      throw new Error("Episode catalog inventory changed during validation");
    }
    const revision = parseEpisodeRevision(await object.text());
    if (revision.episode_id !== id) throw new Error("Episode catalog metadata targets another Episode");
    if (lifecycle.lifecycle === "active") await verifyCatalogAudio(env, execution.showId, revision);
    entries.push({ active: lifecycle.lifecycle === "active", revision });
  }
  const value = validateCatalog({ schema_version: 1, show_id: execution.showId, feed_generation: control.value.feed_generation,
    applied_job_id: control.value.last_feed_job_id ?? null, request_sha256: null, entries }, execution.showId);
  const source = JSON.stringify(value);
  if (new TextEncoder().encode(source).length > MAXIMUM_BYTES) throw new Error("Episode catalog is oversized");
  const current = await requireShowExecution(env, execution);
  if (current.etag !== control.etag) throw new Error("Show changed during Episode catalog initialization");
  const written = await env.CASTLOOP_BUCKET.put(episodeCatalogKey(execution.showId), source, { onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (!written) throw new Error("Episode catalog initialization conflicted");
  await markCatalogInitialized(env, execution);
  return { value, etag: written.etag };
}

async function markCatalogInitialized(env: LifecycleFeedEnv, execution: ShowExecution): Promise<void> {
  const control = await requireShowExecution(env, execution);
  if (control.value.episode_catalog_initialized) return;
  const value = parseShowControl({ ...control.value, episode_catalog_initialized: true });
  if (!await env.CASTLOOP_BUCKET.put(`system/show-publications/${execution.showId}.json`, JSON.stringify(value),
    { onlyIf: { etagMatches: control.etag } })) throw new Error("Show changed before catalog initialization was recorded");
}

export async function advanceEpisodeCatalog(env: LifecycleFeedEnv, execution: ShowExecution): Promise<void> {
  const catalog = await ensureEpisodeCatalog(env, execution);
  const control = await requireShowExecution(env, execution);
  const owner = control.value.owner!;
  if (control.value.last_feed_job_id === execution.jobId) return;
  if (catalog.value.feed_generation === control.value.feed_generation + 1 && catalog.value.applied_job_id === execution.jobId) return;
  let entries = catalog.value.entries;
  if (owner.kind === "episode") {
    const id = owner.episode_id!;
    if (owner.action === "delete") entries = entries.filter((entry) => entry.revision.episode_id !== id);
    else if (owner.action === "unpublish") entries = entries.map((entry) => entry.revision.episode_id === id ? { ...entry, active: false } : entry);
    else {
      const object = await env.CASTLOOP_BUCKET.get(`public/episodes/${execution.showId}/${id}/metadata.toml`);
      if (!object || object.size < 1 || object.size > 1_000_000) throw new Error("Catalog update has no bounded current metadata");
      const revision = parseEpisodeRevision(await object.text());
      if (revision.episode_id !== id || owner.action === "publish" && revision.revision_id !== execution.jobId) {
        throw new Error("Catalog update does not match its publication");
      }
      entries = [...entries.filter((entry) => entry.revision.episode_id !== id), { active: true, revision }];
    }
  }
  const value = validateCatalog({ ...catalog.value, entries, feed_generation: control.value.feed_generation + 1,
    applied_job_id: execution.jobId, request_sha256: owner.request_sha256 }, execution.showId);
  const source = JSON.stringify(value);
  if (new TextEncoder().encode(source).length > MAXIMUM_BYTES) throw new Error("Episode catalog is oversized");
  const latest = await requireShowExecution(env, execution);
  if (latest.etag !== control.etag) throw new Error("Show changed before Episode catalog update");
  if (!await env.CASTLOOP_BUCKET.put(episodeCatalogKey(execution.showId), source, { onlyIf: { etagMatches: catalog.etag } })) {
    throw new Error("Episode catalog update conflicted");
  }
}
