import { afterEach, expect, test } from "bun:test";
import { parseEpisodeDraft, parseShowMetadata, stringifyToml } from "@castloop/shared";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import { administratorKey } from "./administrator-key";
import { SqliteServiceClient } from "./sqlite-service-client";
import { draftPreview } from "./draft-preview";
import { previewRevision, executeRevision, syncLocalMetadata, readRevisionPlanFile } from "./sqlite-revision-commands";
import { exportPreviewRss } from "./preview-rss";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const close: Array<() => void> = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });
async function fixture() {
  const f = await sqliteServiceFixture(); close.push(f.close);
  await initializeSqliteService(f.root, f.config, crypto.randomUUID(), "source", f.options, { attempts: 2, delay: async () => {} });
  const run = (name: string, args: string[], transport = f.transport) =>
    runSqliteCommand(f.root, f.config, name, args, { cloudflare: f.options, transport });
  await run("create-show", ["daily", "https://example.com/podcast"]);
 
  const showFile = join(f.root, "daily", "show.toml"), file = join(f.root, "daily", "episode-first.toml");
  const coverFile = join(f.root, "daily", "cover.jpg"), audioFile = join(f.root, "daily", "audio.mp3");
  writeFileSync(coverFile, Buffer.from([255, 216, 255, 2]));
  await run("publish-show", ["daily"]); await run("create-episode", ["daily", "first"]);
  writeFileSync(audioFile, Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await run("publish-episode", ["daily", "first", "audio.mp3"]);
  const key = administratorKey(f.root), client = new SqliteServiceClient(f.config, key, f.transport);
  const target = { kind: "episode" as const, show_id: "daily", episode_id: "first" };
  const preview = (audio = false) => draftPreview(f.root, f.config, { ...target, ...(audio ? { audio_path: "audio.mp3" } : {}) }, { client });
  const edit = (title: string) => writeFileSync(file, stringifyToml({ ...parseEpisodeDraft(readFileSync(file, "utf8")), title }));
  return { ...f, run, client, key, file, showFile, coverFile, audioFile, target, preview, edit, node: f.nodes.get("daily")! };
}

test("remote preview compares editable local metadata and concrete published audio without writes", async () => {
  const f = await fixture(); f.edit("Reviewed edit");
  const before = readdirSync(join(f.root, ".castloop"), { recursive: true }); f.calls.length = 0;
  const preview = await f.preview();
  expect(preview.changes.metadata_fields?.find((item) => item.field === "title")).toMatchObject({ changed: true, candidate: "Reviewed edit" });
  expect(preview.changes.identity_status).toBe("preserved"); expect(preview.changes.audio.mode).toBe("reuse_published");
  expect(preview.publishable).toBe(true); expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  expect(readdirSync(join(f.root, ".castloop"), { recursive: true })).toEqual(before);
  f.edit("Further local edit"); expect((await f.preview()).local.metadata.title).toBe("Further local edit");
});

for (const kind of ["metadata", "audio", "both"] as const) {
  test(`reviewed ${kind} update preserves GUID/date and selects the displayed audio`, async () => {
    const f = await fixture(), before = (await f.client.content("daily", "first")).episode_content!;
    if (kind !== "audio") f.edit("New metadata");
    if (kind !== "metadata") writeFileSync(f.audioFile, Buffer.concat([readFileSync(f.audioFile), readFileSync(f.audioFile)]));
    const preview = await f.preview(kind !== "metadata"), args = ["daily", "first", ...(kind === "metadata" ? [] : ["audio.mp3"])];
    expect(await runSqliteCommand(f.root, f.config, "publish-episode", args,
      { transport: f.transport, cloudflare: f.options, expectedPreview: preview.input_fingerprint })).toMatchObject({ result: "changed" });
    const after = (await f.client.content("daily", "first")).episode_content!;
    expect(after.metadata.guid).toBe(before.metadata.guid); expect(after.metadata.published_at).toBe(before.metadata.published_at);
    expect(after.audio.sha256).toBe(preview.changes.audio.candidate!.sha256);
    expect(after.audio.enclosure_url === before.audio.enclosure_url).toBe(kind === "metadata");
  });
}

test("same-content MP3 is unchanged and changed local identity is not publishable", async () => {
  const f = await fixture(); expect((await f.preview(true)).unchanged).toBe(true);
  writeFileSync(f.file, stringifyToml({ ...parseEpisodeDraft(readFileSync(f.file, "utf8")), guid: "different-guid" }));
  expect((await f.preview()).changes.identity_status).toBe("changed_invalid"); expect((await f.preview()).publishable).toBe(false);
});

test("Show preview compares local cover and rejects changing the published extension", async () => {
  const f = await fixture();
  writeFileSync(f.showFile, stringifyToml({ ...parseShowMetadata(readFileSync(f.showFile, "utf8")), copyright: "New copyright" }));
  writeFileSync(f.coverFile, Buffer.from([255, 216, 255, 3]));
  const preview = await draftPreview(f.root, f.config, { kind: "show", show_id: "daily" }, { client: f.client });
  expect(preview.changes.cover.candidate!.sha256).not.toBe(preview.changes.cover.published!.sha256); expect(preview.publishable).toBe(true);
  writeFileSync(join(f.root, "daily", "cover.png"), Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));
  writeFileSync(f.showFile, stringifyToml({ ...parseShowMetadata(readFileSync(f.showFile, "utf8")), image_path: "cover.png" }));
  expect((await draftPreview(f.root, f.config, { kind: "show", show_id: "daily" }, { client: f.client })).publishable).toBe(false);
});

test("local preview never requests content; invalid remote content cannot become an empty diff", async () => {
  const f = await fixture(); f.calls.length = 0;
  const local = await draftPreview(f.root, f.config, f.target, { mode: "local" });
  expect(local.published.status).toBe("not_checked"); expect(local.changes.metadata_fields).toBeNull(); expect(f.calls).toEqual([]);
  const tamper: typeof f.transport = async (input, init) => {
    const response = await f.transport(input, init);
    if (!String(input).includes("/content/")) return response;
    const content = await response.json() as { episode_content: { metadata_sha256: string } };
    content.episode_content.metadata_sha256 = "f".repeat(64);
    return Response.json(content, { headers: { "Cache-Control": "no-store" } });
  };
  await expect(draftPreview(f.root, f.config, f.target, { client: new SqliteServiceClient(f.config, f.key, tamper) })).rejects.toThrow("hash differs");
});

test("revision adoption reuses saved audio and history, preserves local originals and handles lost responses as no-op", async () => {
  const f = await fixture(), old = (await f.client.content("daily", "first")).episode_content!;
  f.edit("Mistake"); await f.run("publish-episode", ["daily", "first"]);
  const original = readFileSync(f.file), preview = await previewRevision(f.config, f.key, "daily", old.revision_id, "first", f.transport);
  const lost: typeof f.transport = async (input, init) => {
    const response = await f.transport(input, init);
    if (init?.method === "POST" && String(input).endsWith("/publish")) throw new Error("lost reply");
    return response;
  };
  await expect(executeRevision(f.root, f.config, f.key, preview, preview.plan!.request_sha256, "confirm", lost)).rejects.toThrow();
  expect(await executeRevision(f.root, f.config, f.key, preview, preview.plan!.request_sha256, "confirm", f.transport)).toMatchObject({ result: "unchanged" });
  const current = (await f.client.content("daily", "first")).episode_content!;
  expect(current.metadata).toEqual(old.metadata); expect(current.audio).toEqual(old.audio); expect(current.restored_from_revision_id).toBe(old.revision_id);
  expect((await f.client.revisions("daily", "first")).episode_revisions).toHaveLength(3); expect(readFileSync(f.file)).toEqual(original);
  await expect(syncLocalMetadata(f.root, f.config, f.key, "daily", current.revision_id, "first", undefined, f.transport)).rejects.toThrow();
  const output = join(f.root, "exported.toml"); await syncLocalMetadata(f.root, f.config, f.key, "daily", current.revision_id, "first", output, f.transport);
  expect(parseEpisodeDraft(readFileSync(output, "utf8"))).toEqual(old.metadata);
});

test("Show revision restores only its saved cover, not Episodes, without uploading material", async () => {
  const f = await fixture(), old = (await f.client.content("daily")).show_content!;
  writeFileSync(f.coverFile, Buffer.from([255, 216, 255, 4])); await f.run("publish-show", ["daily"]);
  const episodes = f.node.service.content.episodes("daily"), preview = await previewRevision(f.config, f.key, "daily", old.revision_id, undefined, f.transport);
  f.calls.length = 0;
  expect(await executeRevision(f.root, f.config, f.key, preview, preview.plan!.request_sha256, "confirm", f.transport)).toMatchObject({ result: "changed" });
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
  expect((await f.client.content("daily")).show_content!.cover.sha256).toBe(old.cover.sha256); expect(f.node.service.content.episodes("daily")).toEqual(episodes);
});

test("history pages newest first and stay private while revision previews stay read-only", async () => {
  const f = await fixture();
  for (let i = 0; i < 21; i++) { f.edit(`Revision ${i}`); await f.run("publish-episode", ["daily", "first"]); }

  const first = await f.client.revisions("daily", "first"), second = await f.client.revisions("daily", "first", String(first.next_cursor));
  expect(first.episode_revisions).toHaveLength(20); expect(second.episode_revisions).toHaveLength(2); expect(second.next_cursor).toBeNull();
  const http = f.node.service.fetch.bind(f.node.service);
  expect((await http(new Request(`${f.config.workers_dev_base_url}/admin/sqlite-service/content/daily/first`, { headers: { "X-Castloop-Show-Id": "daily" } }))).status).toBe(401);
  const plan = await previewRevision(f.config, f.key, "daily", second.episode_revisions![0]!.revision_id, "first", f.transport);
  expect(plan.plan).not.toBeNull();
  expect(plan.plan!.request.base_revision_id).toBe(first.episode_revisions![0]!.revision_id);
  expect(plan.resulting_lifecycle).toBe("published");
});

test("RSS export renders local changes without publishing or overwriting", async () => {
  const f = await fixture(); f.edit("RSS preview"); const preview = await f.preview(), output = join(f.root, "preview.xml"); f.calls.length = 0;
  expect(await exportPreviewRss(f.root, f.config, preview, f.client, output)).toMatchObject({ status: "generated_locally", episode_count: 1 });
  expect(readFileSync(output, "utf8")).toContain("RSS preview"); expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  await expect(exportPreviewRss(f.root, f.config, preview, f.client, output)).rejects.toThrow();
  expect((await f.client.content("daily", "first")).episode_content!.metadata.title).not.toBe("RSS preview");
});

test("builtin RSS preview selects collision-safe page IDs without reserving or publishing", async () => {
  const f = await fixture(), { site_url, ...show } = parseShowMetadata(readFileSync(f.showFile, "utf8"));
  writeFileSync(f.showFile, stringifyToml({ ...show, site_mode: "builtin" })); await f.run("publish-show", ["daily"]);
  await f.run("create-episode", ["daily", "next"]);
  const hash = createHash("sha256").update("next").digest("hex");
  f.node.fixture.storage.sql.exec("INSERT INTO publication_site_ids (show_id, episode_id, site_id) VALUES (?, ?, ?)", "daily", "reserved", hash.slice(0, 16));
  const target = { kind: "episode" as const, show_id: "daily", episode_id: "next", audio_path: "audio.mp3" };
  const preview = await draftPreview(f.root, f.config, target, { client: f.client }), before = f.node.service.content.sites.ids.all("daily");
  const output = join(f.root, "short-preview.xml"); await exportPreviewRss(f.root, f.config, preview, f.client, output);
  expect(readFileSync(output, "utf8")).toContain(`/podcasts/daily/${hash.slice(0, 20)}/`);
  expect(f.node.service.content.sites.ids.all("daily")).toEqual(before); expect(f.node.service.content.inspect("daily", "next").episode).toBeNull();
  await f.run("publish-episode", ["daily", "next", "audio.mp3"]); expect(f.node.service.content.sites.ids.get("daily", "next")).toBe(hash.slice(0, 20));
});

test("invalid revision JSON does not echo private input", async () => {
  const f = await fixture(), file = join(f.root, "invalid-plan.json"); writeFileSync(file, "{private-plan-content");
  expect(() => readRevisionPlanFile(file)).toThrow("Revision plan JSON is unreadable, invalid or exceeds its read budget");
});
