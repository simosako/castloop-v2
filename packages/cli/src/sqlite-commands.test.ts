import { afterEach, expect, test } from "bun:test";
import { parseEpisodeDraft, parseShowMetadata, stringifyToml } from "@castloop/shared";
import { runSqliteCommand } from "./sqlite-commands";
import { initializeSqliteService } from "./sqlite-initialization";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });
async function fixture() {
  const value = await sqliteServiceFixture(); values.push(value);
  await initializeSqliteService(value.root, value.config, crypto.randomUUID(), "worker source", value.options, { attempts: 2, delay: async () => {} });
  const command = (name: string, args: string[] = []) => runSqliteCommand(value.root, value.config, name, args,
    { transport: value.transport, cloudflare: value.options });
  return Object.assign(value, { command });
}

test("formal SQLite commands publish local inputs directly without staging or legacy paths", async () => {
  const value = await fixture();
  const site = "https://example.com/my-podcast";
  await value.command("create-show", ["daily", site]);
 
  const directory = join(value.root, "daily"), showPath = join(directory, "show.toml");
  expect(parseShowMetadata(readFileSync(showPath, "utf8")).site_url).toBe(site);
  writeFileSync(join(directory, "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  await value.command("preview-show", ["daily"]);
  expect(value.content.delivery("/podcasts/daily/feed.xml").status).toBe(404);
  expect(await value.command("publish-show", ["daily"])).toMatchObject({ result: "changed" });
  await value.command("create-episode", ["daily", "first"]);
  const episodePath = join(directory, "episode-first.toml"), original = parseEpisodeDraft(readFileSync(episodePath, "utf8"));
  expect(original.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(readFileSync(episodePath, "utf8")).toMatch(/published_at = "/);
  writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  const published = await value.command("publish-episode", ["daily", "first", "audio.mp3"]);
  expect(published).toMatchObject({ result: "changed" });
  const base = value.content.episodes("daily")[0];
  expect(base.guid).toBe(original.guid); expect(base.published_at).toBe(original.published_at);
  writeFileSync(episodePath, readFileSync(episodePath, "utf8").replace('title = "first"', 'title = "Updated first"'));
  value.calls.length = 0;
  expect(await value.command("publish-episode", ["daily", "first"])).toMatchObject({ result: "changed" });
  expect(value.content.episodes("daily")[0]).toMatchObject({ title: "Updated first", guid: base.guid, enclosure_url: base.enclosure_url });
  expect(value.calls.some((call) => call.method === "PUT" && call.path.endsWith("audio.mp3"))).toBe(false);
  expect(value.calls.some((call) => /queues|event_notifications|show-publications|system\/jobs/.test(call.path))).toBe(false);
 
  expect(value.runtime.health()).toMatchObject({ publication_ready: true });
});

test("publish-episode requires explicit future published_at approval through command options", async () => {
  const value = await fixture();
  await value.command("create-show", ["daily", "https://example.com"]);
 
  const directory = join(value.root, "daily");
  writeFileSync(join(directory, "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  await value.command("publish-show", ["daily"]);
  await value.command("create-episode", ["daily", "future"]);
  const episodePath = join(directory, "episode-future.toml"), draft = parseEpisodeDraft(readFileSync(episodePath, "utf8"));
  writeFileSync(episodePath, stringifyToml({ ...draft, published_at: "2099-01-01T00:00:00Z" }));
  writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  const preview = await value.command("preview-episode", ["daily", "future", "audio.mp3"]) as {
    warnings: Array<{ code: string; published_at: string }>; input_fingerprint: string };
  expect(preview.warnings).toMatchObject([{ code: "future_published_at", published_at: "2099-01-01T00:00:00Z" }]);
  const posts = value.calls.filter((call) => call.method === "POST").length;
  await expect(value.command("publish-episode", ["daily", "future", "audio.mp3"])).rejects.toThrow("future");
  expect(value.calls.filter((call) => call.method === "POST").length).toBe(posts);
  expect(value.content.episodes("daily")).toHaveLength(0);
  expect(await runSqliteCommand(value.root, value.config, "publish-episode", ["daily", "future", "audio.mp3"], {
    transport: value.transport, cloudflare: value.options, allowFuturePublishedAt: true,
    expectedPreview: preview.input_fingerprint })).toMatchObject({ result: "changed" });
  expect(value.content.episodes("daily")[0]).toMatchObject({ title: "future", published_at: "2099-01-01T00:00:00Z" });
});

test("a lost registration response is inspected without resending and advanced Shows are never recreated", async () => {
  const value = await fixture();
  value.faults.lost = "register";
  await expect(value.command("create-show", ["daily", "https://example.com"])).rejects.toThrow();
  value.faults.lost = undefined;
  await value.command("create-show", ["daily", "https://example.com"]);
  expect(value.calls.filter((call) => call.method === "POST" && call.path.endsWith("register-show"))).toHaveLength(1);
  value.storage.sql.exec("UPDATE publication_shows SET lifecycle = 'deleted' WHERE show_id = 'daily'");
  await expect(value.command("create-show", ["daily", "https://example.com"])).rejects.toThrow("advanced/deleted");
});

test("unsupported SQLite commands fail explicitly without legacy fallback or remote mutations", async () => {
  const value = await fixture(); value.calls.length = 0;
  for (const command of ["deploy", "release-job", "retry-job", "lifecycle-execute", "import-rss", "show-pause", "show-resume"]) {
    await expect(value.command(command, [])).rejects.toThrow();
  }
  expect(value.calls).toEqual([]);
});
