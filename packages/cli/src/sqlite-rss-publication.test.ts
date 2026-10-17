import { afterEach, expect, test } from "bun:test";
import { importRssLocally } from "./rss-import-local";
import { createSqliteRssEffects, publishSqliteRssImport } from "./sqlite-rss-publication";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { RSS_IMPORT_AUDIO, RSS_IMPORT_SOURCE, rssImportTransport } from "./test-support/rss-import";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });
async function fixture(count = 2) {
  const value = await sqliteServiceFixture(); values.push(value);
  await initializeSqliteService(value.root, value.config, crypto.randomUUID(), "source", value.options, { attempts: 2, delay: async () => {} });
  const options = { transport: value.transport, cloudflare: value.options };
  await runSqliteCommand(value.root, value.config, "service-resume", [crypto.randomUUID()], options);
  const item = RSS_IMPORT_SOURCE.match(/<item>[\s\S]*?<\/item>/)![0];
  const items = Array.from({ length: count }, (_, index) => item.replace("old:123", index === 1 ? "https://old.example/second" : `old:${index}`)
    .replace('isPermaLink="false"', `isPermaLink="${index === 1}"`).replace("First", `Episode ${index}`));
  const source = RSS_IMPORT_SOURCE.replace(item, items.join("")), output = join(value.root, "import");
  await importRssLocally("imported", "https://source.example/feed", output, rssImportTransport(false, source).effects);
  const report = JSON.parse(readFileSync(join(output, "import.json"), "utf8")) as { import_id: string; episodes: Array<{ metadata: { episode_id: string; guid: string; guid_is_permalink: boolean; published_at: string } }> };
  const commands: string[] = [], native = createSqliteRssEffects(value.root, value.config, options);
  const effects = { ...native, async command(name: string, args: string[]) { commands.push(name); return native.command(name, args); },
    async readFeed() { return value.text("public/podcasts/imported/feed.xml"); } };
  const execute = (custom = effects, customOptions = options) => publishSqliteRssImport(value.root, value.config, output, customOptions, custom);
  const cursor = join(value.root, ".castloop", "sqlite-rss-imports", value.config.service_id, `${report.import_id}.json`);
  return { ...value, output, report, commands, effects, execute, cursor, options };
}

test("SQLite RSS import publishes 36 Episodes sequentially and preserves external GUID/permalink/date identities", async () => {
  const value = await fixture(36);
  expect(await value.execute()).toMatchObject({ result: "rss-import-published", protocol: "sqlite-sequential-v1", episode_count: 36, subscriber_migration_completed: false });
  const episodes = value.content.episodes("imported"); expect(episodes).toHaveLength(36);
  for (const original of value.report.episodes) {
    const published = episodes.find((episode) => episode.episode_id === original.metadata.episode_id)!;
    expect(published).toMatchObject(original.metadata);
    expect(Buffer.from(value.entries.get(`public${new URL(published.enclosure_url).pathname}`)!.bytes)).toEqual(RSS_IMPORT_AUDIO);
  }
  expect(value.commands.filter((name) => name === "publish-show")).toHaveLength(1);
  expect(value.commands.filter((name) => name === "publish-episode")).toHaveLength(36);
  expect(value.calls.some((call) => /queues|system\/jobs|show-publications/.test(call.path))).toBe(false);
  const count = value.commands.length; value.calls.length = 0;
  await value.execute(); expect(value.commands).toHaveLength(count);
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
}, 60000);

test("a completed publication with a lost import checkpoint is observed without a second publish or upload", async () => {
  const value = await fixture(); let lose = true;
  const effects = { ...value.effects, async command(name: string, args: string[]) {
    const result = await value.effects.command(name, args);
    if (name === "publish-show" && lose) { lose = false; throw new Error("lost checkpoint"); }
    return result;
  } };
  await expect(value.execute(effects)).rejects.toThrow("lost checkpoint");
  expect(JSON.parse(readFileSync(value.cursor, "utf8"))).toMatchObject({ step: 3, phase: "command_requested" });
  expect(await value.execute(effects)).toMatchObject({ episode_count: 2 });
  expect(value.commands.filter((name) => name === "publish-show")).toHaveLength(1);
  expect(value.commands.filter((name) => name === "update-show")).toHaveLength(1);
});

test("an unknown upload is never repeated and changed imports cannot replace the frozen operation", async () => {
  const value = await fixture();
  const effects = { ...value.effects, async command(name: string, args: string[]) {
    if (name === "update-episode-audio") throw new Error("unknown upload");
    return value.effects.command(name, args);
  } };
  await expect(value.execute(effects)).rejects.toThrow("unknown upload");
  const count = value.commands.length;
  await expect(value.execute()).rejects.toThrow("without replaying");
  expect(value.commands).toHaveLength(count);
  const path = join(value.output, "show.toml"); writeFileSync(path, readFileSync(path, "utf8").replace('title = "Imported"', 'title = "Changed"'));
  await expect(value.execute()).rejects.toThrow("inputs changed"); expect(value.commands).toHaveLength(count);
});

test("a different current publication cannot be adopted for a retained import submission", async () => {
  const value = await fixture();
  await expect(value.execute({ ...value.effects, async command(name, args) {
    const result = await value.effects.command(name, args); if (name === "publish-show") throw new Error("lost checkpoint"); return result;
  } })).rejects.toThrow();
  const file = join(value.root, ".castloop", "sqlite-drafts", value.config.service_id, "show-imported.json");
  const record = JSON.parse(readFileSync(file, "utf8")); record.target.job_id = crypto.randomUUID(); writeFileSync(file, JSON.stringify(record));
  const count = value.commands.length;
  await expect(value.execute()).rejects.toThrow(); expect(value.commands).toHaveLength(count);
});

test("an existing remote Show is never adopted when the local import directory is new", async () => {
  const value = await fixture(); value.content.registerShow("imported", crypto.randomUUID());
  await expect(value.execute()).rejects.toThrow("never adopt"); expect(value.commands).toEqual([]);
});

test("audio changed after import preflight cannot be published even if the later PUT itself verifies", async () => {
  const value = await fixture();
  await expect(value.execute({ ...value.effects, async command(name, args) {
    if (name === "update-episode-audio") {
      const bytes = readFileSync(args[2]); bytes[bytes.length - 1] ^= 1; writeFileSync(args[2], bytes);
    }
    return value.effects.command(name, args);
  } })).rejects.toThrow("reviewed import");
  expect(value.commands.filter((name) => name === "publish-episode")).toHaveLength(0);
  expect(value.content.episodes("imported")).toHaveLength(0);
});

test("a failed final feed check is read-only and never repeats completed publications", async () => {
  const value = await fixture();
  await expect(value.execute({ ...value.effects, async readFeed() { throw new Error("read-only feed unavailable"); } })).rejects.toThrow("feed unavailable");
  const count = value.commands.length; value.calls.length = 0;
  expect(await value.execute()).toMatchObject({ result: "rss-import-published" });
  expect(value.commands).toHaveLength(count); expect(value.calls.every((call) => call.method === "GET")).toBe(true);
});
