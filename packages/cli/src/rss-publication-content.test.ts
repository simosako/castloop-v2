import { expect, test } from "bun:test";
import { episodeRevisionSchema } from "@castloop/shared";
import { renderFeed } from "../../../src/feed";
import { importRssLocally } from "./rss-import-local";
import { prepareRssImportPublication } from "./rss-import-preflight";
import { verifyImportedFeed, writeImportedMetadata } from "./rss-publication-content";
import { rssImportTransport } from "./test-support/rss-import";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("imported content helpers reject changed metadata and verify published identities and internal audio references", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-rss-content-");
  try {
    const output = join(root, "import");
    await importRssLocally("imported", "https://source.example/feed", output, rssImportTransport().effects);
    const prepared = await prepareRssImportPublication(output);
    const source = join(output, "show.toml"), target = join(root, "show.toml");
    await writeImportedMetadata(source, target, prepared.show);
    expect(readFileSync(target)).toEqual(readFileSync(source));
    writeFileSync(source, readFileSync(source, "utf8").replace("owner@example.com", "other@example.com"));
    const saved = readFileSync(target);
    await expect(writeImportedMetadata(source, target, prepared.show)).rejects.toThrow("changed");
    expect(readFileSync(target)).toEqual(saved);
    const episode = prepared.episodes[0]!;
    const revision = episodeRevisionSchema.parse({ ...episode.metadata, revision_id: crypto.randomUUID(),
      enclosure_url: `https://current.example/podcasts/imported/episodes/${episode.metadata.episode_id}/${crypto.randomUUID()}.mp3`,
      content_type: "audio/mpeg", length_bytes: episode.length, duration_seconds: episode.duration,
      sha256: episode.sha256, updated_at: "2026-10-18T00:00:00Z" });
    const url = "https://current.example/podcasts/imported/feed.xml";
    const feed = renderFeed(prepared.show, [revision], "https://current.example", "jpg");
    expect(() => verifyImportedFeed(prepared, url, feed)).not.toThrow();
    for (const invalid of [feed.replace(revision.guid, "changed-guid"), feed.replace(revision.enclosure_url,
      revision.enclosure_url.replace("current.example", "old.example")), renderFeed(prepared.show, [], "https://current.example", "jpg"),
      renderFeed({ ...prepared.show, title: "Changed" }, [revision], "https://current.example", "jpg")]) {
      expect(() => verifyImportedFeed(prepared, url, invalid)).toThrow();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
