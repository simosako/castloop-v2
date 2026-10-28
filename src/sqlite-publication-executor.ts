import { episodeDraftFromRevision, episodeRevisionSchema, parsePublicAssetPath, sameEpisodeIdentity } from "../packages/shared/src/index";
import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import { sameSqlitePublicationContent } from "../packages/shared/src/sqlite-direct-publication";
import type { SqliteContentMutation, SqliteDirectPublicationRequest } from "../packages/shared/src/sqlite-direct-publication";
import { sqliteMediaKey } from "../packages/shared/src/sqlite-media";
import { sqliteServiceConfigSchema } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SITE_PAGE_SIZE } from "../packages/shared/src/website";
import { SqlitePublicationInputError } from "./sqlite-publication-queue";
import type { SqlitePublicationExecutor } from "./sqlite-publication-queue";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { publicationChecksum, renderPublicationFeed } from "./publication-inputs";
import type { SqliteCoverIdentity } from "./sqlite-cover";
import { canonicalEnclosureUrl } from "./media-url";
import { SITE_HTML_LIMIT_BYTES, orderedSiteEpisodes, renderSiteEpisode, renderSiteListingPage, siteCssHash, siteDateFormatter } from "./site-renderer";
import type { SiteRenderInput } from "./site-renderer";
import type { SitePurgeTarget } from "./site-storage";

type ObjectHead = Pick<R2Object, "key" | "size" | "etag" | "version" | "customMetadata"> & { checksums: Pick<R2Checksums, "sha256"> };
export type SqlitePublicationBucket = {
  head: (key: string) => Promise<ObjectHead | null>;
  get: (key: string, options?: R2GetOptions) => Promise<(ObjectHead & { body?: ReadableStream<Uint8Array> }) | null>;
  put: (key: string, body: string | Uint8Array | ReadableStream<Uint8Array>, options?: R2PutOptions) => Promise<ObjectHead | null>;
  list?: (options: { prefix: string; limit: number }) => Promise<{ objects: Array<{ key: string }>; truncated: boolean }>;
};
export type SqlitePublicationEffectFailure = { event: "sqlite_publication_effect_failed"; phase: "cache_purge";
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
function audioRevisionId(revision: EpisodeRevision, showId: string): string {
  const asset = parsePublicAssetPath(new URL(revision.enclosure_url).pathname);
  if (!asset || asset.kind !== "audio" || asset.showId !== showId || asset.episodeId !== revision.episode_id) {
    throw new Error("Episode enclosure URL does not match its Show and Episode");
  }
  return asset.revisionId;
}

// Dedicated domain maintenance uses this check; ordinary publication does not read R2.
export async function verifyCover(bucket: SqlitePublicationBucket, showId: string, extension: "jpg" | "png", cover: SqliteCoverIdentity): Promise<void> {
  const key = sqliteMediaKey(showId, { sha256: cover.sha256, extension });
  const object = await bucket.head(key);
  if (!object || object.key !== key || object.size !== cover.lengthBytes) throw new SqlitePublicationInputError("validation_failed");
}

async function validateSiteRender(show: ShowMetadata, episodes: EpisodeRevision[], extension: "jpg" | "png",
  baseUrl: string, siteIds: Record<string, string>, changedEpisode?: EpisodeRevision): Promise<void> {
  if (show.site_mode !== "builtin") return;
  await input(() => siteCssHash(show.site_css));
  input(() => {
    const formatDate = siteDateFormatter(show.site_timezone);
    const renderInput: SiteRenderInput = { origin: baseUrl, coverExtension: extension, episodeSiteIds: siteIds, show: {
      show_id: show.show_id, title: show.title, description: show.description, language: show.language, author: show.author,
      ...(show.site_timezone !== undefined ? { site_timezone: show.site_timezone } : {}),
      ...(show.site_css !== undefined ? { site_css: show.site_css } : {}), ...(show.copyright ? { copyright: show.copyright } : {}),
    } };
    const sorted = orderedSiteEpisodes(episodes), pages = Math.max(1, Math.ceil(sorted.length / SITE_PAGE_SIZE));
    const listing = renderSiteListingPage(renderInput, sorted.slice(0, SITE_PAGE_SIZE), 1, pages, formatDate);
    if (new TextEncoder().encode(listing).byteLength > SITE_HTML_LIMIT_BYTES) throw new Error("Site listing HTML exceeds budget");
    if (changedEpisode && new TextEncoder().encode(renderSiteEpisode(renderInput, changedEpisode, formatDate)).byteLength > SITE_HTML_LIMIT_BYTES) {
      throw new Error("Site episode HTML exceeds budget");
    }
  });
}

export function createSqlitePublicationExecutor(store: SqlitePublicationContent,
  configInput: SqliteServiceConfig, effects: SqlitePublicationEffects): SqlitePublicationExecutor {
  const config = sqliteServiceConfigSchema.parse(configInput);
  return {
    current(request) {
      const target = store.inspect(request.show_id, request.episode_id);
      if (!target.show || !["published", "unpublished"].includes(target.show.lifecycle)) return null;
      const show = store.currentShowRevision(request.show_id, config.public_base_url);
      const episode = request.kind === "episode" ? store.currentEpisodeRevision(request.show_id, request.episode_id!, config.public_base_url) : null;
      const revisionId = request.kind === "show" ? show?.revision_id : episode?.revision_id;
      if (!revisionId) return null;
      const lifecycle = request.kind === "show" ? target.show.lifecycle : target.episode?.lifecycle;
      if (request.action === "unpublish") return lifecycle === "unpublished" ? revisionId : null;
      if (request.action === "restore") return lifecycle === "published" ? revisionId : null;
      const comparison = { service_id: config.service_id, show_id: request.show_id, episode_id: request.episode_id,
        show_lifecycle: target.show.lifecycle, episode_lifecycle: target.episode?.lifecycle,
        show_content: show, episode_content: episode };
      if (request.action === "publish") return sameSqlitePublicationContent(request, comparison) ? revisionId : null;
      if (request.kind === "show") {
        const source = store.showRevision(request.show_id, request.target_revision_id!, config.public_base_url);
        return source && sameSqlitePublicationContent({ ...request, action: "publish", kind: "show", metadata: source.metadata,
          cover: { sha256: source.cover.sha256, length_bytes: source.cover.length_bytes, extension: source.cover.extension } }, comparison) ? revisionId : null;
      }
      const source = store.episodeRevision(request.show_id, request.episode_id!, request.target_revision_id!, config.public_base_url);
      return source && sameSqlitePublicationContent({ ...request, action: "publish", kind: "episode", episode_id: request.episode_id!,
        expected_episode_lifecycle_version: request.expected_episode_lifecycle_version!, metadata: source.metadata,
        audio: { sha256: source.audio.sha256, length_bytes: source.audio.length_bytes, duration_seconds: source.audio.duration_seconds } }, comparison) ? revisionId : null;
    },
    async execute(request) {
      const mutation: SqliteContentMutation = { ...request, revision_id: crypto.randomUUID() };
      const target = store.target(mutation), feedGeneration = store.nextFeedGeneration(request.show_id);
      const revisionId = request.action === "unpublish" || request.action === "restore" ? request.kind === "show" ?
        store.currentShowRevision(request.show_id, config.public_base_url)!.revision_id : target.base!.revision_id : mutation.revision_id;
      const episodes = request.kind === "show" && request.action === "unpublish" ? [] : store.episodes(request.show_id);
      let show = target.metadata!, extension = target.coverExtension!;
      let changedEpisode: EpisodeRevision | undefined;
      let commit: () => void;
      const timestamp = (effects.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, "Z")))();
      if (request.action === "unpublish" || request.action === "restore") {
        if (request.kind === "episode") {
          const index = episodes.findIndex((episode) => episode.episode_id === request.episode_id);
          if (index >= 0) episodes.splice(index, 1);
          if (request.action === "restore") { changedEpisode = target.base!; episodes.push(changedEpisode); }
        }
        commit = () => store.commitLifecycle(mutation);
      } else if (request.kind === "show") {
        const source = request.action === "restore_revision" ? store.showRevision(request.show_id, request.target_revision_id!, config.public_base_url) : null;
        if (request.action === "restore_revision" && !source) throw new SqlitePublicationInputError("validation_failed");
        show = request.action === "publish" ? request.metadata : source!.metadata;
        const cover = request.action === "publish" ? request.cover : source!.cover;
        extension = cover.extension;
        if (target.coverExtension !== null && target.coverExtension !== extension) throw new SqlitePublicationInputError("validation_failed");
        const identity = { generation: source?.cover.generation ?? store.nextCoverGeneration(request.show_id), sha256: cover.sha256, lengthBytes: cover.length_bytes };
        const metadataSha256 = await publicationChecksum(new TextEncoder().encode(JSON.stringify(show)));
        commit = () => store.commitShow(mutation, show, extension, identity, { metadataSha256, updatedAt: timestamp,
          ...(source ? { restoredFromRevisionId: source.revision_id } : {}) });
      } else {
        const source = request.action === "restore_revision" ? store.episodeRevision(request.show_id, request.episode_id!, request.target_revision_id!, config.public_base_url) : null;
        if (request.action === "restore_revision" && !source) throw new SqlitePublicationInputError("validation_failed");
        const metadata = request.action === "publish" ? request.metadata : source!.metadata;
        const audio = request.action === "publish" ? request.audio : source!.audio;
        if (target.base && !sameEpisodeIdentity(metadata, episodeDraftFromRevision(target.base))) throw new SqlitePublicationInputError("validation_failed");
        const reuse = source?.revision ?? (target.base && target.base.sha256 === audio.sha256 && target.base.length_bytes === audio.length_bytes &&
          target.base.duration_seconds === audio.duration_seconds ? target.base : null);
        const audioId = reuse ? audioRevisionId(reuse, request.show_id) : mutation.revision_id;
        const revision = input(() => episodeRevisionSchema.parse({ ...metadata, revision_id: mutation.revision_id,
          enclosure_url: reuse ? canonicalEnclosureUrl(reuse, request.show_id, config.public_base_url) :
            `${config.public_base_url.replace(/\/$/, "")}/podcasts/${request.show_id}/episodes/${request.episode_id}/${audioId}.mp3`,
          content_type: "audio/mpeg", length_bytes: audio.length_bytes, duration_seconds: audio.duration_seconds, sha256: audio.sha256, updated_at: timestamp }));
        store.requireUniqueGuid(request.show_id, revision);
        if (reuse) store.requireMedia(request.show_id, revision, audioId);
        const metadataSha256 = await publicationChecksum(new TextEncoder().encode(JSON.stringify(metadata)));
        const index = episodes.findIndex((episode) => episode.episode_id === request.episode_id);
        if (index >= 0) episodes.splice(index, 1);
        episodes.push(revision); changedEpisode = revision;
        commit = () => store.commitEpisode(mutation, revision, audioId, !reuse, { metadataSha256,
          ...(source ? { restoredFromRevisionId: source.revision_id } : {}) });
      }
      const siteIds = await store.sites.ids.plan(request.show_id, episodes);
      if (!(request.kind === "show" && request.action === "unpublish") && (request.kind === "show" || target.show.lifecycle === "published")) {
        input(() => renderPublicationFeed(show, episodes, config.public_base_url, extension, siteIds));
        await validateSiteRender(show, episodes, extension, config.public_base_url, siteIds, changedEpisode);
      }
      try {
        await effects.purge({ showId: request.show_id, cover: request.kind === "show", ...(request.episode_id ? { episodeId: request.episode_id } : {}) });
        if ((show?.site_mode === "builtin" || target.metadata?.site_mode === "builtin") && effects.purgeSite) {
          const siteId = request.episode_id ? siteIds[request.episode_id] : undefined;
          await effects.purgeSite({ showId: request.show_id, ...(siteId ? { siteId } : {}) });
        }
      } catch {
        const event: SqlitePublicationEffectFailure = { event: "sqlite_publication_effect_failed", phase: "cache_purge", reason_code: "publication_effect_unverified" };
        if (effects.onFailure) effects.onFailure(event); else console.error(JSON.stringify(event));
        throw new Error("SQLite publication cache purge failed");
      }
      return { revisionId, commit: () => {
        if (feedGeneration !== store.nextFeedGeneration(request.show_id)) throw new SqlitePublicationInputError("base_conflict");
        store.target(mutation);
        store.sites.ids.commit(request.show_id, siteIds);
        commit();
      } };
    },
  };
}
