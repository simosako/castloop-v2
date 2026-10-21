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
  await command("create-show", ["daily", "https://example.com/podcast"]); await command("show-resume", ["daily", crypto.randomUUID()]);
  writeFileSync(join(value.root, "daily", "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  await command("update-show", ["daily"]); await command("publish-show", ["daily"]);
  await command("create-episode", ["daily", "first"]);
  writeFileSync(join(value.root, "daily", "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await command("update-episode", ["daily", "first"]); await command("update-episode-audio", ["daily", "first", "audio.mp3"]);
  await command("publish-episode", ["daily", "first"]);
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
  expect(await value.command("lifecycle-execute", [value.file, stop.request_sha256, "confirm"])).toMatchObject({ state: "queued" });
  expect(await value.command("job-status", [stop.request.job_id])).toMatchObject({ snapshot_only: true, authorizes_recovery: false, status: { state: "succeeded" } });
  expect(await value.command("operation-status", ["lifecycle", stop.request.job_id])).toMatchObject({ status: { state: "succeeded" } });
  const restore = await value.preview("restore"); writeFileSync(value.file, JSON.stringify(restore));
  expect(await value.command("lifecycle-execute", [value.file, restore.request_sha256, "confirm"])).toMatchObject({ state: "queued" });
  expect(await value.command("job-status", [restore.request.job_id])).toMatchObject({ status: { state: "succeeded" } });
  expect(value.content.inspect("daily", "first").base).toEqual(base);
  expect(value.content.delivery(new URL(base.enclosure_url).pathname).status).toBe(200);
  expect(readFileSync(path, "utf8")).toContain("Unpublished local edit");
});

test("lost lifecycle submit responses retain one identity and repeated execution only reads status", async () => {
  const value = await fixture(), plan = await value.preview("unpublish"); writeFileSync(value.file, JSON.stringify(plan));
  const lost: typeof value.transport = async (input, init) => {
    const response = await value.transport(input, init);
    if (init?.method === "POST" && String(input).endsWith("/jobs")) throw new Error("unconfirmed response");
    return response;
  };
  await expect(value.command("lifecycle-execute", [value.file, plan.request_sha256, "confirm"], lost)).rejects.toThrow("unknown");
  value.calls.length = 0;
  expect(await value.command("lifecycle-execute", [value.file, plan.request_sha256, "confirm"])).toMatchObject({ state: "succeeded" });
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
});

test("lifecycle refuses changed hashes, deletion, unconfirmed requests and stale resume windows without replay", async () => {
  const value = await fixture(), plan = await value.preview("unpublish"); writeFileSync(value.file, JSON.stringify(plan)); value.calls.length = 0;
  await expect(value.command("lifecycle-execute", [value.file, "f".repeat(64), "confirm"])).rejects.toThrow("reviewed hash");
  await expect(value.command("lifecycle-execute", [value.file, plan.request_sha256, "confirm-delete-retain-records"])).rejects.toThrow("confirm");
  await expect(value.preview("delete")).rejects.toThrow("unregistered upload");
  expect(value.calls).toEqual([]);
  await value.command("show-pause", ["daily", crypto.randomUUID()]); await value.command("show-resume", ["daily", crypto.randomUUID()]);
  await expect(value.command("lifecycle-execute", [value.file, plan.request_sha256, "confirm"])).rejects.toThrow("HTTP 503");
  value.calls.length = 0;
  expect(await value.command("lifecycle-execute", [value.file, plan.request_sha256, "confirm"])).toBe(null);
  expect(value.calls.every((call) => call.method === "GET")).toBe(true);
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
