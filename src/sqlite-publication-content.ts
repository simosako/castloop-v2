import { episodeRevisionSchema, parsePublicAssetPath, showMetadataSchema } from "../packages/shared/src/index";
import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import { parseSqlitePublicationRequest, sqlitePublicationRequestSchema } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationRequest } from "../packages/shared/src/sqlite-publication";
import { SqlitePublicationInputError } from "./sqlite-publication-alarm";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";

type Lifecycle = "draft" | "published" | "unpublished" | "deleted";
type ShowRow = { show_id: string; reservation_id: string; state_version: number; feed_generation: number; lifecycle: Lifecycle };
type EpisodeRow = { show_id: string; episode_id: string; lifecycle: Lifecycle; lifecycle_version: number; revision_id: string | null };
export type SqliteContentTarget = { show: ShowRow; metadata: ShowMetadata | null; coverExtension: "jpg" | "png" | null;
  episode: EpisodeRow | null; base: EpisodeRevision | null };
export type SqliteDeliveryDecision = { status: 200; key: string; content_type: string;
  cache_props: { showGeneration: number; feedGeneration?: number; episodeGeneration?: number } } | { status: 404 | 410 | 503 };

export class SqlitePublicationContent {
  constructor(private readonly storage: PublicationQueueStorage) {
    storage.transactionSync(() => {
      const queue = storage.sql.exec<{ version: number }>("SELECT version FROM publication_queue_schema WHERE id = 1").toArray()[0];
      if (queue?.version !== 2) throw new Error("Initialize the matching publication queue before its content index");
      storage.sql.exec("CREATE TABLE IF NOT EXISTS publication_content_schema (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)");
      const schema = storage.sql.exec<{ version: number }>("SELECT version FROM publication_content_schema WHERE id = 1").toArray()[0];
      if (schema && schema.version !== 3) throw new Error("Unsupported publication content schema; do not reset stored content");
      storage.sql.exec("INSERT OR IGNORE INTO publication_content_schema (id, version) VALUES (1, 3)");
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_shows (show_id TEXT PRIMARY KEY, reservation_id TEXT UNIQUE NOT NULL,
        state_version INTEGER NOT NULL, feed_generation INTEGER NOT NULL, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft', 'published', 'unpublished', 'deleted')))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_show_content (show_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL,
        cover_extension TEXT NOT NULL CHECK(cover_extension IN ('jpg', 'png')))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_episodes (show_id TEXT NOT NULL, episode_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('published', 'unpublished', 'deleted')), lifecycle_version INTEGER NOT NULL DEFAULT 0, revision_id TEXT,
        PRIMARY KEY(show_id, episode_id))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_episode_content (show_id TEXT NOT NULL, episode_id TEXT NOT NULL,
        guid TEXT NOT NULL, revision_json TEXT NOT NULL, PRIMARY KEY(show_id, episode_id), UNIQUE(show_id, guid))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_media (show_id TEXT NOT NULL, episode_id TEXT NOT NULL,
        audio_revision_id TEXT NOT NULL, sha256 TEXT NOT NULL, length_bytes INTEGER NOT NULL,
        PRIMARY KEY(show_id, episode_id, audio_revision_id))`);
    });
  }

  registerShow(showId: string, reservationId: string): ShowRow {
    sqlitePublicationRequestSchema.shape.show_id.parse(showId);
    sqlitePublicationRequestSchema.shape.job_id.parse(reservationId);
    return this.storage.transactionSync(() => {
      const existing = this.show(showId);
      if (existing) {
        if (existing.reservation_id !== reservationId) throw new Error("Show ID already has a permanent reservation");
        return existing;
      }
      const service = this.storage.sql.exec<{ state: string }>("SELECT state FROM publication_service WHERE id = 1").toArray()[0];
      const pending = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publication_jobs WHERE state IN ('queued', 'running', 'blocked')").toArray()[0]!.count;
      if (service?.state !== "open" || pending) throw new Error("Show registration requires open, drained publication admission");
      this.storage.sql.exec("INSERT INTO publication_shows (show_id, reservation_id, state_version, feed_generation, lifecycle) VALUES (?, ?, 0, 0, 'draft')", showId, reservationId);
      return this.show(showId)!;
    });
  }

  private show(showId: string): ShowRow | null {
    return this.storage.sql.exec<ShowRow>("SELECT * FROM publication_shows WHERE show_id = ?", showId).toArray()[0] ?? null;
  }

  inspect(showId: string, episodeId?: string): { show: ShowRow | null; episode: EpisodeRow | null; base: EpisodeRevision | null } {
    sqlitePublicationRequestSchema.shape.show_id.parse(showId);
    if (episodeId !== undefined) sqlitePublicationRequestSchema.shape.episode_id.unwrap().parse(episodeId);
    return this.storage.transactionSync(() => {
      const show = this.show(showId);
      const episode = episodeId === undefined ? null : this.storage.sql.exec<EpisodeRow>(
        "SELECT * FROM publication_episodes WHERE show_id = ? AND episode_id = ?", showId, episodeId).toArray()[0] ?? null;
      const hasContent = episode && ["published", "unpublished"].includes(episode.lifecycle);
      const saved = hasContent ? this.storage.sql.exec<{ revision_json: string }>(
        "SELECT revision_json FROM publication_episode_content WHERE show_id = ? AND episode_id = ?", showId, episodeId!).toArray()[0] : null;
      const base = saved ? episodeRevisionSchema.parse(JSON.parse(saved.revision_json)) : null;
      if (hasContent && (!base || base.revision_id !== episode.revision_id || base.episode_id !== episodeId)) {
        throw new Error("Episode inspection has inconsistent content");
      }
      return { show, episode, base };
    });
  }

  requireRunning(input: SqlitePublicationRequest): SqlitePublicationRequest {
    const request = parseSqlitePublicationRequest(input);
    const row = this.storage.sql.exec<{ request_json: string; state: string }>(
      "SELECT request_json, state FROM publication_jobs WHERE job_id = ? AND request_id = ?", request.job_id, request.request_id).toArray()[0];
    if (!row || row.state !== "running" || row.request_json !== JSON.stringify(request)) throw new Error("Content mutation requires its exact running publication");
    return request;
  }

  target(input: SqlitePublicationRequest): SqliteContentTarget {
    const request = this.requireRunning(input), show = this.show(request.show_id);
    const showStates = request.action === "publish" ? ["draft", "published"] : request.kind === "episode" && request.action === "unpublish" ? ["published", "unpublished"] :
      [request.action === "restore" && request.kind === "show" ? "unpublished" : "published"];
    if (!show || !showStates.includes(show.lifecycle) || request.kind === "episode" && request.action !== "unpublish" && show.lifecycle !== "published") {
      throw new SqlitePublicationInputError("target_unavailable");
    }
    if (show.state_version !== request.expected_show_state_version) throw new SqlitePublicationInputError("base_conflict");
    if (request.kind === "show" && show.state_version === Number.MAX_SAFE_INTEGER) throw new SqlitePublicationInputError("target_unavailable");
    const content = this.storage.sql.exec<{ metadata_json: string; cover_extension: "jpg" | "png" }>(
      "SELECT metadata_json, cover_extension FROM publication_show_content WHERE show_id = ?", request.show_id).toArray()[0];
    const metadata = content ? showMetadataSchema.parse(JSON.parse(content.metadata_json)) : null;
    if (["published", "unpublished"].includes(show.lifecycle) && (!metadata || metadata.show_id !== show.show_id)) throw new Error("Published Show content index is inconsistent");
    const episode = request.kind === "episode" ? this.storage.sql.exec<EpisodeRow>(
      "SELECT * FROM publication_episodes WHERE show_id = ? AND episode_id = ?", request.show_id, request.episode_id!).toArray()[0] ?? null : null;
    if (request.kind === "episode" && (request.action !== "publish" && !episode || episode && episode.lifecycle !== (request.action === "restore" ? "unpublished" : "published"))) {
      throw new SqlitePublicationInputError("target_unavailable");
    }
    if (request.kind === "episode" && (episode?.lifecycle_version ?? 0) !== (request.expected_episode_lifecycle_version ?? 0)) throw new SqlitePublicationInputError("base_conflict");
    if (request.kind === "episode" && request.action !== "publish" && episode?.lifecycle_version === Number.MAX_SAFE_INTEGER) throw new SqlitePublicationInputError("target_unavailable");
    if (request.kind === "episode" && (episode?.revision_id ?? undefined) !== request.base_revision_id) throw new SqlitePublicationInputError("base_conflict");
    const saved = episode ? this.storage.sql.exec<{ revision_json: string }>(
      "SELECT revision_json FROM publication_episode_content WHERE show_id = ? AND episode_id = ?", request.show_id, request.episode_id!).toArray()[0] : null;
    const base = saved ? episodeRevisionSchema.parse(JSON.parse(saved.revision_json)) : null;
    if (episode && (!base || base.episode_id !== episode.episode_id || base.revision_id !== episode.revision_id)) throw new Error("Published Episode content index is inconsistent");
    return { show, metadata, coverExtension: content?.cover_extension ?? null, episode, base };
  }

  episodes(showId: string): EpisodeRevision[] {
    const limits = this.storage.sql.exec<{ count: number; bytes: number | null }>(`SELECT COUNT(*) AS count, SUM(length(c.revision_json)) AS bytes
      FROM publication_episode_content c JOIN publication_episodes e USING (show_id, episode_id)
      WHERE e.show_id = ? AND e.lifecycle = 'published'`, showId).toArray()[0]!;
    if (limits.count > 10000 || (limits.bytes ?? 0) * 4 > 8_000_000) throw new Error("Publication feed index exceeds its rendering budget");
    return this.storage.sql.exec<{ revision_json: string }>(`SELECT c.revision_json FROM publication_episode_content c
      JOIN publication_episodes e USING (show_id, episode_id) WHERE e.show_id = ? AND e.lifecycle = 'published' ORDER BY e.episode_id`, showId)
      .toArray().map((row) => episodeRevisionSchema.parse(JSON.parse(row.revision_json)));
  }

  requireUniqueGuid(showId: string, revision: EpisodeRevision): void {
    if (this.storage.sql.exec<{ episode_id: string }>(
      "SELECT episode_id FROM publication_episode_content WHERE show_id = ? AND guid = ? AND episode_id != ?",
      showId, revision.guid, revision.episode_id).toArray().length) throw new SqlitePublicationInputError("validation_failed");
  }

  requireMedia(showId: string, revision: EpisodeRevision, audioRevisionId: string): void {
    const audio = this.storage.sql.exec<{ sha256: string; length_bytes: number }>(`SELECT sha256, length_bytes FROM publication_media
      WHERE show_id = ? AND episode_id = ? AND audio_revision_id = ?`, showId, revision.episode_id, audioRevisionId).toArray()[0];
    if (!audio || audio.sha256 !== revision.sha256 || audio.length_bytes !== revision.length_bytes) throw new Error("Episode has no matching immutable media index");
  }

  commitShow(request: SqlitePublicationRequest, metadata: ShowMetadata, extension: "jpg" | "png"): void {
    this.target(request);
    if (request.action !== "publish" || request.kind !== "show" || metadata.show_id !== request.show_id) throw new Error("Show commit differs from its running target");
    this.storage.sql.exec(`INSERT INTO publication_show_content (show_id, metadata_json, cover_extension) VALUES (?, ?, ?)
      ON CONFLICT(show_id) DO UPDATE SET metadata_json = excluded.metadata_json, cover_extension = excluded.cover_extension`,
    request.show_id, JSON.stringify(showMetadataSchema.parse(metadata)), extension);
    this.storage.sql.exec("UPDATE publication_shows SET lifecycle = 'published', state_version = state_version + 1 WHERE show_id = ?", request.show_id);
    this.advanceFeed(request);
  }

  commitEpisode(request: SqlitePublicationRequest, revision: EpisodeRevision, audioRevisionId: string, newAudio: boolean): void {
    this.target(request);
    if (request.action !== "publish" || request.kind !== "episode" || revision.episode_id !== request.episode_id || revision.revision_id !== request.job_id) {
      throw new Error("Episode commit differs from its running target");
    }
    this.requireUniqueGuid(request.show_id, revision);
    if (newAudio) this.storage.sql.exec(`INSERT INTO publication_media (show_id, episode_id, audio_revision_id, sha256, length_bytes)
      VALUES (?, ?, ?, ?, ?)`, request.show_id, revision.episode_id, audioRevisionId, revision.sha256, revision.length_bytes);
    this.requireMedia(request.show_id, revision, audioRevisionId);
    this.storage.sql.exec(`INSERT INTO publication_episodes (show_id, episode_id, lifecycle, revision_id) VALUES (?, ?, 'published', ?)
      ON CONFLICT(show_id, episode_id) DO UPDATE SET lifecycle = 'published', revision_id = excluded.revision_id`, request.show_id, revision.episode_id, revision.revision_id);
    this.storage.sql.exec(`INSERT INTO publication_episode_content (show_id, episode_id, guid, revision_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(show_id, episode_id) DO UPDATE SET guid = excluded.guid, revision_json = excluded.revision_json`,
    request.show_id, revision.episode_id, revision.guid, JSON.stringify(episodeRevisionSchema.parse(revision)));
    this.advanceFeed(request);
  }

  private advanceFeed(request: SqlitePublicationRequest): void {
    this.storage.sql.exec(`UPDATE publication_shows SET feed_generation =
      (SELECT sequence FROM publication_jobs WHERE job_id = ? AND state = 'running') WHERE show_id = ?`, request.job_id, request.show_id);
  }

  commitLifecycle(request: SqlitePublicationRequest): void {
    this.target(request);
    if (request.action === "publish") throw new Error("A lifecycle commit cannot publish new content");
    const lifecycle = request.action === "restore" ? "published" : "unpublished";
    if (request.kind === "show") this.storage.sql.exec("UPDATE publication_shows SET lifecycle = ?, state_version = state_version + 1 WHERE show_id = ?", lifecycle, request.show_id);
    else this.storage.sql.exec("UPDATE publication_episodes SET lifecycle = ?, lifecycle_version = lifecycle_version + 1 WHERE show_id = ? AND episode_id = ?", lifecycle, request.show_id, request.episode_id!);
    this.advanceFeed(request);
  }

  delivery(path: string): SqliteDeliveryDecision {
    const asset = parsePublicAssetPath(path);
    if (!asset) return { status: 404 };
    return this.storage.transactionSync(() => {
      const service = this.storage.sql.exec<{ state: string }>("SELECT state FROM publication_service WHERE id = 1").toArray()[0];
      if (service?.state !== "open") return { status: 503 };
      const show = this.show(asset.showId);
      if (!show || show.lifecycle === "draft" || show.lifecycle === "unpublished") return { status: 404 };
      if (show.lifecycle === "deleted") return { status: 410 };
      const active = this.storage.sql.exec<{ show_id: string }>("SELECT show_id FROM publication_jobs WHERE state IN ('running', 'blocked')").toArray()[0];
      if (active?.show_id === asset.showId) return { status: 503 };
      if (asset.kind === "cover") {
        const cover = this.storage.sql.exec<{ cover_extension: string }>("SELECT cover_extension FROM publication_show_content WHERE show_id = ?", asset.showId).toArray()[0];
        if (!cover || !asset.key.endsWith(`cover.${cover.cover_extension}`)) return { status: 404 };
      }
      let episodeGeneration = 0;
      if (asset.kind === "audio") {
        const episode = this.storage.sql.exec<EpisodeRow>("SELECT * FROM publication_episodes WHERE show_id = ? AND episode_id = ?", asset.showId, asset.episodeId).toArray()[0];
        if (!episode || episode.lifecycle === "unpublished") return { status: 404 };
        if (episode.lifecycle === "deleted") return { status: 410 };
        episodeGeneration = episode.lifecycle_version;
        if (!this.storage.sql.exec<{ audio_revision_id: string }>(`SELECT audio_revision_id FROM publication_media
          WHERE show_id = ? AND episode_id = ? AND audio_revision_id = ?`, asset.showId, asset.episodeId, asset.revisionId).toArray().length) return { status: 404 };
      }
      const cache_props = asset.kind === "feed" ? { showGeneration: show.state_version, feedGeneration: show.feed_generation } :
        asset.kind === "audio" ? { showGeneration: show.state_version, episodeGeneration } : { showGeneration: show.state_version };
      return { status: 200, key: asset.key, content_type: asset.contentType, cache_props };
    });
  }
}
