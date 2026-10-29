import { z } from "zod";
import { episodeDraftFromRevision, episodeRevisionSchema, parsePublicAssetPath, showMetadataSchema } from "../packages/shared/src/index";
import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import {
  SQLITE_REVISION_PAGE_SIZE, sqliteEpisodeRevisionRecordSchema, sqliteEpisodeRevisionSummarySchema,
  sqliteShowRevisionRecordSchema, sqliteShowRevisionSummarySchema } from "../packages/shared/src/sqlite-revisions";
import type { SqliteEpisodeRevisionRecord, SqliteEpisodeRevisionSummary,
  SqliteShowRevisionRecord, SqliteShowRevisionSummary } from "../packages/shared/src/sqlite-revisions";
import { sqlitePublicationTargetSchema as targetSchema } from "../packages/shared/src/sqlite-publication";
import type { SqliteContentMutation } from "../packages/shared/src/sqlite-direct-publication";
import { sqliteMediaKey } from "../packages/shared/src/sqlite-media";
import { assertPublicationInventoryBudget } from "../packages/shared/src/publication-budget";
import { SITE_PAGE_SIZE } from "../packages/shared/src/website";
import type { SitePage } from "../packages/shared/src/website";
import {
  SQLITE_CONTENT_SCHEMA_VERSION, SQLITE_QUEUE_SCHEMA_VERSION, SqlitePublicationInputError } from "./sqlite-publication-queue";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import { validSqliteCoverIdentity } from "./sqlite-cover";
import type { SqliteCoverIdentity } from "./sqlite-cover";
import { canonicalEnclosureUrl } from "./media-url";
import { SqliteSiteIds } from "./sqlite-site-ids";
import { renderPublicationFeed } from "./publication-inputs";
import { renderSiteEpisode, renderSiteListingPage, siteDateFormatter } from "./site-renderer";
import type { SiteRenderInput } from "./site-renderer";
import type { PublicCacheProps } from "./public-assets";
import type { SiteCacheProps, SitePageRenderResult } from "./site-cache";
import type { SiteDeliveryDecision } from "./site-gateway";

type Lifecycle = "draft" | "published" | "unpublished" | "deleted";
type ShowRow = { show_id: string; reservation_id: string; state_version: number; feed_generation: number; lifecycle: Lifecycle };
type EpisodeRow = { show_id: string; episode_id: string; lifecycle: Lifecycle; lifecycle_version: number; revision_id: string | null };
type ShowRevisionRow = { show_id: string; revision_sequence: number; state_version: number; revision_id: string;
  metadata_json: string; metadata_sha256: string; cover_extension: "jpg" | "png"; cover_generation: number;
  cover_sha256: string; cover_length_bytes: number; restored_from_revision_id: string | null; updated_at: string };
type EpisodeRevisionRow = { show_id: string; episode_id: string; revision_sequence: number; revision_id: string;
  audio_revision_id: string; metadata_sha256: string; revision_json: string; restored_from_revision_id: string | null; updated_at: string };
export type SqliteContentTarget = { show: ShowRow; metadata: ShowMetadata | null; coverExtension: "jpg" | "png" | null;
  cover: SqliteCoverIdentity | null; episode: EpisodeRow | null; base: EpisodeRevision | null };
export type SqliteDeliveryDecision = { status: 200; key: string; content_type: string; cache_props: PublicCacheProps } | { status: 404 | 410 | 503 };

export class SqlitePublicationContent {
  readonly siteIds: SqliteSiteIds;
  readonly sites: { readonly ids: SqliteSiteIds };
  constructor(private readonly storage: PublicationQueueStorage) {
    storage.transactionSync(() => {
      const queue = storage.sql.exec<{ version: number }>("SELECT version FROM publication_queue_schema WHERE id = 1").toArray()[0];
      if (queue?.version !== SQLITE_QUEUE_SCHEMA_VERSION) throw new Error("Initialize the matching publication queue before its content index");
      storage.sql.exec("CREATE TABLE IF NOT EXISTS publication_content_schema (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)");
      const schema = storage.sql.exec<{ version: number }>("SELECT version FROM publication_content_schema WHERE id = 1").toArray()[0];
      if (schema && schema.version !== SQLITE_CONTENT_SCHEMA_VERSION) throw new Error("Unsupported publication content schema; do not reset stored content");
      storage.sql.exec("INSERT OR IGNORE INTO publication_content_schema (id, version) VALUES (1, ?)", SQLITE_CONTENT_SCHEMA_VERSION);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_shows (show_id TEXT PRIMARY KEY, reservation_id TEXT UNIQUE NOT NULL,
        state_version INTEGER NOT NULL, feed_generation INTEGER NOT NULL, lifecycle TEXT NOT NULL CHECK(lifecycle IN ('draft', 'published', 'unpublished', 'deleted')))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_show_content (show_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL,
        cover_extension TEXT NOT NULL CHECK(cover_extension IN ('jpg', 'png')),
        cover_generation INTEGER NOT NULL CHECK(cover_generation > 0), cover_sha256 TEXT NOT NULL,
        cover_length_bytes INTEGER NOT NULL CHECK(cover_length_bytes > 0 AND cover_length_bytes <= 5000000))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_episodes (show_id TEXT NOT NULL, episode_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('published', 'unpublished', 'deleted')), lifecycle_version INTEGER NOT NULL DEFAULT 0, revision_id TEXT,
        PRIMARY KEY(show_id, episode_id))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_episode_content (show_id TEXT NOT NULL, episode_id TEXT NOT NULL,
        guid TEXT NOT NULL, revision_json TEXT NOT NULL, PRIMARY KEY(show_id, episode_id), UNIQUE(show_id, guid))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_media (show_id TEXT NOT NULL, episode_id TEXT NOT NULL,
        audio_revision_id TEXT NOT NULL, sha256 TEXT NOT NULL, length_bytes INTEGER NOT NULL,
        PRIMARY KEY(show_id, episode_id, audio_revision_id))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_show_revisions (
        show_id TEXT NOT NULL, revision_sequence INTEGER NOT NULL CHECK(revision_sequence > 0),
        state_version INTEGER NOT NULL CHECK(state_version > 0), revision_id TEXT NOT NULL UNIQUE,
        metadata_json TEXT NOT NULL, metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256) = 64),
        cover_extension TEXT NOT NULL CHECK(cover_extension IN ('jpg', 'png')),
        cover_generation INTEGER NOT NULL CHECK(cover_generation > 0), cover_sha256 TEXT NOT NULL CHECK(length(cover_sha256) = 64),
        cover_length_bytes INTEGER NOT NULL CHECK(cover_length_bytes > 0 AND cover_length_bytes <= 5000000),
        restored_from_revision_id TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(show_id, revision_sequence), UNIQUE(show_id, revision_id))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_episode_revisions (
        show_id TEXT NOT NULL, episode_id TEXT NOT NULL, revision_sequence INTEGER NOT NULL CHECK(revision_sequence > 0),
        revision_id TEXT NOT NULL UNIQUE, audio_revision_id TEXT NOT NULL,
        metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256) = 64), revision_json TEXT NOT NULL,
        restored_from_revision_id TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(show_id, episode_id, revision_sequence), UNIQUE(show_id, episode_id, revision_id))`);
    });
    this.siteIds = new SqliteSiteIds(storage);
    this.sites = { ids: this.siteIds };
  }

  registerShow(showId: string, reservationId: string): ShowRow {
    targetSchema.shape.show_id.parse(showId);
    z.uuid().parse(reservationId);
    return this.storage.transactionSync(() => {
      const existing = this.show(showId);
      if (existing) {
        if (existing.reservation_id !== reservationId) throw new Error("Show ID already has a permanent reservation");
        return existing;
      }
      this.storage.sql.exec("INSERT INTO publication_shows (show_id, reservation_id, state_version, feed_generation, lifecycle) VALUES (?, ?, 0, 0, 'draft')", showId, reservationId);
      return this.show(showId)!;
    });
  }

  private show(showId: string): ShowRow | null {
    return this.storage.sql.exec<ShowRow>("SELECT * FROM publication_shows WHERE show_id = ?", showId).toArray()[0] ?? null;
  }

  siteDelivery(page: SitePage): SiteDeliveryDecision {
    return this.storage.transactionSync(() => {
      const decision = this.delivery(`/podcasts/${page.showId}/feed.xml`);
      if (decision.status !== 200) return { status: decision.status };
      const content = this.storage.sql.exec<{ metadata_json: string }>(
        "SELECT metadata_json FROM publication_show_content WHERE show_id = ?", page.showId).toArray()[0];
      if (!content) return { status: 503 };
      const metadata = showMetadataSchema.parse(JSON.parse(content.metadata_json));
      if (metadata.site_mode !== "builtin") return { status: 404 };
      if (page.kind === "listing") {
        const count = this.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM publication_episodes WHERE show_id = ? AND lifecycle = 'published'", page.showId).toArray()[0]!.count;
        const pages = Math.max(1, Math.ceil(count / SITE_PAGE_SIZE));
        if (page.page > pages) return { status: 404 };
        return { status: 200, props: { generation: decision.cache_props.feedGeneration!, showGeneration: decision.cache_props.showGeneration } };
      }
      const episodeId = this.siteIds.episode(page.showId, page.siteId);
      if (!episodeId) return { status: 404 };
      const episode = this.storage.sql.exec<EpisodeRow>("SELECT * FROM publication_episodes WHERE show_id = ? AND episode_id = ?",
        page.showId, episodeId).toArray()[0];
      if (!episode || episode.lifecycle === "unpublished") return { status: 404 };
      if (episode.lifecycle === "deleted") return { status: 410 };
      return { status: 200, props: { generation: decision.cache_props.feedGeneration!, showGeneration: decision.cache_props.showGeneration,
        episodeGeneration: episode.lifecycle_version } };
    });
  }

  renderFeed(showId: string, baseUrl: string, props?: PublicCacheProps): { xml: string } | null {
    targetSchema.shape.show_id.parse(showId);
    return this.storage.transactionSync(() => {
      const show = this.show(showId);
      if (!show || show.lifecycle !== "published" || show.feed_generation < 1 || !this.cover(showId)) return null;
      if (props && (show.state_version !== props.showGeneration || show.feed_generation !== props.feedGeneration)) return null;
      const content = this.storage.sql.exec<{ metadata_json: string; cover_extension: "jpg" | "png" }>(
        "SELECT metadata_json, cover_extension FROM publication_show_content WHERE show_id = ?", showId).toArray()[0];
      if (!content) return null;
      const metadata = showMetadataSchema.parse(JSON.parse(content.metadata_json));
      const episodes = this.episodes(showId).map((episode) => ({
        ...episode,
        enclosure_url: canonicalEnclosureUrl(episode, showId, baseUrl),
      }));
      const siteIds = this.siteIds.all(showId);
      const xml = renderPublicationFeed(metadata, episodes, baseUrl, content.cover_extension, siteIds);
      return { xml };
    });
  }

  renderSitePage(page: SitePage, baseUrl: string, props?: SiteCacheProps): SitePageRenderResult | null {
    return this.storage.transactionSync(() => {
      const decision = this.siteDelivery(page);
      if (decision.status !== 200) return null;
      if (props && (decision.props.generation !== props.generation ||
        decision.props.showGeneration !== props.showGeneration ||
        decision.props.episodeGeneration !== props.episodeGeneration)) return null;
      const content = this.storage.sql.exec<{ metadata_json: string; cover_extension: "jpg" | "png" }>(
        "SELECT metadata_json, cover_extension FROM publication_show_content WHERE show_id = ?", page.showId).toArray()[0];
      if (!content) return null;
      const metadata = showMetadataSchema.parse(JSON.parse(content.metadata_json));
      if (metadata.site_mode !== "builtin") return null;
      const rows = page.kind === "listing" ? this.storage.sql.exec<{ revision_json: string; episode_id: string; site_id: string }>(`
        SELECT c.revision_json, c.episode_id, s.site_id FROM publication_episode_content c
        JOIN publication_episodes e USING (show_id, episode_id)
        JOIN publication_site_ids s USING (show_id, episode_id)
        WHERE e.show_id = ? AND e.lifecycle = 'published'
        ORDER BY unixepoch(substr(json_extract(c.revision_json, '$.published_at'), 1, 19)) -
          CASE substr(json_extract(c.revision_json, '$.published_at'), 20, 1)
            WHEN '+' THEN 1 WHEN '-' THEN -1 ELSE 0 END *
          (CAST(substr(json_extract(c.revision_json, '$.published_at'), 21, 2) AS INTEGER) * 3600 +
           CAST(substr(json_extract(c.revision_json, '$.published_at'), 24, 2) AS INTEGER) * 60) DESC,
          c.episode_id
        LIMIT ? OFFSET ?`, page.showId, SITE_PAGE_SIZE, (page.page - 1) * SITE_PAGE_SIZE).toArray() :
        this.storage.sql.exec<{ revision_json: string; episode_id: string; site_id: string }>(`
          SELECT c.revision_json, c.episode_id, s.site_id FROM publication_episode_content c
          JOIN publication_site_ids s USING (show_id, episode_id)
          WHERE c.show_id = ? AND s.site_id = ?`, page.showId, page.siteId).toArray();
      const episodes = rows.map((row) => {
        const revision = episodeRevisionSchema.parse(JSON.parse(row.revision_json));
        return { ...revision, enclosure_url: canonicalEnclosureUrl(revision, page.showId, baseUrl) };
      });
      const episodeSiteIds = Object.fromEntries(rows.map((row) => [row.episode_id, row.site_id]));
      const input: SiteRenderInput = {
        origin: baseUrl,
        coverExtension: content.cover_extension,
        episodeSiteIds,
        show: {
          show_id: metadata.show_id,
          title: metadata.title,
          description: metadata.description,
          language: metadata.language,
          author: metadata.author,
          ...(metadata.site_timezone !== undefined ? { site_timezone: metadata.site_timezone } : {}),
          ...(metadata.site_css !== undefined ? { site_css: metadata.site_css } : {}),
          ...(metadata.copyright ? { copyright: metadata.copyright } : {}),
        },
      };
      const formatDate = siteDateFormatter(metadata.site_timezone);
      if (page.kind === "listing") {
        const count = this.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM publication_episodes WHERE show_id = ? AND lifecycle = 'published'", page.showId).toArray()[0]!.count;
        const pages = Math.max(1, Math.ceil(count / SITE_PAGE_SIZE));
        return { html: renderSiteListingPage(input, episodes, page.page, pages, formatDate), css: metadata.site_css };
      }
      return episodes[0] ? { html: renderSiteEpisode(input, episodes[0], formatDate), css: metadata.site_css } : null;
    });
  }

  private cover(showId: string): (SqliteCoverIdentity & { extension: "jpg" | "png" }) | null {
    const row = this.storage.sql.exec<{ cover_generation: number; cover_sha256: string; cover_length_bytes: number; cover_extension: "jpg" | "png" }>(
      "SELECT cover_generation, cover_sha256, cover_length_bytes, cover_extension FROM publication_show_content WHERE show_id = ?", showId).toArray()[0];
    if (!row) return null;
    const cover = { generation: row.cover_generation, sha256: row.cover_sha256, lengthBytes: row.cover_length_bytes, extension: row.cover_extension };
    return validSqliteCoverIdentity(cover) && ["jpg", "png"].includes(cover.extension) ? cover : null;
  }

  private latestShowRevisionRow(showId: string): ShowRevisionRow | null {
    return this.storage.sql.exec<ShowRevisionRow>(
      "SELECT * FROM publication_show_revisions WHERE show_id = ? ORDER BY revision_sequence DESC LIMIT 1", showId).toArray()[0] ?? null;
  }

  private parseShowRevisionRow(row: ShowRevisionRow, baseUrl: string): SqliteShowRevisionRecord {
    const metadata = showMetadataSchema.parse(JSON.parse(row.metadata_json));
    if (metadata.show_id !== row.show_id || (metadata.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg") !== row.cover_extension ||
      !validSqliteCoverIdentity({ generation: row.cover_generation, sha256: row.cover_sha256, lengthBytes: row.cover_length_bytes })) {
      throw new Error("Stored Show revision is inconsistent");
    }
    return sqliteShowRevisionRecordSchema.parse({
      show_id: row.show_id, revision_sequence: row.revision_sequence, state_version: row.state_version,
      revision_id: row.revision_id, metadata_sha256: row.metadata_sha256, metadata,
      cover: { extension: row.cover_extension, generation: row.cover_generation, sha256: row.cover_sha256,
        length_bytes: row.cover_length_bytes, public_url: `${baseUrl.replace(/\/$/, "")}/podcasts/${row.show_id}/cover.${row.cover_extension}` },
      restored_from_revision_id: row.restored_from_revision_id, updated_at: row.updated_at,
    });
  }

  private parseEpisodeRevisionRow(row: EpisodeRevisionRow, baseUrl: string): SqliteEpisodeRevisionRecord {
    const stored = episodeRevisionSchema.parse(JSON.parse(row.revision_json));
    const enclosureUrl = canonicalEnclosureUrl(stored, row.show_id, baseUrl);
    const revision = episodeRevisionSchema.parse({ ...stored, enclosure_url: enclosureUrl });
    if (revision.episode_id !== row.episode_id || revision.revision_id !== row.revision_id || revision.updated_at !== row.updated_at) {
      throw new Error("Stored Episode revision is inconsistent");
    }
    this.requireMedia(row.show_id, revision, row.audio_revision_id);
    const asset = parsePublicAssetPath(new URL(enclosureUrl).pathname);
    if (!asset || asset.kind !== "audio" || asset.showId !== row.show_id || asset.episodeId !== row.episode_id || asset.revisionId !== row.audio_revision_id) {
      throw new Error("Episode revision audio reference differs");
    }
    return sqliteEpisodeRevisionRecordSchema.parse({
      show_id: row.show_id, episode_id: row.episode_id, revision_sequence: row.revision_sequence,
      revision_id: row.revision_id, metadata: episodeDraftFromRevision(revision), metadata_sha256: row.metadata_sha256,
      revision, audio: { audio_revision_id: row.audio_revision_id, sha256: revision.sha256,
        length_bytes: revision.length_bytes, duration_seconds: revision.duration_seconds, enclosure_url: enclosureUrl },
      restored_from_revision_id: row.restored_from_revision_id, updated_at: row.updated_at,
    });
  }

  inspect(showId: string, episodeId?: string): { show: ShowRow | null; episode: EpisodeRow | null; base: EpisodeRevision | null;
    showRevision?: ShowRevisionRow | null } {
    targetSchema.shape.show_id.parse(showId);
    if (episodeId !== undefined) targetSchema.shape.episode_id.unwrap().parse(episodeId);
    return this.storage.transactionSync(() => {
      const show = this.show(showId);
      const showRevision = show && ["published", "unpublished"].includes(show.lifecycle) ? this.latestShowRevisionRow(showId) : null;
      const episode = episodeId === undefined ? null : this.storage.sql.exec<EpisodeRow>(
        "SELECT * FROM publication_episodes WHERE show_id = ? AND episode_id = ?", showId, episodeId).toArray()[0] ?? null;
      const hasContent = episode && ["published", "unpublished"].includes(episode.lifecycle);
      const saved = hasContent ? this.storage.sql.exec<{ revision_json: string }>(
        "SELECT revision_json FROM publication_episode_content WHERE show_id = ? AND episode_id = ?", showId, episodeId!).toArray()[0] : null;
      const base = saved ? episodeRevisionSchema.parse(JSON.parse(saved.revision_json)) : null;
      if (hasContent && (!base || base.revision_id !== episode.revision_id || base.episode_id !== episodeId)) {
        throw new Error("Episode inspection has inconsistent content");
      }
      return { show, episode, base, showRevision };
    });
  }

  matchesScheduledTarget(request: Omit<SqliteContentMutation, "revision_id">): boolean {
    if (request.action !== "publish") return false;
    const target = this.inspect(request.show_id, request.episode_id);
    if (!target.show || target.show.state_version !== request.expected_show_state_version) return false;
    if (request.kind === "show") return ["draft", "published"].includes(target.show.lifecycle);
    return target.show.lifecycle === "published" &&
      (request.base_revision_id === undefined ? target.episode === null :
        target.episode?.lifecycle === "published" && target.episode.revision_id === request.base_revision_id &&
        target.episode.lifecycle_version === request.expected_episode_lifecycle_version);
  }

  currentShowRevision(showId: string, baseUrl: string): SqliteShowRevisionRecord | null {
    targetSchema.shape.show_id.parse(showId);
    return this.storage.transactionSync(() => {
      const show = this.show(showId);
      if (!show || !["published", "unpublished"].includes(show.lifecycle)) return null;
      const content = this.storage.sql.exec<{ metadata_json: string; cover_extension: "jpg" | "png" }>(
        "SELECT metadata_json, cover_extension FROM publication_show_content WHERE show_id = ?", showId).toArray()[0];
      const cover = this.cover(showId);
      const row = this.latestShowRevisionRow(showId);
      if (!content || !cover || !row || row.metadata_json !== content.metadata_json || row.cover_extension !== content.cover_extension ||
        row.cover_generation !== cover.generation || row.cover_sha256 !== cover.sha256 || row.cover_length_bytes !== cover.lengthBytes ||
        row.state_version > show.state_version) {
        throw new Error("Show revision history is inconsistent with current Show content");
      }
      return this.parseShowRevisionRow(row, baseUrl);
    });
  }

  showRevision(showId: string, revisionId: string, baseUrl: string): SqliteShowRevisionRecord | null {
    targetSchema.shape.show_id.parse(showId);
    z.uuid().parse(revisionId);
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<ShowRevisionRow>(
        "SELECT * FROM publication_show_revisions WHERE show_id = ? AND revision_id = ?", showId, revisionId).toArray()[0];
      return row ? this.parseShowRevisionRow(row, baseUrl) : null;
    });
  }

  currentEpisodeRevision(showId: string, episodeId: string, baseUrl: string): SqliteEpisodeRevisionRecord | null {
    targetSchema.shape.show_id.parse(showId);
    targetSchema.shape.episode_id.unwrap().parse(episodeId);
    return this.storage.transactionSync(() => {
      const episode = this.storage.sql.exec<EpisodeRow>(
        "SELECT * FROM publication_episodes WHERE show_id = ? AND episode_id = ?", showId, episodeId).toArray()[0];
      if (!episode || !["published", "unpublished"].includes(episode.lifecycle)) return null;
      const saved = this.storage.sql.exec<{ revision_json: string }>(
        "SELECT revision_json FROM publication_episode_content WHERE show_id = ? AND episode_id = ?", showId, episodeId).toArray()[0];
      const row = episode.revision_id ? this.storage.sql.exec<EpisodeRevisionRow>(
        "SELECT * FROM publication_episode_revisions WHERE show_id = ? AND episode_id = ? AND revision_id = ?",
        showId, episodeId, episode.revision_id).toArray()[0] : null;
      if (!saved || !row || row.revision_json !== saved.revision_json) {
        throw new Error("Episode revision history is inconsistent with current Episode content");
      }
      return this.parseEpisodeRevisionRow(row, baseUrl);
    });
  }

  episodeRevision(showId: string, episodeId: string, revisionId: string, baseUrl: string): SqliteEpisodeRevisionRecord | null {
    targetSchema.shape.show_id.parse(showId);
    targetSchema.shape.episode_id.unwrap().parse(episodeId);
    z.uuid().parse(revisionId);
    return this.storage.transactionSync(() => {
      const row = this.storage.sql.exec<EpisodeRevisionRow>(
        "SELECT * FROM publication_episode_revisions WHERE show_id = ? AND episode_id = ? AND revision_id = ?",
        showId, episodeId, revisionId).toArray()[0];
      return row ? this.parseEpisodeRevisionRow(row, baseUrl) : null;
    });
  }

  listShowRevisions(showId: string, baseUrl: string, afterSequence?: number): {
    currentRevisionId: string | null; items: SqliteShowRevisionSummary[]; nextCursor: number | null } {
    targetSchema.shape.show_id.parse(showId);
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 1)) throw new Error("Invalid Show revision cursor");
    return this.storage.transactionSync(() => {
      const current = this.currentShowRevision(showId, baseUrl);
      const rows = this.storage.sql.exec(
        `SELECT show_id, revision_sequence, state_version, revision_id, substr(json_extract(metadata_json, '$.title'), 1, 200) AS title,
         metadata_sha256, cover_extension, cover_generation, cover_sha256, cover_length_bytes, restored_from_revision_id, updated_at
         FROM publication_show_revisions WHERE show_id = ? ${afterSequence !== undefined ? "AND revision_sequence < ?" : ""}
         ORDER BY revision_sequence DESC LIMIT ?`,
        showId, ...(afterSequence !== undefined ? [afterSequence] : []), SQLITE_REVISION_PAGE_SIZE + 1).toArray();
      const page = rows.slice(0, SQLITE_REVISION_PAGE_SIZE).map((row) => {
        return sqliteShowRevisionSummarySchema.parse({
          show_id: row.show_id, revision_sequence: row.revision_sequence, state_version: row.state_version,
          revision_id: row.revision_id, title: row.title, metadata_sha256: row.metadata_sha256,
          cover: { extension: row.cover_extension, generation: row.cover_generation, sha256: row.cover_sha256,
            length_bytes: row.cover_length_bytes, public_url: `${baseUrl.replace(/\/$/, "")}/podcasts/${showId}/cover.${row.cover_extension}` },
          restored_from_revision_id: row.restored_from_revision_id, updated_at: row.updated_at,
          is_current: current?.revision_id === row.revision_id,
        });
      });
      return { currentRevisionId: current?.revision_id ?? null, items: page,
        nextCursor: rows.length > SQLITE_REVISION_PAGE_SIZE ? page[SQLITE_REVISION_PAGE_SIZE - 1]!.revision_sequence : null };
    });
  }

  listEpisodeRevisions(showId: string, episodeId: string, baseUrl: string, afterSequence?: number): {
    currentRevisionId: string | null; items: SqliteEpisodeRevisionSummary[]; nextCursor: number | null } {
    targetSchema.shape.show_id.parse(showId);
    targetSchema.shape.episode_id.unwrap().parse(episodeId);
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 1)) throw new Error("Invalid Episode revision cursor");
    return this.storage.transactionSync(() => {
      const current = this.currentEpisodeRevision(showId, episodeId, baseUrl);
      const rows = this.storage.sql.exec(
        `SELECT show_id, episode_id, revision_sequence, revision_id, audio_revision_id, metadata_sha256, restored_from_revision_id, updated_at,
         substr(json_extract(revision_json, '$.title'), 1, 200) AS title, json_extract(revision_json, '$.published_at') AS published_at,
         json_extract(revision_json, '$.sha256') AS sha256, json_extract(revision_json, '$.length_bytes') AS length_bytes,
         json_extract(revision_json, '$.duration_seconds') AS duration_seconds
         FROM publication_episode_revisions WHERE show_id = ? AND episode_id = ? ${afterSequence !== undefined ? "AND revision_sequence < ?" : ""}
         ORDER BY revision_sequence DESC LIMIT ?`,
        showId, episodeId, ...(afterSequence !== undefined ? [afterSequence] : []), SQLITE_REVISION_PAGE_SIZE + 1).toArray();
      const page = rows.slice(0, SQLITE_REVISION_PAGE_SIZE).map((row) => {
        return sqliteEpisodeRevisionSummarySchema.parse({
          show_id: row.show_id, episode_id: row.episode_id, revision_sequence: row.revision_sequence,
          revision_id: row.revision_id, title: row.title, published_at: row.published_at, metadata_sha256: row.metadata_sha256,
          audio: { audio_revision_id: row.audio_revision_id, sha256: row.sha256, length_bytes: row.length_bytes,
            duration_seconds: row.duration_seconds, enclosure_url: `${baseUrl.replace(/\/$/, "")}/podcasts/${showId}/episodes/${episodeId}/${row.audio_revision_id}.mp3` },
          restored_from_revision_id: row.restored_from_revision_id, updated_at: row.updated_at,
          is_current: current?.revision_id === row.revision_id,
        });
      });
      return { currentRevisionId: current?.revision_id ?? null, items: page,
        nextCursor: rows.length > SQLITE_REVISION_PAGE_SIZE ? page[SQLITE_REVISION_PAGE_SIZE - 1]!.revision_sequence : null };
    });
  }

  inventoryStats(showId: string): { count: number; chars: number } {
    targetSchema.shape.show_id.parse(showId);
    const row = this.storage.sql.exec<{ count: number; chars: number | null }>(`SELECT COUNT(*) AS count, SUM(length(c.revision_json)) AS chars
      FROM publication_episode_content c JOIN publication_episodes e USING (show_id, episode_id)
      WHERE e.show_id = ? AND e.lifecycle = 'published'`, showId).toArray()[0]!;
    return { count: row.count, chars: row.chars ?? 0 };
  }

  episodePage(showId: string, after = "") {
    targetSchema.shape.show_id.parse(showId);
    if (after) targetSchema.shape.episode_id.unwrap().parse(after);
    const rows = this.storage.sql.exec<{ episode_id: string; revision_json: string }>(`SELECT e.episode_id, c.revision_json
      FROM publication_episodes e JOIN publication_episode_content c USING (show_id, episode_id)
      WHERE e.show_id = ? AND e.lifecycle = 'published' AND e.episode_id > ? ORDER BY e.episode_id LIMIT 21`, showId, after).toArray();
    return { items: rows.slice(0, 20).map((row) => episodeRevisionSchema.parse(JSON.parse(row.revision_json))),
      nextCursor: rows.length > 20 ? rows[19]!.episode_id : null };
  }

  target(request: Omit<SqliteContentMutation, "revision_id">): SqliteContentTarget {
    const show = this.show(request.show_id);
    const showStates = request.action === "publish" ? ["draft", "published"] :
      request.action === "restore_revision" ? (request.kind === "show" ? ["published", "unpublished"] : ["published"]) :
      request.kind === "episode" && request.action === "unpublish" ? ["published", "unpublished"] :
      [request.action === "restore" && request.kind === "show" ? "unpublished" : "published"];
    if (!show || !showStates.includes(show.lifecycle) || request.kind === "episode" && request.action !== "unpublish" && show.lifecycle !== "published") {
      throw new SqlitePublicationInputError("target_unavailable");
    }
    if (show.state_version !== request.expected_show_state_version) throw new SqlitePublicationInputError("base_conflict");
    if (request.kind === "show" && show.state_version === Number.MAX_SAFE_INTEGER) throw new SqlitePublicationInputError("target_unavailable");
    const content = this.storage.sql.exec<{ metadata_json: string; cover_extension: "jpg" | "png" }>(
      "SELECT metadata_json, cover_extension FROM publication_show_content WHERE show_id = ?", request.show_id).toArray()[0];
    const metadata = content ? showMetadataSchema.parse(JSON.parse(content.metadata_json)) : null;
    const cover = this.cover(request.show_id);
    if (["published", "unpublished"].includes(show.lifecycle) && (!metadata || metadata.show_id !== show.show_id || !cover)) throw new Error("Published Show content index is inconsistent");
    const episode = request.kind === "episode" ? this.storage.sql.exec<EpisodeRow>(
      "SELECT * FROM publication_episodes WHERE show_id = ? AND episode_id = ?", request.show_id, request.episode_id!).toArray()[0] ?? null : null;
    const allowedEpisodeStates = request.action === "restore_revision" ? ["published", "unpublished"] :
      [request.action === "restore" ? "unpublished" : "published"];
    if (request.kind === "episode" && (request.action !== "publish" && !episode || episode && !allowedEpisodeStates.includes(episode.lifecycle))) {
      throw new SqlitePublicationInputError("target_unavailable");
    }
    if (request.kind === "episode" && (episode?.lifecycle_version ?? 0) !== (request.expected_episode_lifecycle_version ?? 0)) throw new SqlitePublicationInputError("base_conflict");
    if (request.kind === "episode" && (request.action !== "publish" || episode?.lifecycle === "unpublished") && episode?.lifecycle_version === Number.MAX_SAFE_INTEGER) {
      throw new SqlitePublicationInputError("target_unavailable");
    }
    if (request.kind === "episode" && (episode?.revision_id ?? undefined) !== request.base_revision_id) throw new SqlitePublicationInputError("base_conflict");
    const saved = episode ? this.storage.sql.exec<{ revision_json: string }>(
      "SELECT revision_json FROM publication_episode_content WHERE show_id = ? AND episode_id = ?", request.show_id, request.episode_id!).toArray()[0] : null;
    const base = saved ? episodeRevisionSchema.parse(JSON.parse(saved.revision_json)) : null;
    if (episode && (!base || base.episode_id !== episode.episode_id || base.revision_id !== episode.revision_id)) throw new Error("Published Episode content index is inconsistent");
    return { show, metadata, coverExtension: content?.cover_extension ?? null, cover, episode, base };
  }

  episodes(showId: string): EpisodeRevision[] {
    const limits = this.storage.sql.exec<{ count: number; bytes: number | null }>(`SELECT COUNT(*) AS count, SUM(length(c.revision_json)) AS bytes
      FROM publication_episode_content c JOIN publication_episodes e USING (show_id, episode_id)
      WHERE e.show_id = ? AND e.lifecycle = 'published'`, showId).toArray()[0]!;
    assertPublicationInventoryBudget(limits.count, limits.bytes ?? 0);
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
    const media = this.storage.sql.exec<{ sha256: string; length_bytes: number }>(
      "SELECT sha256, length_bytes FROM publication_media WHERE show_id = ? AND episode_id = ? AND audio_revision_id = ?",
      showId, revision.episode_id, audioRevisionId).toArray()[0];
    if (!media || media.sha256 !== revision.sha256 || media.length_bytes !== revision.length_bytes) {
      throw new SqlitePublicationInputError("validation_failed");
    }
  }

  nextCoverGeneration(showId: string): number {
    const generation = (this.storage.sql.exec<{ max: number | null }>(
      "SELECT MAX(cover_generation) AS max FROM publication_show_revisions WHERE show_id = ?", showId).toArray()[0]?.max ?? 0) + 1;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Cover generation space is exhausted");
    return generation;
  }

  nextFeedGeneration(showId: string): number {
    const generation = (this.show(showId)?.feed_generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Feed generation space is exhausted");
    return generation;
  }

  commitShow(request: SqliteContentMutation, metadata: ShowMetadata, extension: "jpg" | "png", cover: SqliteCoverIdentity,
    options: { metadataSha256: string; updatedAt: string; restoredFromRevisionId?: string }): void {
    const target = this.target(request);
    if (!["publish", "restore_revision"].includes(request.action) || request.kind !== "show" || metadata.show_id !== request.show_id) {
      throw new Error("Show commit differs from its running target");
    }
    const canonicalMetadata = JSON.stringify(showMetadataSchema.parse(metadata));
    if (request.action === "publish") {
      if (!validSqliteCoverIdentity(cover) || cover.generation !== this.nextCoverGeneration(request.show_id) || options.restoredFromRevisionId !== undefined) {
        throw new Error("Prepared cover identity differs");
      }
    } else {
      const source = this.storage.sql.exec<ShowRevisionRow>(
        "SELECT * FROM publication_show_revisions WHERE show_id = ? AND revision_id = ?", request.show_id, request.target_revision_id!).toArray()[0];
      if (!source || options.restoredFromRevisionId !== source.revision_id || source.metadata_json !== canonicalMetadata ||
        source.cover_extension !== extension || source.cover_generation !== cover.generation || source.cover_sha256 !== cover.sha256 ||
        source.cover_length_bytes !== cover.lengthBytes || !validSqliteCoverIdentity(cover)) {
        throw new Error("Restored Show revision differs from its stored history");
      }
    }
    this.storage.sql.exec(`INSERT INTO publication_show_content (show_id, metadata_json, cover_extension, cover_generation, cover_sha256, cover_length_bytes)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(show_id) DO UPDATE SET metadata_json = excluded.metadata_json,
      cover_extension = excluded.cover_extension, cover_generation = excluded.cover_generation,
      cover_sha256 = excluded.cover_sha256, cover_length_bytes = excluded.cover_length_bytes`,
    request.show_id, canonicalMetadata, extension, cover.generation, cover.sha256, cover.lengthBytes);
    const nextStateVersion = target.show.state_version + 1;
    this.storage.sql.exec("UPDATE publication_shows SET lifecycle = 'published', state_version = ? WHERE show_id = ?", nextStateVersion, request.show_id);
    const nextSequence = (this.storage.sql.exec<{ seq: number | null }>(
      "SELECT MAX(revision_sequence) AS seq FROM publication_show_revisions WHERE show_id = ?", request.show_id).toArray()[0]?.seq ?? 0) + 1;
    if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) throw new Error("Show revision sequence space is exhausted");
    this.storage.sql.exec(`INSERT INTO publication_show_revisions (show_id, revision_sequence, state_version, revision_id,
      metadata_json, metadata_sha256, cover_extension, cover_generation, cover_sha256, cover_length_bytes, restored_from_revision_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    request.show_id, nextSequence, nextStateVersion, request.revision_id, canonicalMetadata,
    options.metadataSha256, extension, cover.generation, cover.sha256, cover.lengthBytes,
    options.restoredFromRevisionId ?? null, options.updatedAt);
    this.advanceFeed(request);
  }

  commitEpisode(request: SqliteContentMutation, revision: EpisodeRevision, audioRevisionId: string, newAudio: boolean,
    options: { metadataSha256: string; restoredFromRevisionId?: string }): void {
    const target = this.target(request);
    if (!["publish", "restore_revision"].includes(request.action) || request.kind !== "episode" || revision.episode_id !== request.episode_id || revision.revision_id !== request.revision_id) {
      throw new Error("Episode commit differs from its running target");
    }
    if (request.action === "restore_revision") {
      const source = this.storage.sql.exec<EpisodeRevisionRow>(
        "SELECT * FROM publication_episode_revisions WHERE show_id = ? AND episode_id = ? AND revision_id = ?",
        request.show_id, request.episode_id, request.target_revision_id!).toArray()[0];
      const sourceRevision = source ? episodeRevisionSchema.parse(JSON.parse(source.revision_json)) : null;
      if (!source || !sourceRevision || newAudio || options.restoredFromRevisionId !== source.revision_id ||
        source.audio_revision_id !== audioRevisionId ||
        JSON.stringify(episodeDraftFromRevision(sourceRevision)) !== JSON.stringify(episodeDraftFromRevision(revision)) ||
        sourceRevision.sha256 !== revision.sha256 || sourceRevision.length_bytes !== revision.length_bytes ||
        sourceRevision.duration_seconds !== revision.duration_seconds) {
        throw new Error("Restored Episode revision differs from its stored history");
      }
    } else if (options.restoredFromRevisionId !== undefined) {
      throw new Error("Published Episode revision cannot set restored_from_revision_id");
    }
    this.requireUniqueGuid(request.show_id, revision);
    if (newAudio) this.storage.sql.exec(`INSERT INTO publication_media (show_id, episode_id, audio_revision_id, sha256, length_bytes)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(show_id, episode_id, audio_revision_id) DO NOTHING`,
    request.show_id, revision.episode_id, audioRevisionId, revision.sha256, revision.length_bytes);
    this.requireMedia(request.show_id, revision, audioRevisionId);
    const nextLifecycleVersion = (target.episode?.lifecycle_version ?? 0) + (target.episode?.lifecycle === "unpublished" ? 1 : 0);
    this.storage.sql.exec(`INSERT INTO publication_episodes (show_id, episode_id, lifecycle, lifecycle_version, revision_id) VALUES (?, ?, 'published', ?, ?)
      ON CONFLICT(show_id, episode_id) DO UPDATE SET lifecycle = 'published', lifecycle_version = excluded.lifecycle_version, revision_id = excluded.revision_id`,
    request.show_id, revision.episode_id, nextLifecycleVersion, revision.revision_id);
    const canonicalRevision = JSON.stringify(episodeRevisionSchema.parse(revision));
    this.storage.sql.exec(`INSERT INTO publication_episode_content (show_id, episode_id, guid, revision_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(show_id, episode_id) DO UPDATE SET guid = excluded.guid, revision_json = excluded.revision_json`,
    request.show_id, revision.episode_id, revision.guid, canonicalRevision);
    const nextSequence = (this.storage.sql.exec<{ seq: number | null }>(
      "SELECT MAX(revision_sequence) AS seq FROM publication_episode_revisions WHERE show_id = ? AND episode_id = ?",
      request.show_id, revision.episode_id).toArray()[0]?.seq ?? 0) + 1;
    if (!Number.isSafeInteger(nextSequence) || nextSequence < 1) throw new Error("Episode revision sequence space is exhausted");
    this.storage.sql.exec(`INSERT INTO publication_episode_revisions (show_id, episode_id, revision_sequence, revision_id,
      audio_revision_id, metadata_sha256, revision_json, restored_from_revision_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    request.show_id, revision.episode_id, nextSequence, revision.revision_id, audioRevisionId,
    options.metadataSha256, canonicalRevision, options.restoredFromRevisionId ?? null, revision.updated_at);
    this.advanceFeed(request);
  }

  private advanceFeed(request: SqliteContentMutation): void {
    const generation = this.nextFeedGeneration(request.show_id);
    this.storage.sql.exec("UPDATE publication_shows SET feed_generation = ? WHERE show_id = ?", generation, request.show_id);
  }

  commitLifecycle(request: SqliteContentMutation): void {
    const target = this.target(request);
    if (request.action !== "restore" && request.action !== "unpublish") throw new Error("A lifecycle commit cannot publish new content");
    const lifecycle = request.action === "restore" ? "published" : "unpublished";
    if (request.kind === "show") this.storage.sql.exec("UPDATE publication_shows SET lifecycle = ?, state_version = state_version + 1 WHERE show_id = ?", lifecycle, request.show_id);
    else this.storage.sql.exec("UPDATE publication_episodes SET lifecycle = ?, lifecycle_version = lifecycle_version + 1 WHERE show_id = ? AND episode_id = ?", lifecycle, request.show_id, request.episode_id!);
    if (request.kind === "show" ? request.action === "restore" : target.show.lifecycle === "published") this.advanceFeed(request);
  }

  delivery(path: string): SqliteDeliveryDecision {
    const asset = parsePublicAssetPath(path);
    if (!asset) return { status: 404 };
    return this.storage.transactionSync(() => {
      const show = this.show(asset.showId);
      if (!show) return { status: 404 };
      if (show.lifecycle === "draft" || show.lifecycle === "unpublished") return { status: 404 };
      if (show.lifecycle === "deleted") return { status: 410 };
      if (!Number.isSafeInteger(show.feed_generation) || show.feed_generation < 1) return { status: 503 };
      const cover = this.cover(asset.showId);
      if (!cover) return { status: 503 };
      if (asset.kind === "cover") {
        if (!asset.key.endsWith(`cover.${cover.extension}`)) return { status: 404 };
      }
      let episodeGeneration = 0;
      let key = asset.key;
      if (asset.kind === "cover") key = sqliteMediaKey(asset.showId, { sha256: cover.sha256, extension: cover.extension });
      if (asset.kind === "audio") {
        const episode = this.storage.sql.exec<EpisodeRow>("SELECT * FROM publication_episodes WHERE show_id = ? AND episode_id = ?", asset.showId, asset.episodeId).toArray()[0];
        if (!episode || episode.lifecycle === "unpublished") return { status: 404 };
        if (episode.lifecycle === "deleted") return { status: 410 };
        episodeGeneration = episode.lifecycle_version;
        const media = this.storage.sql.exec<{ sha256: string; length_bytes: number }>(`SELECT sha256, length_bytes FROM publication_media
          WHERE show_id = ? AND episode_id = ? AND audio_revision_id = ?`, asset.showId, asset.episodeId, asset.revisionId).toArray()[0];
        if (!media) return { status: 404 };
        key = sqliteMediaKey(asset.showId, media);
      }
      const cache_props = asset.kind === "feed" ? { showGeneration: show.state_version, feedGeneration: show.feed_generation } :
        asset.kind === "audio" ? { showGeneration: show.state_version, episodeGeneration, objectKey: key } :
          { showGeneration: show.state_version, coverGeneration: cover.generation, objectKey: key };
      return { status: 200, key, content_type: asset.contentType, cache_props };
    });
  }
}
