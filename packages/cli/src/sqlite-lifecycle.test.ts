import { afterEach, expect, test } from "bun:test";
import { runSqliteCommand } from "./sqlite-commands";
import { sqliteLifecyclePlanSchema } from "./sqlite-lifecycle";
import { initializeSqliteService } from "./sqlite-initialization";
import { SqliteServiceClient } from "./sqlite-service-client";
import { administratorKey } from "./administrator-key";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const values: Array<Awaited<ReturnType<typeof sqliteServiceFixture>>> = [];
afterEach(() => { for (const value of values.splice(0)) value.close(); });
async function fixture() {
  const value = await sqliteServiceFixture(); values.push(value);
  await initializeSqliteService(value.root, value.config, crypto.randomUUID(), "source", value.options, { attempts: 2, delay: async () => {} });
  const command = (name: string, args: string[] = [], transport = value.transport) => runSqliteCommand(value.root, value.config, name, args,
    { transport, cloudflare: value.options });
  await command("create-show", ["daily", "https://example.com/podcast"]);
  writeFileSync(join(value.root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  await command("publish-show", ["daily"]);
  await command("create-episode", ["daily", "first"]);
  writeFileSync(join(value.root, "daily", "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await command("publish-episode", ["daily", "first", "audio.mp3"]);
  const preview = async (action: string, episode = true) => sqliteLifecyclePlanSchema.parse(await command(episode ? "preview-episode-lifecycle" : "preview-show-lifecycle",
    episode ? ["daily", "first", action] : ["daily", action]));
  const file = join(value.root, "reviewed-plan.json");
  return Object.assign(value, { command, preview, file });
}

test("formal lifecycle previews are read-only and execution restores only the saved snapshot", async () => {
  const value = await fixture(), base = value.content.inspect("daily", "first").base!;
  const path = join(value.root, "daily", "episode-first.toml");
  writeFileSync(path, readFileSync(path, "utf8").replace('title = "first"', 'title = "Unpublished local edit"'));
  value.calls.length = 0;
  const stop = await value.preview("unpublish");
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
  expect(JSON.stringify(stop)).not.toContain("Unpublished local edit");
  writeFileSync(value.file, JSON.stringify(stop));
  expect(await value.command("lifecycle-execute", [value.file, stop.request_sha256, "confirm"])).toMatchObject({ result: "changed" });
  const restore = await value.preview("restore"); writeFileSync(value.file, JSON.stringify(restore));
  expect(await value.command("lifecycle-execute", [value.file, restore.request_sha256, "confirm"])).toMatchObject({ result: "changed" });
  expect(value.content.inspect("daily", "first").base).toEqual(base);
  expect(value.content.delivery(new URL(base.enclosure_url).pathname).status).toBe(200);
  expect(readFileSync(path, "utf8")).toContain("Unpublished local edit");
});

test("lost lifecycle responses can be resubmitted as unchanged without a journal", async () => {
  const value = await fixture(), plan = await value.preview("unpublish"); writeFileSync(value.file, JSON.stringify(plan));
  const lost: typeof value.transport = async (input, init) => {
    const response = await value.transport(input, init);
    if (init?.method === "POST" && String(input).endsWith("/publish")) throw new Error("unconfirmed response");
    return response;
  };
  await expect(value.command("lifecycle-execute", [value.file, plan.request_sha256, "confirm"], lost)).rejects.toThrow("unknown");
  value.calls.length = 0;
  expect(await value.command("lifecycle-execute", [value.file, plan.request_sha256, "confirm"])).toMatchObject({ result: "unchanged" });
  expect(value.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});

test("lifecycle refuses changed hashes, deletion and unconfirmed requests and replays idempotently", async () => {
  const value = await fixture(), plan = await value.preview("unpublish"); writeFileSync(value.file, JSON.stringify(plan)); value.calls.length = 0;
  await expect(value.command("lifecycle-execute", [value.file, "f".repeat(64), "confirm"])).rejects.toThrow("reviewed plan");
  await expect(value.command("lifecycle-execute", [value.file, plan.request_sha256, "confirm-delete-retain-records"])).rejects.toThrow("confirm");
  await expect(value.preview("delete")).rejects.toThrow("deletion");
  expect(value.calls).toEqual([]);

  expect(await value.command("lifecycle-execute", [value.file, plan.request_sha256, "confirm"])).toMatchObject({ result: "changed" });
  value.calls.length = 0;
  expect(await value.command("lifecycle-execute", [value.file, plan.request_sha256, "confirm"])).toMatchObject({ result: "unchanged" });
});

test("catalog client accepts bounded pages of escaped Unicode titles above the publication body limit", async () => {
  const value = await fixture();
  for (let index = 0; index < 20; index++) {
    const id = `unicode-${index}`;
    await value.command("create-show", [id, "https://example.com"]);
    const storage = value.nodes.get(id)!.fixture.storage;
    storage.sql.exec("UPDATE publication_shows SET lifecycle = 'published' WHERE show_id = ?", id);
    storage.sql.exec("INSERT INTO publication_show_content VALUES (?, ?, 'jpg', 1, ?, 4)", id, JSON.stringify({ title: "\u0001あ".repeat(100) }), "a".repeat(64));
  }
  const client = new SqliteServiceClient(value.config, administratorKey(value.root), value.transport);
  const page = await client.catalog({ kind: "show", include_deleted: false });
  expect(page.shows).toHaveLength(20); expect(Buffer.byteLength(JSON.stringify(page))).toBeGreaterThan(16384);
});
