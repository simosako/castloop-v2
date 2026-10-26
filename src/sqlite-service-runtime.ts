import { episodeDraftFromRevision } from "../packages/shared/src/index";
import { sqliteContentSnapshotSchema, sqliteRevisionDetailResponseSchema,
  sqliteRevisionListResponseSchema, sqlitePreviewInventorySchema } from "../packages/shared/src/sqlite-revisions";
import type { SqliteContentSnapshot, SqliteRevisionDetailResponse, SqliteRevisionListResponse } from "../packages/shared/src/sqlite-revisions";
import { sqliteRuntimeRequestSchema, sqliteHealthSchema, sqliteInspectionSchema } from "../packages/shared/src/sqlite-service-api";
import type { SqliteHealth, SqliteInspection, SqliteRuntimeRequest } from "../packages/shared/src/sqlite-service-api";
import { parseSqliteServiceConfig, sqliteServiceConfigHash } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import type { SqlitePublicationBucket } from "./sqlite-publication-executor";
import { publicationChecksum } from "./publication-inputs";
import { readSqliteCatalog } from "./sqlite-catalog";
import type { SqliteCatalogRequest, SqliteCatalogResponse } from "../packages/shared/src/sqlite-catalog";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import { pendingSqliteUpdate, SqliteRuntimeUpdates } from "./sqlite-runtime-update";
import { SqliteDomainRuntime, pendingSqliteDomain } from "./sqlite-domain-runtime";

type SetupRow = { operation_id: string; state: "scheduled" | "running" | "ready" | "blocked"; request_json: string };
type ProbeStage = "target" | "admission" | "config_read" | "config_validate" | "cache_describe" | "cache_validate" | "cache_purge" | "commit";
export type SqliteCacheRuntime = { worker_version_id: string; service_config_sha256: string; cache_enabled: boolean };
export type SqliteCachePurgeConfirmation = (entrypoint: "media" | "site") => void;
export type SqliteRuntimeCache = { describe: () => Promise<SqliteCacheRuntime>;
  purge: (showId: string, confirmed?: SqliteCachePurgeConfirmation) => Promise<void> };

export class SqliteServiceRuntime {
  private probing = false;
  readonly updates: SqliteRuntimeUpdates;
  readonly domains: SqliteDomainRuntime;
  constructor(private readonly storage: PublicationQueueStorage, readonly queue: SqlitePublicationQueue,
    readonly content: SqlitePublicationContent, private readonly bucket: SqlitePublicationBucket,
    private readonly config: SqliteServiceConfig, private readonly cache: SqliteRuntimeCache,
    private readonly actual: SqlitePublicationRuntime = queue.identity(), showId?: string) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_runtime_setup (id INTEGER PRIMARY KEY CHECK(id = 1),
      operation_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('scheduled', 'running', 'ready', 'blocked')), request_json TEXT NOT NULL)`);
    this.updates = new SqliteRuntimeUpdates(storage, queue, actual, () => this.ready());
    this.domains = new SqliteDomainRuntime(storage, queue, content, bucket, config, cache, actual, () => this.ready(), showId);
  }
  private setup(): SetupRow | null {
    return this.storage.sql.exec<SetupRow>("SELECT operation_id, state, request_json FROM publication_runtime_setup WHERE id = 1").toArray()[0] ?? null;
  }
  ready(): boolean { return this.setup()?.state === "ready" && this.queue.identity().worker_version_id === this.actual.worker_version_id && !pendingSqliteUpdate(this.storage) && !pendingSqliteDomain(this.storage); }
  catalog(request: SqliteCatalogRequest): SqliteCatalogResponse {
    if (!this.ready()) throw new Error("SQLite runtime is not ready");
    return readSqliteCatalog(this.storage, request, this.queue.identity(), this.config.public_base_url);
  }
  requireTarget(input: SqliteRuntimeRequest): SqliteRuntimeRequest {
    const request = sqliteRuntimeRequestSchema.parse(input), identity = this.queue.identity();
    if (request.service_id !== identity.service_id || request.worker_version_id !== identity.worker_version_id ||
      request.service_config_sha256 !== identity.service_config_sha256) throw new Error("SQLite runtime request has a stale target");
    return request;
  }
  health(): SqliteHealth {
    const snapshot = this.queue.snapshot(), setup = this.setup();
    return sqliteHealthSchema.parse({ ...this.actual, protocol: "sqlite-sequential-v1", invocation_id: crypto.randomUUID(),
      feed_storage: "immutable-generation-v1",
      cover_storage: "immutable-generation-v1",
      publication_read_boundary: "show-episode-v1",
      feed_generation_allocator: "reservation-v1",
      domain_changes: "sqlite-domain-change-v1",
      availability_controls: "show-admission-delivery-v1", availability_version: snapshot.availability_version,
      revision_history: "sqlite-revisions-v1",
      website: "static-show-v2",
      delivery_statistics: "episode-daily-v1",
      admission_state: snapshot.state === "open" ? "open" : "closed", delivery_policy: snapshot.state === "paused" ? "stopped" : "enabled",
      publication_ready: this.ready(), state: snapshot.state, admission_window_id: snapshot.admission_window_id,
      queued: snapshot.queued, active: snapshot.active?.state ?? null, drained: snapshot.drained,
      setup: setup ? { operation_id: setup.operation_id, state: setup.state } : null, runtime_update: this.updates.summary() });
  }
  async prepare(input: SqliteRuntimeRequest): Promise<SqliteHealth> {
    const request = this.requireTarget(input), source = JSON.stringify(request);
    await this.storage.transaction(async () => {
      const existing = this.setup();
      if (existing) {
        if (existing.request_json !== source) throw new Error("Keep the retained SQLite runtime setup");
        return;
      }
      const snapshot = this.queue.snapshot();
      if (snapshot.state !== "paused" || !snapshot.drained) throw new Error("Runtime preparation requires a drained paused service");
      this.storage.sql.exec("INSERT INTO publication_runtime_setup (id, operation_id, state, request_json) VALUES (1, ?, 'scheduled', ?)", request.operation_id, source);
      await this.storage.setAlarm(Date.now());
    });
    return this.health();
  }
  async alarm(): Promise<boolean> {
    const setup = this.setup();
    if (setup?.state === "ready") return pendingSqliteUpdate(this.storage) || pendingSqliteDomain(this.storage);
    if (!setup || this.probing) return true;
    if (setup.state === "blocked") return true;
    if (setup.state === "running") {
      this.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'blocked' WHERE id = 1");
      await this.storage.sync();
      console.error(JSON.stringify({ event: "sqlite_runtime_setup", operation_id: setup.operation_id, reason_code: "execution_interrupted" }));
      return true;
    }
    this.probing = true;
    try {
      this.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'running' WHERE id = 1");
      await this.storage.sync();
      let stage: ProbeStage = "target";
      try {
        this.requireTarget(JSON.parse(setup.request_json));
        stage = "admission";
        const snapshot = this.queue.snapshot();
        if (snapshot.state !== "paused" || !snapshot.drained) throw new Error("Runtime probe admission changed");
        stage = "config_read";
        const object = await this.bucket.get("system/service.toml");
        if (!object?.body || object.size < 1 || object.size > 16384) {
          await object?.body?.cancel(); throw new Error("Runtime config binding probe failed");
        }
        const reader = object.body.getReader(), chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length;
            if (length > 16384) throw new Error("Runtime config probe exceeds its limit"); chunks.push(chunk.value); }
        } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        stage = "config_validate";
        if (length !== object.size || await sqliteServiceConfigHash(parseSqliteServiceConfig(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))) !==
          await sqliteServiceConfigHash(this.config)) throw new Error("Runtime bucket config differs");
        stage = "cache_describe";
        const cached = await this.cache.describe(), identity = this.queue.identity();
        stage = "cache_validate";
        if (cached.worker_version_id !== identity.worker_version_id || cached.service_config_sha256 !== identity.service_config_sha256 || !cached.cache_enabled) {
          throw new Error("Runtime cache owner differs");
        }
        stage = "cache_purge";
        await this.cache.purge(`probe-${setup.operation_id.slice(0, 8).toLowerCase()}`);
        stage = "commit";
        this.storage.transactionSync(() => {
          this.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'ready' WHERE id = 1");
          this.storage.sql.exec("UPDATE publication_domain_changes SET state = 'completed' WHERE operation_id = ? AND state = 'feed_ready'", setup.operation_id);
          this.storage.sql.exec(`UPDATE publication_runtime_updates SET state = 'completed' WHERE operation_id = ? AND state = 'activated'
            AND json_extract(activation_json, '$.new_worker_version_id') = ?`, setup.operation_id, identity.worker_version_id);
        });
        await this.storage.sync();
      } catch {
        this.storage.sql.exec("UPDATE publication_domain_changes SET state = 'blocked', reason_code = 'domain_effect_unverified' WHERE operation_id = ? AND state = 'feed_ready'", setup.operation_id);
        this.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'blocked' WHERE id = 1");
        await this.storage.sync();
        console.error(JSON.stringify({ event: "sqlite_runtime_setup", ...this.actual, operation_id: setup.operation_id,
          reason_code: "runtime_probe_failed", probe_stage: stage }));
      }
      return true;
    } finally { this.probing = false; }
  }
  async inspect(showId: string, episodeId?: string): Promise<SqliteInspection> {
    if (!this.ready()) throw new Error("SQLite runtime is not ready");
    const snapshot = this.queue.snapshot(), target = this.content.inspect(showId, episodeId);
    const digest = target.base ? await publicationChecksum(new TextEncoder().encode(JSON.stringify(episodeDraftFromRevision(target.base)))) : undefined;
    return sqliteInspectionSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
      revision_history: "sqlite-revisions-v1",
      website: "static-show-v2",
      state: snapshot.state, admission_window_id: snapshot.admission_window_id, show_id: showId,
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
      const snapshot = this.queue.snapshot(), target = this.content.inspect(showId, episodeId);
      const stats = this.content.inventoryStats(showId);
      const showContent = this.content.currentShowRevision(showId, this.config.public_base_url);
      const episodeContent = episodeId === undefined ? undefined : this.content.currentEpisodeRevision(showId, episodeId, this.config.public_base_url);
      return sqliteContentSnapshotSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
        state: snapshot.state, admission_window_id: snapshot.admission_window_id, show_id: showId,
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
      const snapshot = this.queue.snapshot(), target = this.content.inspect(showId, options.episodeId);
      const currentShow = this.content.currentShowRevision(showId, this.config.public_base_url);
      if (options.episodeId !== undefined) {
        const list = this.content.listEpisodeRevisions(showId, options.episodeId, this.config.public_base_url, options.afterSequence);
        return sqliteRevisionListResponseSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
          state: snapshot.state, kind: "episode", show_id: showId, episode_id: options.episodeId,
          show_lifecycle: target.show?.lifecycle ?? "missing", expected_show_state_version: target.show?.state_version ?? null,
          current_show_revision_id: currentShow?.revision_id ?? null, episode_lifecycle: target.episode?.lifecycle ?? "missing",
          expected_episode_lifecycle_version: target.episode?.lifecycle_version ?? 0, current_episode_revision_id: list.currentRevisionId,
          next_cursor: list.nextCursor, episode_revisions: list.items, snapshot_only: true, authorizes_recovery: false });
      }
      const list = this.content.listShowRevisions(showId, this.config.public_base_url, options.afterSequence);
      return sqliteRevisionListResponseSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
        state: snapshot.state, kind: "show", show_id: showId, show_lifecycle: target.show?.lifecycle ?? "missing",
        expected_show_state_version: target.show?.state_version ?? null, current_show_revision_id: list.currentRevisionId,
        next_cursor: list.nextCursor, show_revisions: list.items, snapshot_only: true, authorizes_recovery: false });
    });
  }
  revisionDetail(showId: string, revisionId: string, episodeId?: string): SqliteRevisionDetailResponse | null {
    if (!this.ready()) throw new Error("SQLite runtime is not ready");
    return this.storage.transactionSync(() => {
      const snapshot = this.queue.snapshot(), target = this.content.inspect(showId, episodeId);
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
          state: snapshot.state, admission_window_id: snapshot.admission_window_id, kind: "episode",
          show_id: showId, episode_id: episodeId, show_lifecycle: target.show.lifecycle,
          expected_show_state_version: target.show.state_version, current_show: currentShow,
          episode_lifecycle: target.episode.lifecycle, expected_episode_lifecycle_version: target.episode.lifecycle_version,
          current_episode: currentEpisode, target_episode_revision: targetEpisodeRevision,
          snapshot_only: true, authorizes_recovery: false });
      }
      const targetShowRevision = this.content.showRevision(showId, revisionId, this.config.public_base_url);
      if (!targetShowRevision) return null;
      return sqliteRevisionDetailResponseSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
        state: snapshot.state, admission_window_id: snapshot.admission_window_id, kind: "show",
        show_id: showId, show_lifecycle: target.show.lifecycle, expected_show_state_version: target.show.state_version,
        current_show: currentShow, target_show_revision: targetShowRevision,
        snapshot_only: true, authorizes_recovery: false });
    });
  }
}
