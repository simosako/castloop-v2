import { assertEpisodeDraftInputLimits, assertShowMetadataInputLimits, episodeDraftFromRevision, episodeRevisionSchema, parseEpisodeDraft, parsePublicAssetPath,
  parseShowMetadata, sameEpisodeIdentity, toHex } from "../packages/shared/src/index";
import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import { parseSqlitePublicationRequest } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationRequest, SqliteVerifiedUpload } from "../packages/shared/src/sqlite-publication";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SqlitePublicationInputError } from "./sqlite-publication-queue";
import type { SqlitePublicationExecutor } from "./sqlite-publication-queue";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { publicationChecksum, renderPublicationFeed } from "./publication-inputs";
import { sqliteCoverSnapshotKey } from "./sqlite-cover";
import type { SqliteCoverIdentity } from "./sqlite-cover";
import { canonicalEnclosureUrl } from "./media-url";
import { formatSiteDescription } from "./site-description";
import { SITE_HTML_LIMIT_BYTES, orderedSiteEpisodes, renderSiteEpisode, renderSiteListingPage, siteCssHash, siteDateFormatter } from "./site-renderer";
import type { SiteRenderInput } from "./site-renderer";
import { SITE_PAGE_SIZE } from "../packages/shared/src/website";
import type { SitePurgeTarget } from "./site-storage";

type ObjectHead = Pick<R2Object, "key" | "size" | "etag" | "version" | "customMetadata"> & { checksums: Pick<R2Checksums, "sha256"> };
type ObjectBody = ObjectHead & { body?: ReadableStream<Uint8Array> };
export type SqlitePublicationBucket = {
  head: (key: string) => Promise<ObjectHead | null>;
  get: (key: string, options?: R2GetOptions) => Promise<ObjectBody | null>;
  put: (key: string, body: string | Uint8Array | ReadableStream<Uint8Array>, options?: R2PutOptions) => Promise<ObjectHead | null>;
  list?: (options: { prefix: string; limit: number }) => Promise<{ objects: Array<{ key: string }>; truncated: boolean }>;
};
type PreparedShow = { kind: "show"; request: SqlitePublicationRequest; metadata: ShowMetadata; metadataSha256: string;
  updatedAt: string; cover?: Uint8Array; coverIdentity: SqliteCoverIdentity; extension: "jpg" | "png"; feed: string;
  restoredFromRevisionId?: string };
type PreparedEpisode = { kind: "episode"; request: SqlitePublicationRequest; revision: EpisodeRevision; metadataSha256: string;
  audio?: SqliteVerifiedUpload; audioRevisionId: string; feed: string; restoredFromRevisionId?: string };
type PreparedLifecycle = { kind: "lifecycle"; request: SqlitePublicationRequest; feed?: string };
export type PreparedSqlitePublication = (PreparedShow | PreparedEpisode | PreparedLifecycle) & {
  feedGeneration: number;
  siteIds: Record<string, string>;
  sitePurge?: SitePurgeTarget;
};
export type SqlitePublicationEffectFailure = { event: "sqlite_publication_effect_failed"; job_id: string; request_id: string;
  phase: "show_metadata" | "cover" | "audio" | "revision" | "episode_metadata" | "feed" | "cache_purge";
  reason_code: "publication_effect_unverified" };
export type SqlitePublicationEffects = {
  purge: (target: { showId: string; cover: boolean; episodeId?: string }) => Promise<void>;
  purgeSite?: (target: SitePurgeTarget) => Promise<void>;
  now?: () => string;
  onFailure?: (event: SqlitePublicationEffectFailure) => void;
};

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
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
}

function audioKey(revision: EpisodeRevision, showId: string): { key: string; revisionId: string } {
  const asset = parsePublicAssetPath(new URL(revision.enclosure_url).pathname);
  if (!asset || asset.kind !== "audio" || asset.showId !== showId || asset.episodeId !== revision.episode_id) {
    throw new Error("Episode enclosure URL does not match its Show and Episode");
  }
  return { key: asset.key, revisionId: asset.revisionId };
}

export async function verifyCover(bucket: SqlitePublicationBucket, showId: string, extension: "jpg" | "png",
  cover: SqliteCoverIdentity): Promise<void> {
  const key = sqliteCoverSnapshotKey(showId, cover.generation, extension);
  const object = await bucket.head(key);
  const checksum = object?.checksums.sha256;
  const hash = checksum ? toHex(checksum) : null;
  if (!object || object.key !== key || object.size !== cover.lengthBytes || hash !== cover.sha256 || object.customMetadata?.sha256 !== cover.sha256) {
    throw new SqlitePublicationInputError("validation_failed");
  }
}

async function persistCover(bucket: SqlitePublicationBucket, prepared: PreparedShow): Promise<void> {
  if (!prepared.cover) {
    await verifyCover(bucket, prepared.request.show_id, prepared.extension, prepared.coverIdentity);
    return;
  }
  const key = sqliteCoverSnapshotKey(prepared.request.show_id, prepared.coverIdentity.generation, prepared.extension);
  const existing = await bucket.head(key);
  if (existing) {
    const hash = existing.checksums.sha256 ? toHex(existing.checksums.sha256) : null;
    if (existing.key === key && existing.size === prepared.coverIdentity.lengthBytes &&
      hash === prepared.coverIdentity.sha256 && existing.customMetadata?.sha256 === prepared.coverIdentity.sha256) {
      return;
    }
    throw new Error("Existing cover snapshot differs from expected identity");
  }
  const result = await bucket.put(key, prepared.cover, {
    sha256: prepared.coverIdentity.sha256,
    customMetadata: { sha256: prepared.coverIdentity.sha256 },
    httpMetadata: { contentType: prepared.extension === "png" ? "image/png" : "image/jpeg" },
  });
  const checksum = result?.checksums.sha256;
  const hash = checksum ? toHex(checksum) : null;
  if (!result || result.key !== key || result.size !== prepared.coverIdentity.lengthBytes ||
    hash !== prepared.coverIdentity.sha256 || result.customMetadata?.sha256 !== prepared.coverIdentity.sha256) {
    throw new Error("Immutable cover snapshot write was not verified");
  }
}

async function persistAudio(bucket: SqlitePublicationBucket, prepared: PreparedEpisode): Promise<void> {
  const payload = prepared.audio;
  if (!payload) return;
  const key = audioKey(prepared.revision, prepared.request.show_id).key;
  const existing = await bucket.head(key);
  if (existing) {
    const hash = existing.checksums.sha256 ? toHex(existing.checksums.sha256) : null;
    if (existing.key === key && existing.size === payload.length_bytes &&
      hash === payload.sha256 && existing.customMetadata?.sha256 === payload.sha256) {
      return;
    }
    throw new Error("Existing audio object differs from expected identity");
  }
  const object = await bucket.get(payload.key, { onlyIf: { etagMatches: payload.etag } });
  try {
    if (!matches(object, payload) || !object?.body) throw new Error("Verified audio upload changed before publication");
    const result = await bucket.put(key, object.body, {
      sha256: payload.sha256, customMetadata: { sha256: payload.sha256 }, httpMetadata: { contentType: "audio/mpeg" },
    });
    const checksum = result?.checksums.sha256;
    const hash = checksum ? toHex(checksum) : null;
    if (!result || result.key !== key || result.size !== payload.length_bytes || hash !== payload.sha256 ||
      result.customMetadata?.sha256 !== payload.sha256) throw new Error("Immutable audio write was not verified");
  } finally {
    if (object?.body && !object.body.locked) await object.body.cancel();
  }
}

async function validateSiteRender(show: ShowMetadata, episodes: EpisodeRevision[], extension: "jpg" | "png",
  baseUrl: string, siteIds: Record<string, string>, changedEpisode?: EpisodeRevision): Promise<void> {
  if (show.site_mode !== "builtin") return;
  await input(() => siteCssHash(show.site_css));
  input(() => {
    const formatDate = siteDateFormatter(show.site_timezone);
    const renderInput: SiteRenderInput = {
      origin: baseUrl,
      coverExtension: extension,
      episodeSiteIds: siteIds,
      show: {
        show_id: show.show_id,
        title: show.title,
        description: show.description,
        language: show.language,
        author: show.author,
        ...(show.site_timezone !== undefined ? { site_timezone: show.site_timezone } : {}),
        ...(show.site_css !== undefined ? { site_css: show.site_css } : {}),
        ...(show.copyright ? { copyright: show.copyright } : {}),
      },
    };
    const sorted = orderedSiteEpisodes(episodes);
    const pages = Math.max(1, Math.ceil(sorted.length / SITE_PAGE_SIZE));
    const listing = renderSiteListingPage(renderInput, sorted.slice(0, SITE_PAGE_SIZE), 1, pages, formatDate);
    if (new TextEncoder().encode(listing).byteLength > SITE_HTML_LIMIT_BYTES) throw new Error("Site listing HTML exceeds budget");
    if (changedEpisode) {
      formatSiteDescription(changedEpisode.description);
      const detail = renderSiteEpisode(renderInput, changedEpisode, formatDate);
      if (new TextEncoder().encode(detail).byteLength > SITE_HTML_LIMIT_BYTES) throw new Error("Site episode HTML exceeds budget");
    }
  });
}

export function createSqlitePublicationExecutor(store: SqlitePublicationContent, bucket: SqlitePublicationBucket,
  configInput: SqliteServiceConfig, effects: SqlitePublicationEffects): SqlitePublicationExecutor & {
    validate: (request: SqlitePublicationRequest) => Promise<PreparedSqlitePublication>;
    publish: (prepared: PreparedSqlitePublication) => Promise<void>;
    commit: (prepared: PreparedSqlitePublication) => void;
  } {
  const config = sqliteServiceConfigSchema.parse(configInput);
  const prepareFeedAndSite = async (show: ShowMetadata, episodes: EpisodeRevision[], extension: "jpg" | "png", changedEpisode?: EpisodeRevision) => {
    const siteIds = await store.sites.ids.plan(show.show_id, episodes);
    const feed = input(() => renderPublicationFeed(show, episodes, config.public_base_url, extension, siteIds));
    await validateSiteRender(show, episodes, extension, config.public_base_url, siteIds, changedEpisode);
    return { feed, siteIds };
  };
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
      const request = parseSqlitePublicationRequest(inputRequest);
      if (request.service_id !== config.service_id || request.service_config_sha256 !== await sqliteServiceConfigHash(config)) {
        throw new SqlitePublicationInputError("runtime_mismatch");
      }
      const target = store.target(request);
      const feedGeneration = store.nextFeedGeneration(request.show_id);
      const episodes = request.kind === "show" && request.action === "unpublish" ? [] : store.episodes(request.show_id);
      const hadSite = target.metadata?.site_mode === "builtin";
      if ((request.action === "publish" || request.action === "restore_revision") && request.kind === "episode" && target.base) {
        const media = audioKey(target.base, request.show_id);
        store.requireMedia(request.show_id, target.base, media.revisionId);
      }
      if ((request.action === "publish" || request.action === "restore_revision") && request.kind === "show" && target.show.lifecycle === "published") {
        await verifyCover(bucket, request.show_id, target.coverExtension!, target.cover!);
      }
      if (request.action === "unpublish" || request.action === "restore") {
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
          if (request.kind === "show") await verifyCover(bucket, request.show_id, target.coverExtension!, target.cover!);
        }
        const writeFeed = request.kind === "show" ? request.action === "restore" : target.show.lifecycle === "published";
        const rendered = writeFeed ? await prepareFeedAndSite(target.metadata!, visible, target.coverExtension!, restored[0]) : { feed: undefined, siteIds: store.sites.ids.all(request.show_id) };
        const siteId = request.kind === "episode" ? rendered.siteIds[request.episode_id!] ?? store.sites.ids.get(request.show_id, request.episode_id!) ?? undefined : undefined;
        return { kind: "lifecycle", request, feedGeneration, siteIds: rendered.siteIds,
          ...(rendered.feed !== undefined ? { feed: rendered.feed } : {}),
          ...(hadSite ? { sitePurge: { showId: request.show_id, ...(siteId ? { siteId } : {}) } } : {}) };
      }
      const timestamp = () => (effects.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")))();
      if (request.action === "restore_revision") {
        if (request.kind === "show") {
          const source = store.showRevision(request.show_id, request.target_revision_id!, config.public_base_url);
          if (!source || target.coverExtension !== source.cover.extension) throw new SqlitePublicationInputError("validation_failed");
          if (await publicationChecksum(new TextEncoder().encode(JSON.stringify(source.metadata))) !== source.metadata_sha256) throw new Error("Stored Show metadata hash differs");
          const coverIdentity = { generation: source.cover.generation, sha256: source.cover.sha256, lengthBytes: source.cover.length_bytes };
          await verifyCover(bucket, request.show_id, source.cover.extension, coverIdentity);
          if (target.show.lifecycle === "unpublished") {
            for (const revision of episodes) {
              const media = audioKey(revision, request.show_id);
              store.requireMedia(request.show_id, revision, media.revisionId);
              const object = await bucket.head(media.key);
              const checksum = object?.checksums.sha256;
              const hash = checksum ? toHex(checksum) : null;
              if (!object || object.size !== revision.length_bytes || hash !== revision.sha256 || object.customMetadata?.sha256 !== revision.sha256) {
                throw new SqlitePublicationInputError("validation_failed");
              }
            }
          }
          const { feed, siteIds } = await prepareFeedAndSite(source.metadata, episodes, source.cover.extension);
          const hasSite = hadSite || source.metadata.site_mode === "builtin";
          return { kind: "show", request, feedGeneration, siteIds, metadata: source.metadata, metadataSha256: source.metadata_sha256,
            updatedAt: timestamp(), coverIdentity, extension: source.cover.extension, feed, restoredFromRevisionId: source.revision_id,
            ...(hasSite ? { sitePurge: { showId: request.show_id } } : {}) };
        }
        const source = store.episodeRevision(request.show_id, request.episode_id!, request.target_revision_id!, config.public_base_url);
        if (!source || !sameEpisodeIdentity(source.metadata, episodeDraftFromRevision(target.base!))) {
          throw new SqlitePublicationInputError("validation_failed");
        }
        if (await publicationChecksum(new TextEncoder().encode(JSON.stringify(source.metadata))) !== source.metadata_sha256) throw new Error("Stored Episode metadata hash differs");
        const revision = input(() => episodeRevisionSchema.parse({ ...source.metadata, revision_id: request.job_id,
          enclosure_url: canonicalEnclosureUrl(source.revision, request.show_id, config.public_base_url),
          content_type: "audio/mpeg", length_bytes: source.revision.length_bytes,
          duration_seconds: source.revision.duration_seconds, sha256: source.revision.sha256,
          updated_at: timestamp() }));
        store.requireUniqueGuid(request.show_id, revision);
        const media = audioKey(revision, request.show_id);
        if (media.revisionId !== source.audio.audio_revision_id) throw new SqlitePublicationInputError("validation_failed");
        store.requireMedia(request.show_id, revision, media.revisionId);
        const object = await bucket.head(media.key);
        const checksum = object?.checksums.sha256;
        const hash = checksum ? toHex(checksum) : null;
        if (!object || object.size !== revision.length_bytes || hash !== revision.sha256 || object.customMetadata?.sha256 !== revision.sha256) {
          throw new SqlitePublicationInputError("validation_failed");
        }
        const { feed, siteIds } = await prepareFeedAndSite(target.metadata!,
          [...episodes.filter((episode) => episode.episode_id !== request.episode_id), revision], target.coverExtension!, revision);
        const siteId = siteIds[revision.episode_id];
        return { kind: "episode", request, feedGeneration, siteIds, revision, metadataSha256: source.metadata_sha256,
          audioRevisionId: media.revisionId, feed, restoredFromRevisionId: source.revision_id,
          ...(hadSite ? { sitePurge: { showId: request.show_id, ...(siteId ? { siteId } : {}) } } : {}) };
      }
      if (request.kind === "show") {
        const metadataPayload = request.payloads.find((payload) => payload.asset === "show_metadata")!;
        const coverPayload = request.payloads.find((payload) => payload.asset.startsWith("cover_"))!;
        const metadataBytes = await readPayload(bucket, metadataPayload);
        const metadata = input(() => {
          const parsed = parseShowMetadata(text(metadataBytes));
          if ((parsed.site_css_path !== undefined) !== (parsed.site_css !== undefined)) throw new Error("Show CSS input is incomplete");
          assertShowMetadataInputLimits(parsed); return parsed;
        });
        const metadataSha256 = await publicationChecksum(new TextEncoder().encode(JSON.stringify(metadata)));
        const cover = await readPayload(bucket, coverPayload);
        const extension = coverPayload.asset === "cover_png" ? "png" : "jpg";
        const signature = extension === "png" ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
        if (metadata.show_id !== request.show_id || target.coverExtension !== null && target.coverExtension !== extension ||
          (metadata.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg") !== extension ||
          !signature.every((byte, index) => cover[index] === byte)) throw new SqlitePublicationInputError("validation_failed");
        const { feed, siteIds } = await prepareFeedAndSite(metadata, episodes, extension);
        const coverIdentity = { generation: store.nextCoverGeneration(request.show_id), sha256: coverPayload.sha256, lengthBytes: cover.byteLength };
        const hasSite = hadSite || metadata.site_mode === "builtin";
        return { kind: "show", request, feedGeneration, siteIds, metadata, metadataSha256, updatedAt: timestamp(), cover, coverIdentity, extension, feed,
          ...(hasSite ? { sitePurge: { showId: request.show_id } } : {}) };
      }
      const metadataPayload = request.payloads.find((payload) => payload.asset === "episode_metadata");
      const metadataBytes = metadataPayload ? await readPayload(bucket, metadataPayload) : null;
      const metadata = metadataBytes ? input(() => { const parsed = parseEpisodeDraft(text(metadataBytes)); assertEpisodeDraftInputLimits(parsed); return parsed; }) : episodeDraftFromRevision(target.base!);
      if (metadata.episode_id !== request.episode_id || target.base && !sameEpisodeIdentity(metadata, target.base)) {
        throw new SqlitePublicationInputError("validation_failed");
      }
      const metadataSha256 = await publicationChecksum(new TextEncoder().encode(JSON.stringify(metadata)));
      const audio = request.payloads.find((payload) => payload.asset === "audio");
      if (audio && !matches(await bucket.head(audio.key), audio)) throw new SqlitePublicationInputError("validation_failed");
      const revision = input(() => episodeRevisionSchema.parse({ ...metadata, revision_id: request.job_id,
        enclosure_url: audio ? `${config.public_base_url.replace(/\/$/, "")}/podcasts/${request.show_id}/episodes/${request.episode_id}/${request.job_id}.mp3` : target.base!.enclosure_url,
        content_type: "audio/mpeg", length_bytes: audio?.length_bytes ?? target.base!.length_bytes,
        duration_seconds: audio?.duration_seconds ?? target.base!.duration_seconds, sha256: audio?.sha256 ?? target.base!.sha256,
        updated_at: timestamp() }));
      store.requireUniqueGuid(request.show_id, revision);
      const media = audio ? input(() => audioKey(revision, request.show_id)) : audioKey(revision, request.show_id);
      if (!audio) {
        store.requireMedia(request.show_id, revision, media.revisionId);
        const object = await bucket.head(media.key);
        const checksum = object?.checksums.sha256;
        const hash = checksum ? toHex(checksum) : null;
        if (!object || object.size !== revision.length_bytes || hash !== revision.sha256 || object.customMetadata?.sha256 !== revision.sha256) {
          throw new SqlitePublicationInputError("validation_failed");
        }
      }
      const { feed, siteIds } = await prepareFeedAndSite(target.metadata!,
        [...episodes.filter((episode) => episode.episode_id !== request.episode_id), revision], target.coverExtension!, revision);
      const siteId = siteIds[revision.episode_id];
      return { kind: "episode", request, feedGeneration, siteIds, revision, metadataSha256, audio, audioRevisionId: media.revisionId, feed,
        ...(hadSite ? { sitePurge: { showId: request.show_id, ...(siteId ? { siteId } : {}) } } : {}) };
    },
    async publish(prepared) {
      if (prepared.feedGeneration !== store.nextFeedGeneration(prepared.request.show_id)) throw new Error("Prepared Feed generation differs");
      if (prepared.kind === "show" && prepared.request.action === "publish" &&
        prepared.coverIdentity.generation !== store.nextCoverGeneration(prepared.request.show_id)) {
        throw new Error("Prepared cover generation differs");
      }
      const showId = prepared.request.show_id;
      const run = (phase: SqlitePublicationEffectFailure["phase"], operation: () => Promise<void>) => perform(prepared.request, phase, operation);
      if (prepared.kind === "show") {
        await run("cover", () => persistCover(bucket, prepared));
      } else if (prepared.kind === "episode") {
        await run("audio", () => persistAudio(bucket, prepared));
      }
      await run("cache_purge", () => effects.purge({ showId, cover: prepared.request.kind === "show",
        ...(prepared.request.kind === "episode" ? { episodeId: prepared.request.episode_id! } : {}) }));
      if (prepared.sitePurge && effects.purgeSite) {
        await run("cache_purge", () => effects.purgeSite!(prepared.sitePurge!));
      }
    },
    commit(prepared) {
      if (prepared.feedGeneration !== store.nextFeedGeneration(prepared.request.show_id)) throw new Error("Prepared Feed generation differs");
      store.sites.ids.commit(prepared.request.show_id, prepared.siteIds);
      if (prepared.kind === "lifecycle") store.commitLifecycle(prepared.request);
      else if (prepared.kind === "show") store.commitShow(prepared.request, prepared.metadata, prepared.extension, prepared.coverIdentity, {
        metadataSha256: prepared.metadataSha256, updatedAt: prepared.updatedAt, restoredFromRevisionId: prepared.restoredFromRevisionId });
      else store.commitEpisode(prepared.request, prepared.revision, prepared.audioRevisionId, prepared.audio !== undefined, {
        metadataSha256: prepared.metadataSha256, restoredFromRevisionId: prepared.restoredFromRevisionId });
    },
    async execute(request) {
      const prepared = await this.validate(request);
      await this.publish(prepared);
      return () => this.commit(prepared);
    },
  };
}
