import { validateId } from "../packages/shared/src/ids";
import { sha256Hex } from "../packages/shared/src/sha256";
import { SqlitePublicationInputError } from "./sqlite-publication-queue";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";

export class SqliteSiteIds {
  constructor(private readonly storage: PublicationQueueStorage) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_site_ids (show_id TEXT NOT NULL, episode_id TEXT NOT NULL,
      site_id TEXT NOT NULL, PRIMARY KEY(show_id, episode_id), UNIQUE(show_id, site_id))`);
  }
  all(showId: string): Record<string, string> {
    return Object.fromEntries(this.storage.sql.exec<{ episode_id: string; site_id: string }>(
      "SELECT episode_id, site_id FROM publication_site_ids WHERE show_id = ?", showId).toArray().map((row) => [row.episode_id, row.site_id]));
  }
  get(showId: string, episodeId: string): string | null {
    return this.storage.sql.exec<{ site_id: string }>("SELECT site_id FROM publication_site_ids WHERE show_id = ? AND episode_id = ?",
      showId, episodeId).toArray()[0]?.site_id ?? null;
  }
  episode(showId: string, siteId: string): string | null {
    return this.storage.sql.exec<{ episode_id: string }>("SELECT episode_id FROM publication_site_ids WHERE show_id = ? AND site_id = ?",
      showId, siteId).toArray()[0]?.episode_id ?? null;
  }
  private candidate(showId: string, episodeId: string, hash: string, used: ReadonlySet<string>): string {
    const saved = this.get(showId, episodeId);
    if (saved) return saved;
    for (let length = 16; length <= 64; length += 4) {
      const id = hash.slice(0, length);
      if (!used.has(id) && this.episode(showId, id) === null) return id;
    }
    throw new SqlitePublicationInputError("validation_failed");
  }
  async preview(showId: string, episodeId: string): Promise<string> {
    validateId(showId, "show"); validateId(episodeId, "episode");
    const saved = this.get(showId, episodeId);
    return saved ?? this.candidate(showId, episodeId, await sha256Hex(episodeId), new Set());
  }
  async plan(showId: string, episodes: ReadonlyArray<{ episode_id: string }>): Promise<Record<string, string>> {
    const ids = this.all(showId);
    const used = new Set(Object.values(ids));
    for (const episode of episodes) {
      if (Object.hasOwn(ids, episode.episode_id)) continue;
      const hash = await sha256Hex(episode.episode_id);
      const id = this.candidate(showId, episode.episode_id, hash, used);
      ids[episode.episode_id] = id;
      used.add(id);
    }
    return ids;
  }
  commit(showId: string, ids: Readonly<Record<string, string>>): Record<string, string> {
    return this.storage.transactionSync(() => {
      for (const [episodeId, id] of Object.entries(ids)) {
        const saved = this.get(showId, episodeId);
        if (saved) {
          if (saved !== id) throw new Error("Site ID reservation changed before commit");
          continue;
        }
        if (this.episode(showId, id) !== null) throw new Error("Site ID collided before commit");
        this.storage.sql.exec("INSERT INTO publication_site_ids (show_id, episode_id, site_id) VALUES (?, ?, ?)",
          showId, episodeId, id);
      }
      return this.all(showId);
    });
  }
  async reserve(showId: string, episodes: ReadonlyArray<{ episode_id: string }>): Promise<Record<string, string>> {
    const ids = await this.plan(showId, episodes);
    return this.commit(showId, ids);
  }
}
