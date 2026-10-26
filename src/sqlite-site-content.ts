import type { EpisodeRevision } from "../packages/shared/src/index";
import { episodeRevisionSchema } from "../packages/shared/src/index";
import { sitePagePath, SITE_PAGE_SIZE } from "../packages/shared/src/website";
import type { SitePage } from "../packages/shared/src/website";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import { orderedSiteEpisodes, renderSiteListingPage, renderSiteEpisode, siteCssHash } from "./site-renderer";
import type { SiteRenderInput } from "./site-renderer";
import { persistSitePage } from "./site-storage";
import type { SqlitePublicationBucket } from "./sqlite-publication-executor";
import type { SiteCacheProps } from "./site-cache";

type Build = { owner_id: string; show_id: string; generation: number; input_json: string; enabled: number;
  cursor: number; count: number; pages: number; changed_episode: string | null; media_purged: number; site_purged: number };
type SiteState = { generation: number; enabled: number; pages: number };

export class SqliteSiteContent {
  constructor(private readonly storage: PublicationQueueStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_site_builds (owner_id TEXT PRIMARY KEY, show_id TEXT NOT NULL,
      generation INTEGER NOT NULL, input_json TEXT NOT NULL, enabled INTEGER NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
      count INTEGER NOT NULL, pages INTEGER NOT NULL, changed_episode TEXT,
      media_purged INTEGER NOT NULL DEFAULT 0, site_purged INTEGER NOT NULL DEFAULT 0)`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_site_sources (owner_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      episode_id TEXT NOT NULL, revision_json TEXT NOT NULL, PRIMARY KEY(owner_id, ordinal), UNIQUE(owner_id, episode_id))`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_site_candidates (owner_id TEXT NOT NULL, path TEXT NOT NULL,
      props_json TEXT NOT NULL, PRIMARY KEY(owner_id, path))`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_site_pages (show_id TEXT NOT NULL, path TEXT NOT NULL,
      props_json TEXT NOT NULL, PRIMARY KEY(show_id, path))`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_site_state (show_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      enabled INTEGER NOT NULL, pages INTEGER NOT NULL)`);
  }
  build(id: string): Build | null {
    return this.storage.sql.exec<Build>("SELECT * FROM publication_site_builds WHERE owner_id = ?", id).toArray()[0] ?? null;
  }
  prepare(id: string, generation: number, showId: string, input: SiteRenderInput | null, episodes: EpisodeRevision[], changedEpisode?: string): void {
    if (this.build(id)) throw new Error("Site build already exists");
    const sorted = input ? orderedSiteEpisodes(episodes) : [];
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`INSERT INTO publication_site_builds
        (owner_id, show_id, generation, input_json, enabled, count, pages, changed_episode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, showId, generation, JSON.stringify(input), input ? 1 : 0, sorted.length,
      input ? Math.max(1, Math.ceil(sorted.length / SITE_PAGE_SIZE)) : 0, changedEpisode ?? null);
      sorted.forEach((episode, ordinal) => this.storage.sql.exec(`INSERT INTO publication_site_sources
        (owner_id, ordinal, episode_id, revision_json) VALUES (?, ?, ?, ?)`, id, ordinal, episode.episode_id, JSON.stringify(episode)));
    });
  }
  private total(build: Build): number {
    if (!build.enabled) return 0;
    return build.pages + (build.changed_episode === null ? build.count : this.storage.sql.exec(
      "SELECT ordinal FROM publication_site_sources WHERE owner_id = ? AND episode_id = ?", build.owner_id, build.changed_episode).toArray().length);
  }
  complete(id: string): boolean { const build = this.build(id); return !!build && build.cursor === this.total(build); }

  async batch(id: string, bucket: Pick<SqlitePublicationBucket, "put">): Promise<boolean> {
    const build = this.build(id);
    if (!build) throw new Error("Site build is missing");
    const total = this.total(build);
    if (build.cursor === total) return true;
    const input = JSON.parse(build.input_json) as SiteRenderInput;
    const cssHash = await siteCssHash(input.show.site_css);
    let bytes = 0, cursor = build.cursor;
    for (let written = 0; cursor < total && written < 20; cursor++, written++) {
      let page: SitePage, html: string;
      if (cursor < build.pages) {
        const episodes = this.storage.sql.exec<{ revision_json: string }>(`SELECT revision_json FROM publication_site_sources
          WHERE owner_id = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal`, id, cursor * SITE_PAGE_SIZE, (cursor + 1) * SITE_PAGE_SIZE)
          .toArray().map((row) => episodeRevisionSchema.parse(JSON.parse(row.revision_json)));
        page = { kind: "listing", showId: build.show_id, page: cursor + 1 };
        html = renderSiteListingPage(input, episodes, cursor + 1, build.pages);
      } else {
        const row = build.changed_episode === null ? this.storage.sql.exec<{ revision_json: string }>(
          "SELECT revision_json FROM publication_site_sources WHERE owner_id = ? AND ordinal = ?", id, cursor - build.pages).toArray()[0] :
          this.storage.sql.exec<{ revision_json: string }>("SELECT revision_json FROM publication_site_sources WHERE owner_id = ? AND episode_id = ?", id, build.changed_episode).toArray()[0];
        if (!row) throw new Error("Frozen site Episode is missing");
        const episode = episodeRevisionSchema.parse(JSON.parse(row.revision_json));
        page = { kind: "episode", showId: build.show_id, episodeId: episode.episode_id };
        html = renderSiteEpisode(input, episode);
      }
      const length = new TextEncoder().encode(html).byteLength;
      if (bytes + length > 4_000_000 && written > 0) break;
      const candidate = await persistSitePage(bucket, page, build.generation, html, { cssHash, showGeneration: 0,
        ...(page.kind === "episode" ? { episodeGeneration: 0 } : {}) });
      this.storage.sql.exec("INSERT INTO publication_site_candidates (owner_id, path, props_json) VALUES (?, ?, ?)",
        id, sitePagePath(page), JSON.stringify(candidate.props));
      bytes += length;
    }
    this.storage.sql.exec("UPDATE publication_site_builds SET cursor = ? WHERE owner_id = ? AND cursor = ?", cursor, id, build.cursor);
    return cursor === total;
  }
  confirmPurge(id: string, kind: "media" | "site"): void {
    if (!this.complete(id)) throw new Error("Site pages must be complete before confirming purge");
    this.storage.sql.exec(`UPDATE publication_site_builds SET ${kind === "media" ? "media_purged" : "site_purged"} = 1 WHERE owner_id = ?`, id);
  }
  commit(id: string): void {
    const build = this.build(id);
    if (!build || !this.complete(id) || build.media_purged !== 1 || build.site_purged !== 1) throw new Error("Site publication effects are not confirmed");
    if (!build.enabled || build.changed_episode === null) this.storage.sql.exec("DELETE FROM publication_site_pages WHERE show_id = ?", build.show_id);
    else {
      this.storage.sql.exec("DELETE FROM publication_site_pages WHERE show_id = ? AND (path NOT LIKE ? OR path = ?)",
        build.show_id, `/podcasts/${build.show_id}/episodes/%`, sitePagePath({ kind: "episode", showId: build.show_id, episodeId: build.changed_episode }));
    }
    this.storage.sql.exec(`INSERT INTO publication_site_pages (show_id, path, props_json)
      SELECT ?, path, props_json FROM publication_site_candidates WHERE owner_id = ?
       ON CONFLICT(show_id, path) DO UPDATE SET props_json = excluded.props_json`, build.show_id, id);
    this.storage.sql.exec(`INSERT INTO publication_site_state (show_id, generation, enabled, pages) VALUES (?, ?, ?, ?)
      ON CONFLICT(show_id) DO UPDATE SET generation = excluded.generation, enabled = excluded.enabled, pages = excluded.pages`,
    build.show_id, build.generation, build.enabled, build.pages);
  }
  state(showId: string): SiteState | null {
    return this.storage.sql.exec<SiteState>("SELECT generation, enabled, pages FROM publication_site_state WHERE show_id = ?", showId).toArray()[0] ?? null;
  }
  page(page: SitePage): SiteCacheProps | null {
    const row = this.storage.sql.exec<{ props_json: string }>("SELECT props_json FROM publication_site_pages WHERE show_id = ? AND path = ?",
      page.showId, sitePagePath(page)).toArray()[0];
    return row ? JSON.parse(row.props_json) as SiteCacheProps : null;
  }
}
