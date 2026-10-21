import { assertEpisodeDraftInputLimits, assertShowMetadataInputLimits, episodeDraftFromRevision, episodeRevisionSchema, parseEpisodeDraft, parsePublicAssetPath,
  parseShowMetadata, sameEpisodeIdentity, stringifyToml, toHex } from "../packages/shared/src/index";
import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import type { SqlitePublicationRequest, SqliteVerifiedUpload } from "../packages/shared/src/sqlite-publication";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SqlitePublicationInputError } from "./sqlite-publication-alarm";
import type { SqlitePublicationExecutor } from "./sqlite-publication-alarm";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { publicationChecksum, renderPublicationFeed } from "./publication-inputs";
import { sqliteFeedSnapshotKey } from "./sqlite-feed";

type ObjectHead = Pick<R2Object, "key" | "size" | "etag" | "version" | "customMetadata"> & { checksums: Pick<R2Checksums, "sha256"> };
type ObjectBody = ObjectHead & { body?: ReadableStream<Uint8Array> };
export type SqlitePublicationBucket = {
  head: (key: string) => Promise<ObjectHead | null>;
  get: (key: string, options?: R2GetOptions) => Promise<ObjectBody | null>;
  put: (key: string, body: string | Uint8Array | ReadableStream<Uint8Array>, options?: R2PutOptions) => Promise<ObjectHead | null>;
  list: (options: { prefix: string; limit: number }) => Promise<{ objects: Array<{ key: string }>; truncated: boolean }>;
};
type PreparedShow = { kind: "show"; request: SqlitePublicationRequest; metadata: ShowMetadata;
  cover: Uint8Array; extension: "jpg" | "png"; feed: string };
type PreparedEpisode = { kind: "episode"; request: SqlitePublicationRequest; revision: EpisodeRevision;
  audio?: SqliteVerifiedUpload; audioRevisionId: string; feed: string };
type PreparedLifecycle = { kind: "lifecycle"; request: SqlitePublicationRequest; feed?: string };
export type PreparedSqlitePublication = (PreparedShow | PreparedEpisode | PreparedLifecycle) & { feedGeneration: number };
export type SqlitePublicationEffectFailure = { event: "sqlite_publication_effect_failed"; job_id: string; request_id: string;
  phase: "show_metadata" | "cover" | "audio" | "revision" | "episode_metadata" | "feed" | "cache_purge";
  reason_code: "publication_effect_unverified" };
export type SqlitePublicationEffects = { purge: (target: { showId: string; cover: boolean; episodeId?: string }) => Promise<void>;
  now?: () => string; onFailure?: (event: SqlitePublicationEffectFailure) => void };

function input<T>(parse: () => T): T {
  try { return parse(); } catch { throw new SqlitePublicationInputError("validation_failed"); }
}

function matches(object: ObjectHead | null, payload: SqliteVerifiedUpload): boolean {
  return !!object && object.key === payload.key && object.size === payload.length_bytes && object.etag === payload.etag && object.version === payload.version;
}

async function readPayload(bucket: SqlitePublicationBucket, payload: SqliteVerifiedUpload): Promise<Uint8Array> {
  const object = await bucket.get(payload.key, { onlyIf: { etagMatches: payload.etag } });
  if (!matches(object, payload) || !object?.body) {
    await object?.body?.cancel();
    throw new SqlitePublicationInputError("validation_failed");
  }
  const reader = object.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > payload.length_bytes) throw new SqlitePublicationInputError("validation_failed");
      chunks.push(chunk.value);
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  if (length !== payload.length_bytes) throw new SqlitePublicationInputError("validation_failed");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (await publicationChecksum(bytes) !== payload.sha256) throw new SqlitePublicationInputError("validation_failed");
  return bytes;
}

function text(bytes: Uint8Array): string {
  return input(() => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}

async function requireAbsent(bucket: SqlitePublicationBucket, key: string): Promise<void> {
  if (await bucket.head(key)) throw new SqlitePublicationInputError("validation_failed");
}

async function requireEmpty(bucket: SqlitePublicationBucket, prefix: string): Promise<void> {
  const page = await bucket.list({ prefix, limit: 1 });
  if (page.objects.length || page.truncated) throw new SqlitePublicationInputError("validation_failed");
}

function audioKey(revision: EpisodeRevision, showId: string): { key: string; revisionId: string } {
  const asset = parsePublicAssetPath(new URL(revision.enclosure_url).pathname);
  if (!asset || asset.kind !== "audio" || asset.showId !== showId || asset.episodeId !== revision.episode_id) {
    throw new Error("Published Episode has an inconsistent immutable audio reference");
  }
  return { key: asset.key, revisionId: asset.revisionId };
}

async function put(bucket: SqlitePublicationBucket, key: string, value: string | Uint8Array, contentType: string,
  immutable = false): Promise<void> {
  const object = await bucket.put(key, value, { httpMetadata: { contentType },
    ...(immutable ? { onlyIf: new Headers({ "If-None-Match": "*" }) } : {}) });
  const length = typeof value === "string" ? new TextEncoder().encode(value).byteLength : value.byteLength;
  if (!object || object.key !== key || object.size !== length) throw new Error("Publication output was not verified");
}

async function persistFeed(store: SqlitePublicationContent, bucket: SqlitePublicationBucket,
  request: SqlitePublicationRequest, feed: string): Promise<void> {
  const key = sqliteFeedSnapshotKey(request.show_id, store.feedGeneration(request));
  const bytes = new TextEncoder().encode(feed), hash = await publicationChecksum(bytes);
  const object = await bucket.put(key, bytes, { onlyIf: new Headers({ "If-None-Match": "*" }), sha256: hash,
    httpMetadata: { contentType: "application/rss+xml; charset=utf-8" } });
  if (!object || object.key !== key || object.size !== bytes.length || !object.checksums.sha256 ||
    toHex(object.checksums.sha256) !== hash) throw new Error("Immutable Feed write was not verified");
}

async function persistAudio(bucket: SqlitePublicationBucket, prepared: PreparedEpisode): Promise<void> {
  const payload = prepared.audio;
  if (!payload) return;
  const object = await bucket.get(payload.key, { onlyIf: { etagMatches: payload.etag } });
  try {
    if (!matches(object, payload) || !object?.body) throw new Error("Verified audio upload changed before publication");
    const key = audioKey(prepared.revision, prepared.request.show_id).key;
    const result = await bucket.put(key, object.body, { onlyIf: new Headers({ "If-None-Match": "*" }),
      sha256: payload.sha256, customMetadata: { sha256: payload.sha256 }, httpMetadata: { contentType: "audio/mpeg" } });
    const checksum = result?.checksums.sha256;
    const hash = checksum ? toHex(checksum) : null;
    if (!result || result.key !== key || result.size !== payload.length_bytes || hash !== payload.sha256 ||
      result.customMetadata?.sha256 !== payload.sha256) throw new Error("Immutable audio write was not verified");
  } finally {
    if (object?.body && !object.body.locked) await object.body.cancel();
  }
}

export function createSqlitePublicationExecutor(store: SqlitePublicationContent, bucket: SqlitePublicationBucket,
  configInput: SqliteServiceConfig, effects: SqlitePublicationEffects): SqlitePublicationExecutor<PreparedSqlitePublication> {
  const config = sqliteServiceConfigSchema.parse(configInput);
  const perform = async (request: SqlitePublicationRequest, phase: SqlitePublicationEffectFailure["phase"], operation: () => Promise<void>) => {
    try { await operation(); }
    catch {
      const event: SqlitePublicationEffectFailure = { event: "sqlite_publication_effect_failed", job_id: request.job_id,
        request_id: request.request_id, phase, reason_code: "publication_effect_unverified" };
      if (effects.onFailure) effects.onFailure(event);
      else console.error(JSON.stringify(event));
      throw new Error("SQLite publication effect was not verified");
    }
  };
  return {
    async validate(inputRequest) {
      const request = store.requireRunning(inputRequest);
      const feedGeneration = store.feedGeneration(request);
      if (request.service_id !== config.service_id || request.service_config_sha256 !== await sqliteServiceConfigHash(config)) {
        throw new SqlitePublicationInputError("runtime_mismatch");
      }
      const target = store.target(request);
      const episodes = store.episodes(request.show_id);
      store.confirmCommittedReadBoundary(request);
      if (request.action !== "publish") {
        const restored = request.kind === "episode" && request.action === "restore" ? [target.base!] : [];
        const visible = request.kind === "episode" ? [...episodes.filter((episode) => episode.episode_id !== request.episode_id), ...restored] : episodes;
        if (request.action === "restore") {
          for (const revision of request.kind === "show" ? visible : restored) {
            const media = audioKey(revision, request.show_id);
            store.requireMedia(request.show_id, revision, media.revisionId);
            const object = await bucket.head(media.key);
            const checksum = object?.checksums.sha256;
            const hash = checksum ? toHex(checksum) : null;
            if (!object || object.size !== revision.length_bytes || hash !== revision.sha256 || object.customMetadata?.sha256 !== revision.sha256) throw new SqlitePublicationInputError("validation_failed");
          }
          if (request.kind === "show" && !await bucket.head(`public/podcasts/${request.show_id}/cover.${target.coverExtension!}`)) throw new SqlitePublicationInputError("validation_failed");
        }
        const writeFeed = request.kind === "show" ? request.action === "restore" : target.show.lifecycle === "published";
        return { kind: "lifecycle", request, feedGeneration, ...(writeFeed ? { feed: input(() => renderPublicationFeed(target.metadata!, visible, config.public_base_url, target.coverExtension!)) } : {}) };
      }
      if (request.kind === "show") {
        const metadataPayload = request.payloads.find((payload) => payload.asset === "show_metadata")!;
        const coverPayload = request.payloads.find((payload) => payload.asset.startsWith("cover_"))!;
        const metadataBytes = await readPayload(bucket, metadataPayload);
        const metadata = input(() => { const parsed = parseShowMetadata(text(metadataBytes)); assertShowMetadataInputLimits(parsed); return parsed; });
        const cover = await readPayload(bucket, coverPayload);
        const extension = coverPayload.asset === "cover_png" ? "png" : "jpg";
        const signature = extension === "png" ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
        if (metadata.show_id !== request.show_id || (metadata.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg") !== extension ||
          !signature.every((byte, index) => cover[index] === byte)) throw new SqlitePublicationInputError("validation_failed");
        if (target.show.lifecycle === "draft") {
          await requireEmpty(bucket, `system/shows/${request.show_id}/`);
          await requireEmpty(bucket, `public/podcasts/${request.show_id}/`);
          await requireEmpty(bucket, `public/episodes/${request.show_id}/`);
        }
        const feed = input(() => renderPublicationFeed(metadata, episodes, config.public_base_url, extension));
        return { kind: "show", request, feedGeneration, metadata, cover, extension, feed };
      }
      const metadataPayload = request.payloads.find((payload) => payload.asset === "episode_metadata");
      const metadataBytes = metadataPayload ? await readPayload(bucket, metadataPayload) : null;
      const metadata = metadataBytes ? input(() => { const parsed = parseEpisodeDraft(text(metadataBytes)); assertEpisodeDraftInputLimits(parsed); return parsed; }) : episodeDraftFromRevision(target.base!);
      if (metadata.episode_id !== request.episode_id || target.base && !sameEpisodeIdentity(metadata, target.base)) {
        throw new SqlitePublicationInputError("validation_failed");
      }
      const audio = request.payloads.find((payload) => payload.asset === "audio");
      if (audio && !matches(await bucket.head(audio.key), audio)) throw new SqlitePublicationInputError("validation_failed");
      const revision = input(() => episodeRevisionSchema.parse({ ...metadata, revision_id: request.job_id,
        enclosure_url: audio ? `${config.public_base_url.replace(/\/$/, "")}/podcasts/${request.show_id}/episodes/${request.episode_id}/${request.job_id}.mp3` : target.base!.enclosure_url,
        content_type: "audio/mpeg", length_bytes: audio?.length_bytes ?? target.base!.length_bytes,
        duration_seconds: audio?.duration_seconds ?? target.base!.duration_seconds, sha256: audio?.sha256 ?? target.base!.sha256,
        updated_at: (effects.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")))() }));
      store.requireUniqueGuid(request.show_id, revision);
      const media = audio ? input(() => audioKey(revision, request.show_id)) : audioKey(revision, request.show_id);
      if (!target.base) {
        await requireEmpty(bucket, `public/episodes/${request.show_id}/${request.episode_id}/`);
        await requireEmpty(bucket, `public/podcasts/${request.show_id}/episodes/${request.episode_id}/`);
      }
      await requireAbsent(bucket, `public/episodes/${request.show_id}/${request.episode_id}/revisions/${request.job_id}.toml`);
      if (audio) await requireAbsent(bucket, media.key);
      else {
        store.requireMedia(request.show_id, revision, media.revisionId);
        const object = await bucket.head(media.key);
        const checksum = object?.checksums.sha256;
        const hash = checksum ? toHex(checksum) : null;
        if (!object || object.size !== revision.length_bytes || hash !== revision.sha256 || object.customMetadata?.sha256 !== revision.sha256) {
          throw new SqlitePublicationInputError("validation_failed");
        }
      }
      const feed = input(() => renderPublicationFeed(target.metadata!,
        [...episodes.filter((episode) => episode.episode_id !== request.episode_id), revision], config.public_base_url, target.coverExtension!));
      return { kind: "episode", request, feedGeneration, revision, audio, audioRevisionId: media.revisionId, feed };
    },
    async publish(prepared) {
      if (prepared.feedGeneration !== store.feedGeneration(prepared.request)) throw new Error("Prepared Feed generation differs");
      const showId = prepared.request.show_id;
      const run = (phase: SqlitePublicationEffectFailure["phase"], operation: () => Promise<void>) => perform(prepared.request, phase, operation);
      if (prepared.kind === "lifecycle") {
        if (prepared.feed !== undefined) await run("feed", () => persistFeed(store, bucket, prepared.request, prepared.feed!));
        await run("cache_purge", () => effects.purge({ showId, cover: prepared.request.kind === "show", ...(prepared.request.kind === "episode" ? { episodeId: prepared.request.episode_id! } : {}) }));
        return;
      }
      if (prepared.kind === "show") {
        await run("show_metadata", () => put(bucket, `system/shows/${showId}/show.toml`, stringifyToml(prepared.metadata), "application/toml"));
        await run("cover", () => put(bucket, `public/podcasts/${showId}/cover.${prepared.extension}`, prepared.cover,
          prepared.extension === "jpg" ? "image/jpeg" : "image/png"));
      } else {
        await run("audio", () => persistAudio(bucket, prepared));
        await run("revision", () => put(bucket, `public/episodes/${showId}/${prepared.revision.episode_id}/revisions/${prepared.revision.revision_id}.toml`,
          stringifyToml(prepared.revision), "application/toml", true));
        await run("episode_metadata", () => put(bucket, `public/episodes/${showId}/${prepared.revision.episode_id}/metadata.toml`, stringifyToml(prepared.revision), "application/toml"));
      }
      await run("feed", () => persistFeed(store, bucket, prepared.request, prepared.feed));
      await run("cache_purge", () => effects.purge({ showId, cover: prepared.kind === "show",
        ...(prepared.kind === "episode" ? { episodeId: prepared.revision.episode_id } : {}) }));
    },
    commit(prepared) {
      if (prepared.feedGeneration !== store.feedGeneration(prepared.request)) throw new Error("Prepared Feed generation differs");
      if (prepared.kind === "lifecycle") store.commitLifecycle(prepared.request);
      else if (prepared.kind === "show") store.commitShow(prepared.request, prepared.metadata, prepared.extension);
      else store.commitEpisode(prepared.request, prepared.revision, prepared.audioRevisionId, prepared.audio !== undefined);
    },
  };
}
