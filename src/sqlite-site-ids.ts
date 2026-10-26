import { validateId } from "../packages/shared/src/ids";
import { sha256Hex } from "../packages/shared/src/sha256";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import { SqlitePublicationInputError } from "./sqlite-publication-alarm";

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
  private candidate(showId: string, episodeId: string, hash: string): string {
    const saved = this.get(showId, episodeId);
    if (saved) return saved;
    for (let length = 16; length <= 64; length += 4) {
      const id = hash.slice(0, length);
      if (this.episode(showId, id) === null) return id;
    }
    throw new SqlitePublicationInputError("validation_failed");
  }
  async preview(showId: string, episodeId: string): Promise<string> {
    validateId(showId, "show"); validateId(episodeId, "episode");
    const saved = this.get(showId, episodeId);
    return saved ?? this.candidate(showId, episodeId, await sha256Hex(episodeId));
  }
  async reserve(showId: string, episodes: ReadonlyArray<{ episode_id: string }>): Promise<Record<string, string>> {
    const ids = this.all(showId);
    for (const episode of episodes) {
      if (Object.hasOwn(ids, episode.episode_id)) continue;
      const hash = await sha256Hex(episode.episode_id);
      ids[episode.episode_id] = this.storage.transactionSync(() => {
        const saved = this.get(showId, episode.episode_id);
        if (saved) return saved;
        const id = this.candidate(showId, episode.episode_id, hash);
        this.storage.sql.exec("INSERT INTO publication_site_ids (show_id, episode_id, site_id) VALUES (?, ?, ?)",
          showId, episode.episode_id, id);
        return id;
      });
    }
    return ids;
  }
}
