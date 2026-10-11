import { expect, test } from "bun:test";
import { parseEpisodeDraft, parseShowMetadata } from "@castloop/shared";
import { importRssLocally, inspectRssImport } from "./rss-import-local";
import { RSS_IMPORT_AUDIO as audio, RSS_IMPORT_SOURCE as source, rssImportTransport as transport } from "./test-support/rss-import";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("preview fetches RSS only and local import resumes without downloads or overwriting edited TOML", async () => {
  const parent = mkdtempSync("/tmp/opencode/castloop-rss-import-");
  const output = join(parent, "import");
  const setup = transport();
  try {
    const preview = await inspectRssImport("imported", "https://source.example/feed", setup.effects);
    expect(preview).toMatchObject({ episode_count: 1, cloudflare_changed: false });
    expect(setup.requests).toEqual(["/feed"]);
    expect(readdirSync(parent)).toEqual([]);
    await importRssLocally("imported", "https://source.example/feed", output, setup.effects);
    const report = JSON.parse(readFileSync(join(output, "import.json"), "utf8"));
    const episodeId = report.episodes[0].metadata.episode_id;
    expect(parseShowMetadata(readFileSync(join(output, "show.toml"), "utf8")).image_path).toBe("cover.jpg");
    const episodeFile = join(output, `episode-${episodeId}.toml`);
    expect(parseEpisodeDraft(readFileSync(episodeFile, "utf8")).guid).toBe("old:123");
    expect(readFileSync(join(output, `${episodeId}.mp3`))).toEqual(audio);
    writeFileSync(episodeFile, readFileSync(episodeFile, "utf8").replace("First", "Edited"));
    setup.requests.length = 0;
    await importRssLocally("imported", "https://source.example/feed", output, setup.effects);
    expect(setup.requests).toEqual([]);
    expect(parseEpisodeDraft(readFileSync(episodeFile, "utf8")).title).toBe("Edited");
    expect(readFileSync(join(output, ".gitignore"), "utf8")).toBe("*\n");
    await expect(importRssLocally("other", "https://source.example/feed", output, setup.effects)).rejects.toThrow("another Show");
    writeFileSync(join(output, `${episodeId}.mp3`), "changed");
    await expect(importRssLocally("imported", "https://source.example/feed", output, setup.effects)).rejects.toThrow("changed");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("interrupted downloads retain the RSS snapshot and resume only the unfinished asset", async () => {
  const parent = mkdtempSync("/tmp/opencode/castloop-rss-interrupt-");
  const output = join(parent, "import");
  try {
    await expect(importRssLocally("imported", "https://source.example/feed", output, transport(true).effects)).rejects.toThrow("interrupted");
    expect(readFileSync(join(output, "source.xml"), "utf8")).toBe(source);
    const next = transport();
    await importRssLocally("imported", "https://source.example/feed", output, next.effects);
    expect(next.requests).toEqual(["/audio"]);
    expect(readdirSync(output).some((name) => name.endsWith(".part"))).toBe(false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("import refuses unrelated directories and symlink targets before modifying them", async () => {
  const parent = mkdtempSync("/tmp/opencode/castloop-rss-path-");
  try {
    writeFileSync(join(parent, "retained"), "user work");
    await expect(importRssLocally("imported", "https://source.example/feed", parent, transport().effects)).rejects.toThrow("empty directory");
    expect(readdirSync(parent)).toEqual(["retained"]);
    symlinkSync(parent, join(parent, "link"));
    await expect(importRssLocally("imported", "https://source.example/feed", join(parent, "link"), transport().effects)).rejects.toThrow("real directory");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
