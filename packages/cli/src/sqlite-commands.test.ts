import { afterEach, expect, test } from "bun:test";
import { parseEpisodeDraft, parseShowMetadata } from "@castloop/shared";
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

test("formal SQLite command runners resume, register, stage, publish and inspect without legacy paths", async () => {
  const value = await fixture();
  const site = "https://example.com/my-podcast";
  await value.command("create-show", ["daily", site]);
  await value.command("show-resume", ["daily", crypto.randomUUID()]);
  const directory = join(value.root, "daily"), showPath = join(directory, "show.toml");
  expect(parseShowMetadata(readFileSync(showPath, "utf8")).site_url).toBe(site);
  writeFileSync(join(directory, "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  expect(await value.command("update-show", ["daily"])).toMatchObject({ state: "staged" });
  expect(value.content.delivery("/podcasts/daily/feed.xml").status).toBe(404);
  expect(await value.command("publish-show", ["daily"])).toMatchObject({ state: "succeeded" });
  await value.command("create-episode", ["daily", "first"]);
  const episodePath = join(directory, "episode-first.toml"), original = parseEpisodeDraft(readFileSync(episodePath, "utf8"));
  expect(original.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(readFileSync(episodePath, "utf8")).toMatch(/published_at = "/);
  writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await value.command("update-episode", ["daily", "first"]);
  await value.command("update-episode-audio", ["daily", "first", "audio.mp3"]);
  const published = await value.command("publish-episode", ["daily", "first"]);
  expect(published).toMatchObject({ state: "succeeded" });
  const base = value.content.episodes("daily")[0];
  expect(base.guid).toBe(original.guid); expect(base.published_at).toBe(original.published_at);
  writeFileSync(episodePath, readFileSync(episodePath, "utf8").replace('title = "first"', 'title = "Updated first"'));
  value.calls.length = 0;
  await value.command("update-episode", ["daily", "first"]);
  expect(await value.command("job-status", [base.revision_id])).toMatchObject({ status: { state: "succeeded" }, snapshot_only: true, authorizes_recovery: false });
  expect(await value.command("publish-episode", ["daily", "first"])).toMatchObject({ state: "succeeded" });
  expect(value.content.episodes("daily")[0]).toMatchObject({ title: "Updated first", guid: base.guid, enclosure_url: base.enclosure_url });
  expect(value.calls.some((call) => call.method === "PUT" && call.path.endsWith("audio.mp3"))).toBe(false);
  expect(value.calls.some((call) => /queues|event_notifications|show-publications|system\/jobs/.test(call.path))).toBe(false);
  await value.command("show-pause", ["daily", crypto.randomUUID()]);
  expect(value.runtime.health()).toMatchObject({ state: "paused", drained: true });
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

test("unknown pause/resume outcomes are never resent or treated as recovery authority", async () => {
  const value = await fixture(), window = crypto.randomUUID();
  await value.command("create-show", ["daily", "https://example.com"]);
  value.faults.lost = "control";
  await expect(value.command("show-resume", ["daily", window])).rejects.toThrow();
  value.faults.lost = undefined; value.calls.length = 0;
  await expect(value.command("show-resume", ["daily", window])).rejects.toThrow("unknown");
  expect(value.calls).toEqual([]);
  expect(await value.command("show-status", ["daily"])).toMatchObject({ state: "open", admission_window_id: window });
});

test("unsupported SQLite commands fail explicitly without legacy fallback or remote mutations", async () => {
  const value = await fixture(); value.calls.length = 0;
  for (const command of ["deploy", "release-job", "retry-job", "lifecycle-execute", "import-rss"]) {
    await expect(value.command(command, [])).rejects.toThrow("no legacy fallback");
  }
  expect(value.calls).toEqual([]);
});
