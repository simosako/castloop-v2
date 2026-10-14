import { expect, test } from "bun:test";
import { importRssLocally } from "./rss-import-local";
import { prepareRssImportPublication } from "./rss-import-preflight";
import { rssImportTransport } from "./test-support/rss-import";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("publication preflight validates every input, preserves original identity and freezes editable metadata", async () => {
  const parent = mkdtempSync("/tmp/opencode/castloop-rss-preflight-");
  const root = join(parent, "import");
  try {
    await importRssLocally("imported", "https://source.example/feed", root, rssImportTransport().effects);
    const before = await prepareRssImportPublication(root);
    expect(before.episodes).toHaveLength(1);
    expect(before.audioBytes).toBe(20850);
    const file = join(root, `episode-${before.episodes[0]!.metadata.episode_id}.toml`);
    const source = readFileSync(file, "utf8");
    writeFileSync(file, source.replace("First", "Edited"));
    expect((await prepareRssImportPublication(root)).inputSha256).not.toBe(before.inputSha256);
    for (const edit of [source.replace("old:123", "changed"), source.replace("2020-04-01", "2020-04-02"),
      source.replace("guid_is_permalink = false", "guid_is_permalink = true")]) {
      writeFileSync(file, edit);
      await expect(prepareRssImportPublication(root)).rejects.toThrow("original RSS");
    }
    writeFileSync(file, source);
    const showFile = join(root, "show.toml");
    writeFileSync(showFile, readFileSync(showFile, "utf8").replace("owner@example.com", "not-email"));
    await expect(prepareRssImportPublication(root)).rejects.toThrow();
    expect(readFileSync(join(root, "source.xml"), "utf8")).toContain("old:123");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
