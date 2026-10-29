import { expect, test } from "bun:test";
import { comparePublishedEpisodes } from "../packages/shared/src/episode-order";
import { directPublicationFixture } from "./test-support/direct-publication";

test("site pages read only their Episodes and short IDs, preserving date and ID ordering", async () => {
  const f = await directPublicationFixture();
  try {
    await f.publish(f.show());
    const ids = ["a", "a-b", "ab", "a0", "a-1", ...Array.from({ length: 20 }, (_, index) => `ep-${index}`)];
    const dates = ["2026-10-25T00:00:00Z", "2026-10-25T09:00:00+09:00", "2026-10-25T23:00:00+23:00",
      "2026-10-25T00:00:00-23:59", "2026-10-24T00:00:00Z"];
    for (const [index, id] of ids.entries()) {
      const request = f.episode(id); request.metadata.published_at = dates[index % dates.length]!;
      await f.publish(request);
    }
    await f.queue.publish(f.action("unpublish", "ep-0"));
    const expected = f.content.episodes("daily").toSorted(comparePublishedEpisodes).map((episode) => episode.episode_id);
    f.content.episodes = () => { throw new Error("Pages must not load the full Episode inventory"); };
    f.content.siteIds.all = () => { throw new Error("Pages must not load every short ID"); };
    const exec = f.storage.sql.exec.bind(f.storage.sql), rowCounts: number[] = [];
    f.storage.sql.exec = <Row extends Record<string, string | number | null>>(query: string, ...bindings: (string | number | null)[]) => {
      const cursor = exec<Row>(query, ...bindings);
      return { toArray() {
        const rows = cursor.toArray();
        if (query.includes("SELECT c.revision_json")) rowCounts.push(rows.length);
        return rows;
      } };
    };
    for (const page of [1, 2]) {
      const rendered = f.content.renderSitePage({ kind: "listing", showId: "daily", page }, f.config.public_base_url)!;
      const displayed = [...rendered.html.matchAll(/<article class="cl-episode" aria-labelledby="episode-([a-z0-9-]+)-title"/g)].map((match) => match[1]);
      expect(displayed).toEqual(expected.slice((page - 1) * 20, page * 20));
    }
    const siteId = f.content.siteIds.get("daily", "a")!;
    expect(f.content.renderSitePage({ kind: "episode", showId: "daily", siteId }, f.config.public_base_url)?.html)
      .toContain('id="episode-a-title"');
    expect(rowCounts).toEqual([20, 4, 1]);
    expect(f.content.renderSitePage({ kind: "listing", showId: "daily", page: 3 }, f.config.public_base_url)).toBeNull();
  } finally { f.close(); }
});
