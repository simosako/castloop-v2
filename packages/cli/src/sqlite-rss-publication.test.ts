import { afterEach, expect, test } from "bun:test";
import { importRssLocally } from "./rss-import-local";
import { createSqliteRssEffects, publishSqliteRssImport } from "./sqlite-rss-publication";
import type { SqliteRssEffects } from "./sqlite-rss-publication";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { startSqliteDomainChange } from "./sqlite-domain-operation";
import { loadWorkspaceConfig } from "./workspace-config";
import { parseShowMetadata, stringifyToml } from "@castloop/shared";
import { RSS_IMPORT_AUDIO, RSS_IMPORT_SOURCE, rssImportTransport } from "./test-support/rss-import";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });
async function fixture(count = 2, customDomain = false, future = false) {
  const value = await sqliteServiceFixture(); values.push(value);
  await initializeSqliteService(value.root, value.config, crypto.randomUUID(), "source", value.options, { attempts: 2, delay: async () => {} });
  if (customDomain) await startSqliteDomainChange(value.root, value.config, "add", crypto.randomUUID(), "source", value.options,
    { hostname: "podcasts.example.com", zoneId: "c".repeat(32) }, { attempts: 2, delay: async () => {} });
  const config = await loadWorkspaceConfig(value.root);
  const options = { transport: value.transport, cloudflare: value.options };
  const original = RSS_IMPORT_SOURCE.match(/<item>[\s\S]*?<\/item>/)![0];
  const item = future ? original.replace("Wed, 01 Apr 2020 03:00:00 GMT", "Wed, 01 Apr 2099 03:00:00 GMT") : original;
  const items = Array.from({ length: count }, (_, index) => item.replace("old:123", index === 1 ? "https://old.example/second" : `old:${index}`)
    .replace('isPermaLink="false"', `isPermaLink="${index === 1}"`).replace("First", `Episode ${index}`));
  const source = RSS_IMPORT_SOURCE.replace(original, items.join("")), output = join(value.root, "import");
  await importRssLocally("imported", "https://source.example/feed", output, rssImportTransport(false, source).effects);
  const report = JSON.parse(readFileSync(join(output, "import.json"), "utf8")) as { import_id: string; episodes: Array<{ metadata: { episode_id: string; guid: string; guid_is_permalink: boolean; published_at: string } }> };
  const commands: string[] = [], native = createSqliteRssEffects(value.root, config, options);
  const effects = { ...native, async command(name: string, args: string[]) {
    commands.push(name); return native.command(name, args); },
    async readFeed() { return value.nodes.get("imported")!.service.renderFeed()!.xml; } };
  const execute = (custom: SqliteRssEffects = effects, customOptions = options) => publishSqliteRssImport(value.root, config, output, customOptions, custom);
  const cursor = join(value.root, ".castloop", "sqlite-rss-imports", value.config.service_id, `${report.import_id}.json`);
  return Object.assign(value, { output, report, commands, effects, execute, cursor, options });
}

test("RSS bulk publication refuses future published_at without explicit acknowledgement", async () => {
  const value = await fixture(2, false, true);
  await expect(value.execute()).rejects.toThrow("future published_at");
  expect(value.commands).toHaveLength(0);
  const options = { ...value.options, allowFuturePublishedAt: true };
  const native = createSqliteRssEffects(value.root, value.config, options);
  const effects = { ...native, async readFeed() {
    return value.nodes.get("imported")!.service.renderFeed()!.xml;
  } };
  expect(await publishSqliteRssImport(value.root, value.config, value.output, options, effects)).toMatchObject({ episode_count: 2 });
  for (const original of value.report.episodes) {
    expect(value.content.episodes("imported").find((episode) => episode.episode_id === original.metadata.episode_id)).
      toMatchObject(original.metadata);
  }
});

test("SQLite RSS import publishes 36 Episodes sequentially and preserves external GUID/permalink/date identities", async () => {
  const value = await fixture(36);
  expect(await value.execute()).toMatchObject({ result: "rss-import-published", protocol: "sqlite-sequential-v1", episode_count: 36, subscriber_migration_completed: false });
  const episodes = value.content.episodes("imported"); expect(episodes).toHaveLength(36);
  for (const original of value.report.episodes) {
    const published = episodes.find((episode) => episode.episode_id === original.metadata.episode_id)!;
    expect(published).toMatchObject(original.metadata);
    expect(Buffer.from(value.entries.get(`public/podcasts/imported/audio/${published.sha256}.mp3`)!.bytes)).toEqual(RSS_IMPORT_AUDIO);
  }
  expect(value.commands.filter((name) => name === "publish-show")).toHaveLength(1);
  expect(value.commands.filter((name) => name === "publish-episode")).toHaveLength(36);
  expect(value.calls.some((call) => /queues|system\/jobs|show-publications/.test(call.path))).toBe(false);
  const count = value.commands.length; value.calls.length = 0;
  await value.execute(); expect(value.commands).toHaveLength(count);
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
}, 60000);

test("RSS publication after a domain change verifies the canonical Feed without rewriting imported identities", async () => {
  const value = await fixture(2, true), origin = "https://podcasts.example.com";
  const effects = { ...value.effects, async readFeed(url: string) {
    expect(url).toBe(`${origin}/podcasts/imported/feed.xml`);
    return value.effects.readFeed();
  } };
  expect(await value.execute(effects)).toMatchObject({ feed_url: `${origin}/podcasts/imported/feed.xml`, episode_count: 2 });
  for (const original of value.report.episodes) {
    const published = value.content.episodes("imported").find((episode) => episode.episode_id === original.metadata.episode_id)!;
    expect(published).toMatchObject(original.metadata); expect(published.enclosure_url.startsWith(`${origin}/`)).toBe(true);
  }
  expect(value.domains).toHaveLength(1);
});

test("reviewed RSS imports can explicitly select builtin pages without changing imported identities", async () => {
  const value = await fixture(21), path = join(value.output, "show.toml");
  const { site_url, ...metadata } = parseShowMetadata(readFileSync(path, "utf8"));
  writeFileSync(path, stringifyToml({ ...metadata, site_mode: "builtin" }));
  expect(await value.execute()).toMatchObject({ episode_count: 21 });
  const showService = value.nodes.get("imported")!.service;
  for (const original of value.report.episodes) {
    const episodeId = original.metadata.episode_id;
    const siteId = value.content.sites.ids.get("imported", episodeId)!;
    expect(showService.renderSitePage({ kind: "episode", showId: "imported", siteId })!.html).toContain('<audio controls preload="none"');
    expect(value.content.episodes("imported").find((item) => item.episode_id === episodeId)).toMatchObject(original.metadata);
  }
  expect(showService.renderSitePage({ kind: "listing", showId: "imported", page: 2 })).not.toBeNull();
}, 60000);

test("a lost publication checkpoint resumes with a content no-op and no second upload", async () => {
  const value = await fixture(); let lose = true;
  const effects = { ...value.effects, async command(name: string, args: string[]) {
    const result = await value.effects.command(name, args);
    if (name === "publish-show" && lose) { lose = false; throw new Error("lost checkpoint"); }
    return result;
  } };
  await expect(value.execute(effects)).rejects.toThrow("lost checkpoint");
  expect(JSON.parse(readFileSync(value.cursor, "utf8"))).toMatchObject({ step: 0, phase: "publishing" });
  expect(await value.execute(effects)).toMatchObject({ episode_count: 2 });
  expect(value.commands.filter((name) => name === "publish-show")).toHaveLength(2);
  expect(value.commands.some((name) => name.startsWith("update-"))).toBe(false);
  expect(value.nodes.get("imported")!.fixture.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM publication_show_revisions").toArray()[0]!.count).toBe(1);
});

test("RSS imports freeze and install the reviewed Show CSS and timezone and use them on Episode pages", async () => {
  const value = await fixture(2), path = join(value.output, "show.toml");
  const { site_url, ...metadata } = parseShowMetadata(readFileSync(path, "utf8"));
  writeFileSync(path, stringifyToml({ ...metadata, site_mode: "builtin", site_css_path: "site.css", site_timezone: "Asia/Tokyo" }));
  const css = ":root{--cl-accent:#882244}";
  writeFileSync(join(value.output, "site.css"), css);
  expect(await value.execute()).toMatchObject({ episode_count: 2 });
  expect(value.content.currentShowRevision("imported", value.config.public_base_url)!.metadata.site_css).toBe(css);
  expect(value.content.currentShowRevision("imported", value.config.public_base_url)!.metadata.site_timezone).toBe("Asia/Tokyo");
  const showService = value.nodes.get("imported")!.service;
  for (const episode of value.content.episodes("imported")) {
    const siteId = value.content.sites.ids.get("imported", episode.episode_id)!;
    const html = showService.renderSitePage({ kind: "episode", showId: "imported", siteId })!.html;
    expect(html).toContain(css);
    expect(html).toContain("(UTC+09:00)</time>");
  }
});

test("RSS retries a lost Episode publication as unchanged and re-PUTs the identical MP3 key", async () => {
  const value = await fixture(2); let lose = true;
  const effects = { ...value.effects, async command(name: string, args: string[]) {
    const result = await value.effects.command(name, args);
    if (name === "publish-episode" && lose) { lose = false; throw new Error("lost reply"); }
    return result;
  } };
  await expect(value.execute(effects)).rejects.toThrow("lost reply");
  expect(await value.execute(effects)).toMatchObject({ episode_count: 2 });
  const audioPuts = value.calls.filter((call) => call.method === "PUT" && /\/audio\/[a-f0-9]{64}\.mp3$/.test(call.path));
  expect(audioPuts).toHaveLength(2);
  expect(new Set(audioPuts.map((call) => call.path)).size).toBe(1);
  expect([...value.entries.keys()].filter((key) => /\/audio\//.test(key))).toHaveLength(1);
  expect(value.content.episodes("imported")).toHaveLength(2);
  expect(value.calls.some((call) => /sqlite-operations|\/jobs/.test(call.path))).toBe(false);
});

test("an interrupted Show creation is completed by re-running and changed import inputs cannot replace a retained batch", async () => {
  const value = await fixture();
  await expect(value.execute({ ...value.effects, async command(name, args) {
    const result = await value.effects.command(name, args); if (name === "create-show") throw new Error("lost creation"); return result;
  } })).rejects.toThrow("lost creation");
  expect(await value.execute()).toMatchObject({ episode_count: 2 });
  const count = value.commands.length;
  const path = join(value.output, "show.toml"); writeFileSync(path, readFileSync(path, "utf8").replace('title = "Imported"', 'title = "Changed"'));
  await expect(value.execute()).rejects.toThrow("inputs changed"); expect(value.commands).toHaveLength(count);
});

test("an existing remote Show is never adopted when the local import directory is new", async () => {
  const value = await fixture();
  await runSqliteCommand(value.root, value.config, "create-show", ["imported", "https://example.com"], value.options);
  await expect(value.execute()).rejects.toThrow("not adopted"); expect(value.commands).toEqual([]);
});

test("audio changed after import preflight cannot be published even if the later PUT itself verifies", async () => {
  const value = await fixture();
  await expect(value.execute({ ...value.effects, async command(name, args) {
    const result = await value.effects.command(name, args);
    if (name === "publish-show") {
      const path = join(value.output, `${value.report.episodes[0]!.metadata.episode_id}.mp3`);
      const bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes);
    }
    return result;
  } })).rejects.toThrow("RSS audio changed");
  expect(value.commands.filter((name) => name === "publish-episode")).toHaveLength(0);
  expect(value.content.episodes("imported")).toHaveLength(0);
});

test("a failed final feed check is read-only and never repeats completed publications", async () => {
  const value = await fixture();
  await expect(value.execute({ ...value.effects, async readFeed() { throw new Error("read-only feed unavailable"); } })).rejects.toThrow("feed unavailable");
  const count = value.commands.length; value.calls.length = 0;
  expect(await value.execute()).toMatchObject({ result: "rss-import-published" });
  expect(value.commands).toHaveLength(count);
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
});

for (const kind of ["show", "episode"] as const) test(`edited RSS ${kind} input limits reject before audio validation, remote IO or publication journals`, async () => {
  const value = await fixture(1), id = value.report.episodes[0]!.metadata.episode_id;
  const file = join(value.output, kind === "show" ? "show.toml" : `episode-${id}.toml`);
  writeFileSync(file, readFileSync(file, "utf8").replace(/^title = .*$/m, `title = "${"a".repeat(256)}"`));
  writeFileSync(join(value.output, `${id}.mp3`), "must not be read before title validation");
  value.calls.length = 0;
  await expect(value.execute()).rejects.toThrow("title");
  expect(value.calls).toHaveLength(0);
  expect(value.commands).toHaveLength(0);
  expect(existsSync(value.cursor)).toBe(false);
  expect(value.content.inspect("imported").show).toBeNull();
});
