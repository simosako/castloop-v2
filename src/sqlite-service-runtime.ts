import { episodeDraftFromRevision } from "../packages/shared/src/index";
import { sqliteContentSnapshotSchema, sqliteRevisionDetailResponseSchema,
  sqliteRevisionListResponseSchema, sqlitePreviewInventorySchema } from "../packages/shared/src/sqlite-revisions";
import type { SqliteContentSnapshot, SqliteRevisionDetailResponse, SqliteRevisionListResponse } from "../packages/shared/src/sqlite-revisions";
import { sqliteRuntimeRequestSchema, sqliteHealthSchema, sqliteInspectionSchema } from "../packages/shared/src/sqlite-service-api";
import type { SqliteHealth, SqliteInspection, SqliteRuntimeRequest } from "../packages/shared/src/sqlite-service-api";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { publicationChecksum } from "./publication-inputs";
import { readSqliteCatalog } from "./sqlite-catalog";
import type { SqliteCatalogRequest, SqliteCatalogResponse } from "../packages/shared/src/sqlite-catalog";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import { SqliteDomainRuntime, pendingSqliteDomain } from "./sqlite-domain-runtime";

export type SqliteCachePurgeConfirmation = (entrypoint: "media" | "site") => void;
export type SqliteRuntimeCache = {
  purge: (showId: string, confirmed?: SqliteCachePurgeConfirmation) => Promise<void>;
  purgeMedia?: (target: { showId: string; episodeId?: string }) => Promise<void>;
  purgeSite?: (target: { showId: string; siteId?: string }) => Promise<void>;
};

export class SqliteServiceRuntime {
  readonly domains: SqliteDomainRuntime;
  constructor(private readonly storage: PublicationQueueStorage, readonly queue: SqlitePublicationQueue,
    readonly content: SqlitePublicationContent, private readonly config: SqliteServiceConfig,
    private readonly cache: SqliteRuntimeCache, private readonly actual: SqlitePublicationRuntime = queue.identity(), showId?: string) {
    this.domains = new SqliteDomainRuntime(storage, queue, content, config, cache, actual, showId);
  }
  ready(): boolean { return !pendingSqliteDomain(this.storage); }
  catalog(request: SqliteCatalogRequest): SqliteCatalogResponse {
    if (!this.ready()) throw new Error("SQLite runtime is not ready");
    return readSqliteCatalog(this.storage, request, this.queue.identity(), this.config.public_base_url);
  }
  requireTarget(input: SqliteRuntimeRequest): SqliteRuntimeRequest {
    const request = sqliteRuntimeRequestSchema.parse(input), identity = this.queue.identity();
    if (request.service_id !== identity.service_id || request.service_config_sha256 !== identity.service_config_sha256) {
      throw new Error("SQLite runtime request has a stale target");
    }
    return request;
  }
  health(): SqliteHealth {
    return sqliteHealthSchema.parse({ ...this.actual, protocol: "sqlite-sequential-v1", invocation_id: crypto.randomUUID(),
      revision_history: "sqlite-revisions-v1",
      website: "static-show-v2",
      delivery_statistics: "episode-daily-v1",
      domain_changes: "sqlite-domain-change-v1",
      publication_ready: this.ready() });
  }
  async inspect(showId: string, episodeId?: string): Promise<SqliteInspection> {
    if (!this.ready()) throw new Error("SQLite runtime is not ready");
    const target = this.content.inspect(showId, episodeId);
    const digest = target.base ? await publicationChecksum(new TextEncoder().encode(JSON.stringify(episodeDraftFromRevision(target.base)))) : undefined;
    return sqliteInspectionSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
      revision_history: "sqlite-revisions-v1",
      website: "static-show-v2",
      show_id: showId,
      show_lifecycle: target.show?.lifecycle ?? "missing", reservation_id: target.show?.reservation_id ?? null,
      expected_show_state_version: target.show?.state_version ?? null,
      ...(target.showRevision ? {
        base_show_revision_id: target.showRevision.revision_id,
        base_show_metadata_sha256: target.showRevision.metadata_sha256,
        base_cover_sha256: target.showRevision.cover_sha256,
        base_cover_extension: target.showRevision.cover_extension,
        base_cover_generation: target.showRevision.cover_generation,
      } : {}),
      ...(episodeId !== undefined ? { episode_id: episodeId, episode_lifecycle: target.episode?.lifecycle ?? "missing",
        expected_episode_lifecycle_version: target.episode?.lifecycle_version ?? 0 } : {}),
      ...(target.base ? { base_revision_id: target.base.revision_id, base_metadata_sha256: digest } : {}) });
  }
  async contentSnapshot(showId: string, episodeId?: string): Promise<SqliteContentSnapshot> {
    if (!this.ready()) throw new Error("SQLite runtime is not ready");
    const siteId = episodeId === undefined ? undefined : await this.content.sites.ids.preview(showId, episodeId);
    return this.storage.transactionSync(() => {
      if (!this.ready()) throw new Error("SQLite runtime is not ready");
      const target = this.content.inspect(showId, episodeId);
      const stats = this.content.inventoryStats(showId);
      const showContent = this.content.currentShowRevision(showId, this.config.public_base_url);
      const episodeContent = episodeId === undefined ? undefined : this.content.currentEpisodeRevision(showId, episodeId, this.config.public_base_url);
      return sqliteContentSnapshotSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
        show_id: showId,
        show_lifecycle: target.show?.lifecycle ?? "missing", reservation_id: target.show?.reservation_id ?? null,
        expected_show_state_version: target.show?.state_version ?? null, feed_generation: target.show?.feed_generation ?? null,
        published_episode_count: stats.count, published_inventory_chars: stats.chars, show_content: showContent,
        ...(episodeId !== undefined ? { episode_id: episodeId, episode_lifecycle: target.episode?.lifecycle ?? "missing",
          expected_episode_lifecycle_version: target.episode?.lifecycle_version ?? 0, episode_content: episodeContent, episode_site_id: siteId } : {}),
        snapshot_only: true, authorizes_recovery: false });
    });
  }
  previewInventory(showId: string, feedGeneration: number, after?: string) {
    if (!this.ready()) throw new Error("SQLite runtime is not ready");
    return this.storage.transactionSync(() => {
      const target = this.content.inspect(showId);
      if (target.show?.feed_generation !== feedGeneration) throw new Error("Preview Feed base changed");
      const rows = this.content.episodePage(showId, after);
      return sqlitePreviewInventorySchema.parse({ ...this.queue.identity(), show_id: showId,
        feed_generation: feedGeneration, after: after ?? null, episodes: rows.items, next_cursor: rows.nextCursor,
        site_ids: Object.fromEntries(rows.items.map((episode) => [episode.episode_id, this.content.sites.ids.get(showId, episode.episode_id)])) });
    });
  }
  revisions(showId: string, options: { episodeId?: string; afterSequence?: number } = {}): SqliteRevisionListResponse {
    if (!this.ready()) throw new Error("SQLite runtime is not ready");
    return this.storage.transactionSync(() => {
      const target = this.content.inspect(showId, options.episodeId);
      const currentShow = this.content.currentShowRevision(showId, this.config.public_base_url);
      if (options.episodeId !== undefined) {
        const list = this.content.listEpisodeRevisions(showId, options.episodeId, this.config.public_base_url, options.afterSequence);
        return sqliteRevisionListResponseSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
          kind: "episode", show_id: showId, episode_id: options.episodeId,
          show_lifecycle: target.show?.lifecycle ?? "missing", expected_show_state_version: target.show?.state_version ?? null,
          current_show_revision_id: currentShow?.revision_id ?? null, episode_lifecycle: target.episode?.lifecycle ?? "missing",
          expected_episode_lifecycle_version: target.episode?.lifecycle_version ?? 0, current_episode_revision_id: list.currentRevisionId,
          next_cursor: list.nextCursor, episode_revisions: list.items, snapshot_only: true, authorizes_recovery: false });
      }
      const list = this.content.listShowRevisions(showId, this.config.public_base_url, options.afterSequence);
      return sqliteRevisionListResponseSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
        kind: "show", show_id: showId, show_lifecycle: target.show?.lifecycle ?? "missing",
        expected_show_state_version: target.show?.state_version ?? null, current_show_revision_id: list.currentRevisionId,
        next_cursor: list.nextCursor, show_revisions: list.items, snapshot_only: true, authorizes_recovery: false });
    });
  }
  revisionDetail(showId: string, revisionId: string, episodeId?: string): SqliteRevisionDetailResponse | null {
    if (!this.ready()) throw new Error("SQLite runtime is not ready");
    return this.storage.transactionSync(() => {
      const target = this.content.inspect(showId, episodeId);
      if (!target.show || (target.show.lifecycle !== "published" && target.show.lifecycle !== "unpublished")) {
        throw new Error("Show has no published revision history");
      }
      const currentShow = this.content.currentShowRevision(showId, this.config.public_base_url);
      if (!currentShow) throw new Error("Current Show revision is missing");
      if (episodeId !== undefined) {
        if (!target.episode || (target.episode.lifecycle !== "published" && target.episode.lifecycle !== "unpublished")) {
          throw new Error("Episode has no published revision history");
        }
        const currentEpisode = this.content.currentEpisodeRevision(showId, episodeId, this.config.public_base_url);
        if (!currentEpisode) throw new Error("Current Episode revision is missing");
        const targetEpisodeRevision = this.content.episodeRevision(showId, episodeId, revisionId, this.config.public_base_url);
        if (!targetEpisodeRevision) return null;
        return sqliteRevisionDetailResponseSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
          kind: "episode",
          show_id: showId, episode_id: episodeId, show_lifecycle: target.show.lifecycle,
          expected_show_state_version: target.show.state_version, current_show: currentShow,
          episode_lifecycle: target.episode.lifecycle, expected_episode_lifecycle_version: target.episode.lifecycle_version,
          current_episode: currentEpisode, target_episode_revision: targetEpisodeRevision,
          snapshot_only: true, authorizes_recovery: false });
      }
      const targetShowRevision = this.content.showRevision(showId, revisionId, this.config.public_base_url);
      if (!targetShowRevision) return null;
      return sqliteRevisionDetailResponseSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
        kind: "show",
        show_id: showId, show_lifecycle: target.show.lifecycle, expected_show_state_version: target.show.state_version,
        current_show: currentShow, target_show_revision: targetShowRevision,
        snapshot_only: true, authorizes_recovery: false });
    });
  }
}
