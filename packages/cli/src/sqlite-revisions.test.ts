import { afterEach, expect, test } from "bun:test";
import { parseEpisodeDraft, parseShowMetadata, stringifyToml } from "@castloop/shared";
import { sqliteRevisionPlanSchema } from "../../shared/src/sqlite-revisions";
import { initializeSqliteService } from "./sqlite-initialization";
import { runSqliteCommand } from "./sqlite-commands";
import { administratorKey } from "./administrator-key";
import { SqliteServiceClient } from "./sqlite-service-client";
import { draftPreview } from "./draft-preview";
import { previewRevision, executeRevision, syncLocalMetadata, readRevisionPlanFile, revisionProgress } from "./sqlite-revision-commands";
import { exportPreviewRss } from "./preview-rss";
import { progressResultSchema } from "./progress";
import { watchResultSchema, watchSqliteJob } from "./watch";
import { sqliteServiceFixture } from "./test-support/sqlite-service";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const close: Array<() => void> = [];
afterEach(() => { for (const cleanup of close.splice(0)) cleanup(); });
async function fixture() {
  const f = await sqliteServiceFixture(); close.push(f.close);
  await initializeSqliteService(f.root, f.config, crypto.randomUUID(), "source", f.options, { attempts: 2, delay: async () => {} });
  const run = (name: string, args: string[], root = f.root, transport = f.transport) =>
    runSqliteCommand(root, f.config, name, args, { cloudflare: f.options, transport });
  await run("create-show", ["daily", "https://example.com/podcast"]);
  await run("show-resume", ["daily", crypto.randomUUID()]);
  const showFile = join(f.root, "daily", "show.toml"), file = join(f.root, "daily", "episode-first.toml");
  const coverFile = join(f.root, "daily", "cover.jpg"), audioFile = join(f.root, "daily", "audio.mp3");
  writeFileSync(coverFile, Buffer.from([255, 216, 255, 2]));
  await run("update-show", ["daily"]); await run("publish-show", ["daily"]);
  await run("create-episode", ["daily", "first"]);
  writeFileSync(audioFile, Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  await run("update-episode", ["daily", "first"]); await run("update-episode-audio", ["daily", "first", "audio.mp3"]);
  await run("publish-episode", ["daily", "first"]);
  const key = administratorKey(f.root), client = new SqliteServiceClient(f.config, key, f.transport);
  const target = { kind: "episode" as const, show_id: "daily", episode_id: "first" };
  const preview = (show = false) => draftPreview(f.root, f.config, show ? { kind: "show", show_id: "daily" } : target, undefined, { client });
  const edit = (title: string) => writeFileSync(file, stringifyToml({ ...parseEpisodeDraft(readFileSync(file, "utf8")), title }));
  const node = f.nodes.get("daily")!;
  return { ...f, run, client, key, file, showFile, coverFile, audioFile, target, preview, edit, node };
}

test("remote preview distinguishes published/local/staged metadata and reuse without writes", async () => {
  const f = await fixture();
  f.edit("Reviewed edit"); await f.run("update-episode", ["daily", "first"]);
  const before = readdirSync(join(f.root, ".castloop"), { recursive: true }); f.calls.length = 0;
  const preview = await f.preview();
  expect(preview.published.status).toBe("checked");
  expect(preview.changes.metadata_fields?.find((item) => item.field === "title")).toMatchObject({ changed: true, candidate: "Reviewed edit" });
  expect(preview.changes.identity_status).toBe("preserved");
  expect(preview.changes.audio.mode).toBe("reuse_published");
  expect(preview.publishable).toBe(true);
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  expect(readdirSync(join(f.root, ".castloop"), { recursive: true })).toEqual(before);
  f.edit("Not staged");
  const mismatch = await f.preview();
  expect(mismatch.staged.metadata).toBeNull(); expect(mismatch.changes.metadata_fields).toBeNull();
  expect(mismatch.changes.local_fields?.find((item) => item.field === "title")?.candidate).toBe("Not staged");
  expect(mismatch.publishable).toBe(false);
  await expect(f.run("publish-episode", ["daily", "first"], f.root)).rejects.toThrow("differs");
});

for (const kind of ["metadata", "audio", "both"] as const) {
  test(`reviewed ${kind} update binds full remote base and produces the displayed audio identity`, async () => {
    const f = await fixture(), before = await f.client.content("daily", "first");
    if (kind !== "audio") { f.edit("New metadata"); await f.run("update-episode", ["daily", "first"]); }
    if (kind !== "metadata") {
      writeFileSync(f.audioFile, Buffer.concat([readFileSync(f.audioFile), readFileSync(f.audioFile)]));
      await f.run("update-episode-audio", ["daily", "first", "audio.mp3"]);
    }
    const preview = await f.preview();
    expect(preview.changes.audio.mode).toBe(kind === "metadata" ? "reuse_published" : "replace_audio");
    const result = await runSqliteCommand(f.root, f.config, "publish-episode", ["daily", "first"],
      { transport: f.transport, cloudflare: f.options, expectedPreview: preview.input_fingerprint });
    expect(result).toMatchObject({ state: "succeeded" });
    const after = await f.client.content("daily", "first");
    expect(after.episode_content!.metadata.guid).toBe(before.episode_content!.metadata.guid);
    expect(after.episode_content!.metadata.published_at).toBe(before.episode_content!.metadata.published_at);
    expect(after.episode_content!.audio.sha256).toBe(kind === "metadata" ? before.episode_content!.audio.sha256 : preview.changes.audio.candidate!.sha256);
  });
}

test("audio-only preview rejects a changed local identity and reports same-content reupload", async () => {
  const f = await fixture(); await f.run("update-episode-audio", ["daily", "first", "audio.mp3"]);
  expect((await f.preview()).changes.audio.mode).toBe("replace_audio_same_content");
  const metadata = parseEpisodeDraft(readFileSync(f.file, "utf8"));
  writeFileSync(f.file, stringifyToml({ ...metadata, guid: "different-guid" }));
  const preview = await f.preview();
  expect(preview.changes.identity_status).toBe("changed_invalid"); expect(preview.publishable).toBe(false);
});

test("Show preview compares images and optional metadata; stale stage and extension change are not publishable", async () => {
  const f = await fixture();
  writeFileSync(f.showFile, stringifyToml({ ...parseShowMetadata(readFileSync(f.showFile, "utf8")), copyright: "New copyright", show_type: "serial" }));
  writeFileSync(f.coverFile, Buffer.from([255, 216, 255, 3])); await f.run("update-show", ["daily"]);
  const preview = await f.preview(true);
  expect(preview.changes.cover.content_changed).toBe(true);
  expect(preview.changes.metadata_fields?.find((field) => field.field === "copyright")?.changed).toBe(true);
  expect(preview.publishable).toBe(true);
  writeFileSync(f.showFile, stringifyToml({ ...parseShowMetadata(readFileSync(f.showFile, "utf8")), image_path: "cover.png" }));
  expect((await f.preview(true)).changes.identity_status).toBe("changed_invalid");
});

test("local-only preview never requests remote content and cannot label an unknown base unchanged", async () => {
  const f = await fixture(); f.calls.length = 0;
  const preview = await draftPreview(f.root, f.config, f.target, undefined, { mode: "local" });
  expect(preview.published.status).toBe("not_checked"); expect(preview.changes.metadata_fields).toBeNull();
  expect(preview.publishable).toBeNull(); expect(f.calls).toEqual([]);
  const bad = new SqliteServiceClient(f.config, "wrong-key", f.transport);
  await expect(draftPreview(f.root, f.config, f.target, undefined, { client: bad })).rejects.toThrow();
});

test("parallel publication, lifecycle ABA and material edits invalidate reviewed preview", async () => {
  for (const change of ["parallel", "lifecycle", "audio", "metadata"] as const) {
    const f = await fixture(); f.edit("Reviewed"); await f.run("update-episode", ["daily", "first"]);
    const preview = await f.preview();
    if (change === "parallel") {
      const root = mkdtempSync("/tmp/opencode/castloop-other-review-"); close.push(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, ".castloop"), { mode: 0o700 }); mkdirSync(join(root, "daily"), { mode: 0o700 });
      copyFileSync(join(f.root, ".castloop", "secrets.json"), join(root, ".castloop", "secrets.json"));
      copyFileSync(f.file, join(root, "daily", "episode-first.toml"));
      await f.run("update-episode", ["daily", "first"], root); await f.run("publish-episode", ["daily", "first"], root);
    } else if (change === "lifecycle") {
      const hide = await f.run("preview-episode-lifecycle", ["daily", "first", "unpublish"]) as { request_sha256: string };
      const file = join(f.root, "hide.json"); writeFileSync(file, JSON.stringify(hide));
      await f.run("lifecycle-execute", [file, hide.request_sha256, "confirm"]);
      const restore = await f.run("preview-episode-lifecycle", ["daily", "first", "restore"]) as { request_sha256: string };
      writeFileSync(file, JSON.stringify(restore)); await f.run("lifecycle-execute", [file, restore.request_sha256, "confirm"]);
    } else if (change === "audio") {
      writeFileSync(f.audioFile, Buffer.concat([readFileSync(f.audioFile), readFileSync(f.audioFile)]));
      await f.run("update-episode-audio", ["daily", "first", "audio.mp3"]);
    } else f.edit("Edited after review");
    f.calls.length = 0;
    await expect(runSqliteCommand(f.root, f.config, "publish-episode", ["daily", "first"],
      { transport: f.transport, cloudflare: f.options, expectedPreview: preview.input_fingerprint })).rejects.toThrow("Reviewed");
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  }
});

test("revision adoption reuses saved audio, appends history, keeps originals and observes a lost submit without replay", async () => {
  const f = await fixture(), old = (await f.client.content("daily", "first")).episode_content!;
  f.edit("Mistake"); await f.run("update-episode", ["daily", "first"]); await f.run("publish-episode", ["daily", "first"]);
  const original = readFileSync(f.file);
  const before = readdirSync(join(f.root, ".castloop"), { recursive: true });
  const preview = await previewRevision(f.config, f.key, "daily", old.revision_id, "first", f.transport);
  expect(preview.assets.mode).toBe("reuse_saved_audio"); expect(preview.executable).toBe(true);
  expect(readdirSync(join(f.root, ".castloop"), { recursive: true })).toEqual(before);
  const plan = sqliteRevisionPlanSchema.parse(preview.plan);
  let sent = 0;
  const lost: typeof f.transport = async (input, init) => {
    const response = await f.transport(input, init);
    if (init?.method === "POST" && String(input).endsWith("/jobs")) { sent++; throw new Error("lost reply"); }
    return response;
  };
  await expect(executeRevision(f.root, f.config, f.key, preview, plan.request_sha256, "confirm", lost)).rejects.toThrow();
  const planFile = join(f.root, "revision-plan.json"); writeFileSync(planFile, JSON.stringify(preview));
  expect(await revisionProgress(f.root, f.config, planFile)).toEqual({ job_id: plan.request.job_id, state: "unknown",
    publication_requested: true, last_known_only: true });
  f.calls.length = 0;
  expect(await executeRevision(f.root, f.config, f.key, preview, plan.request_sha256, "confirm", f.transport)).toMatchObject({ state: "succeeded" });
  expect(await revisionProgress(f.root, f.config, planFile)).toMatchObject({ job_id: plan.request.job_id, state: "succeeded", last_known_only: true });
  expect(sent).toBe(1); expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  const current = (await f.client.content("daily", "first")).episode_content!;
  expect(current.revision_id).toBe(plan.request.job_id); expect(current.metadata).toEqual(old.metadata);
  expect(current.audio).toEqual(old.audio); expect(current.restored_from_revision_id).toBe(old.revision_id);
  expect((await f.client.revisions("daily", "first")).episode_revisions).toHaveLength(3);
  expect(readFileSync(f.file)).toEqual(original);
  expect(await f.run("job-status", [plan.request.job_id])).toMatchObject({ status: { state: "succeeded" } });
  await expect(syncLocalMetadata(f.root, f.config, f.key, "daily", current.revision_id, "first", undefined, f.transport)).rejects.toThrow();
  const output = join(f.root, "exported.toml");
  await syncLocalMetadata(f.root, f.config, f.key, "daily", current.revision_id, "first", output, f.transport);
  expect(parseEpisodeDraft(readFileSync(output, "utf8"))).toEqual(old.metadata);
});

test("Show adoption selects an old cover, does not roll back Episodes and never uploads material", async () => {
  const f = await fixture(), old = (await f.client.content("daily")).show_content!;
  writeFileSync(f.coverFile, Buffer.from([255, 216, 255, 4])); await f.run("update-show", ["daily"]); await f.run("publish-show", ["daily"]);
  const episodes = f.node.service.content.episodes("daily");
  const preview = await previewRevision(f.config, f.key, "daily", old.revision_id, undefined, f.transport);
  f.calls.length = 0;
  expect(await executeRevision(f.root, f.config, f.key, preview, preview.plan!.request_sha256, "confirm", f.transport)).toMatchObject({ state: "succeeded" });
  expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
  expect((await f.client.content("daily")).show_content!.cover).toEqual(old.cover);
  expect(f.node.service.content.episodes("daily")).toEqual(episodes);
});

test("history paging is newest-first, read-only while paused and private without authentication", async () => {
  const f = await fixture();
  for (let i = 0; i < 21; i++) { f.edit(`Revision ${i}`); await f.run("update-episode", ["daily", "first"]); await f.run("publish-episode", ["daily", "first"]); }
  await f.run("show-pause", ["daily", crypto.randomUUID()]);
  const first = await f.client.revisions("daily", "first"), second = await f.client.revisions("daily", "first", String(first.next_cursor));
  expect(first.episode_revisions).toHaveLength(20); expect(second.episode_revisions).toHaveLength(2);
  expect(first.episode_revisions![0]!.is_current).toBe(true); expect(second.next_cursor).toBeNull();
  const http = f.node.service.fetch.bind(f.node.service);
  expect((await http(new Request(`${f.config.workers_dev_base_url}/admin/sqlite-service/content/daily/first`,
    { headers: { "X-Castloop-Show-Id": "daily" } }))).status).toBe(401);
  expect((await http(new Request(`${f.config.workers_dev_base_url}/admin/sqlite-service/content/other/first`,
    { headers: { "X-Castloop-Key": f.key, "X-Castloop-Show-Id": "daily" } }))).status).toBe(409);
  expect((await previewRevision(f.config, f.key, "daily", second.episode_revisions![0]!.revision_id, "first", f.transport)).plan).toBeNull();
});

test("RSS export uses local renderer and a generation-bound inventory, never publishes or overwrites", async () => {
  const f = await fixture(); f.edit("RSS preview"); await f.run("update-episode", ["daily", "first"]);
  const preview = await f.preview(), output = join(f.root, "preview.xml"); f.calls.length = 0;
  expect(await exportPreviewRss(f.root, f.config, preview, f.client, output)).toMatchObject({ status: "generated_locally", episode_count: 1 });
  expect(readFileSync(output, "utf8")).toContain("RSS preview");
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  await expect(exportPreviewRss(f.root, f.config, preview, f.client, output)).rejects.toThrow();
  expect((await f.client.content("daily", "first")).episode_content!.metadata.title).not.toBe("RSS preview");
});

test("builtin RSS preview uses stored page IDs and an unreserved collision-safe candidate without publishing", async () => {
  const f = await fixture();
  const { site_url, ...show } = parseShowMetadata(readFileSync(f.showFile, "utf8"));
  writeFileSync(f.showFile, stringifyToml({ ...show, site_mode: "builtin" }));
  await f.run("update-show", ["daily"]); await f.run("publish-show", ["daily"]);
  await f.run("create-episode", ["daily", "next"]);
  await f.run("update-episode", ["daily", "next"]); await f.run("update-episode-audio", ["daily", "next", "audio.mp3"]);
  const hash = createHash("sha256").update("next").digest("hex");
  f.node.fixture.storage.sql.exec("INSERT INTO publication_site_ids (show_id, episode_id, site_id) VALUES (?, ?, ?)", "daily", "reserved", hash.slice(0, 16));
  const target = { kind: "episode" as const, show_id: "daily", episode_id: "next" };
  const preview = await draftPreview(f.root, f.config, target, undefined, { client: f.client });
  expect(preview.published.snapshot!.episode_site_id).toBe(hash.slice(0, 20));
  const before = f.node.service.content.sites.ids.all("daily"), output = join(f.root, "short-preview.xml"); f.calls.length = 0;
  await exportPreviewRss(f.root, f.config, preview, f.client, output);
  const xml = readFileSync(output, "utf8");
  expect(xml).toContain(`<link>${f.config.public_base_url}/podcasts/daily/${hash.slice(0, 20)}/</link>`);
  expect(xml).toContain(`<link>${f.config.public_base_url}/podcasts/daily/${before.first}/</link>`);
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  expect(f.node.service.content.sites.ids.all("daily")).toEqual(before);
  expect(f.node.service.content.inspect("daily", "next").episode).toBeNull();
  await f.run("publish-episode", ["daily", "next"]);
  expect(f.node.service.content.sites.ids.get("daily", "next")).toBe(hash.slice(0, 20));
});

test("read failure and inconsistent remote metadata never become a zero diff or allow publication", async () => {
  const f = await fixture();
  const tamper: typeof f.transport = async (input, init) => {
    const response = await f.transport(input, init);
    if (!String(input).includes("/content/")) return response;
    const content = await response.json() as { episode_content: { metadata_sha256: string } };
    content.episode_content.metadata_sha256 = "f".repeat(64);
    return Response.json(content, { headers: { "Cache-Control": "no-store" } });
  };
  await expect(draftPreview(f.root, f.config, f.target, undefined,
    { client: new SqliteServiceClient(f.config, f.key, tamper) })).rejects.toThrow("hash differs");
});

test("invalid plan file errors do not echo JSON input", async () => {
  const f = await fixture(), file = join(f.root, "invalid-plan.json");
  writeFileSync(file, "{private-plan-content-not-for-diagnostics");
  expect(() => readRevisionPlanFile(file)).toThrow("Revision plan JSON is unreadable, invalid or exceeds its read budget");
});

for (const kind of ["show", "episode"] as const) {
  test(`${kind} revision jobs support read-only progress and watch without upload phases`, async () => {
    const f = await fixture(), episodeId = kind === "episode" ? "first" : undefined;
    const content = await f.client.content("daily", episodeId);
    const original = kind === "episode" ? content.episode_content! : content.show_content!;
    const preview = await previewRevision(f.config, f.key, "daily", original.revision_id, episodeId, f.transport);
    const plan = sqliteRevisionPlanSchema.parse(preview.plan);
    await executeRevision(f.root, f.config, f.key, plan, plan.request_sha256, "confirm", f.transport);
    const file = join(f.root, ".castloop", "sqlite-revisions", f.config.service_id, `${plan.request.job_id}.json`);
    const before = readFileSync(file); f.calls.length = 0;
    const progress = progressResultSchema.parse(await f.run("progress", [plan.request.job_id]));
    expect(progress.job).toMatchObject({ source: "revision", kind, show_id: "daily" });
    expect(progress.state).toBe("succeeded");
    expect(progress.phases.find((phase) => phase.phase === "publication_submitted")?.state).toBe("done");
    expect(progress.phases.some((phase) => phase.phase.startsWith("upload:"))).toBe(false);
    expect(progress.observation).toMatchObject({ observed: true, stale: false });
    expect(watchResultSchema.parse(await f.run("watch", [plan.request.job_id])).outcome.state).toBe("succeeded");
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    expect(readFileSync(file)).toEqual(before);
  });
}

test("prepared revision plans remain unsubmitted in progress and watch without remote IO", async () => {
  const f = await fixture(), old = (await f.client.content("daily")).show_content!;
  const preview = await previewRevision(f.config, f.key, "daily", old.revision_id, undefined, f.transport);
  const plan = sqliteRevisionPlanSchema.parse(preview.plan);
  await f.run("show-admission-pause", ["daily", crypto.randomUUID()]);
  await expect(executeRevision(f.root, f.config, f.key, plan, plan.request_sha256, "confirm", f.transport)).rejects.toThrow("base changed");
  f.calls.length = 0;
  const progress = progressResultSchema.parse(await f.run("progress", [plan.request.job_id]));
  expect(progress.state).toBe("draft"); expect(progress.job.source).toBe("revision");
  expect(progress.phases.find((phase) => phase.phase === "publication_submitted")?.state).toBe("pending");
  expect(watchResultSchema.parse(await f.run("watch", [plan.request.job_id])).outcome).toEqual({ state: "unobservable", reason_code: "job_not_submitted" });
  expect(f.calls).toEqual([]);
});

test("unknown revision submission stays unknown on 404 and is never retried by observers", async () => {
  const f = await fixture(), old = (await f.client.content("daily")).show_content!;
  const preview = await previewRevision(f.config, f.key, "daily", old.revision_id, undefined, f.transport);
  const plan = sqliteRevisionPlanSchema.parse(preview.plan);
  const lost: typeof f.transport = async (input, init) => {
    if (init?.method === "POST") throw new Error("Submit outcome unknown");
    return f.transport(input, init);
  };
  await expect(executeRevision(f.root, f.config, f.key, plan, plan.request_sha256, "confirm", lost)).rejects.toThrow();
  f.calls.length = 0;
  const progress = progressResultSchema.parse(await f.run("progress", [plan.request.job_id]));
  expect(progress.state).toBe("unknown"); expect(progress.status).toBeNull();
  expect(progress.phases.find((phase) => phase.phase === "publication_submitted")?.state).toBe("unknown");
  let now = 0;
  const watched = await watchSqliteJob(f.root, f.config, plan.request.job_id, { transport: f.transport,
    timeoutSeconds: 1, intervalSeconds: 1, now: () => now, delay: async (ms) => { now += ms; }, onEvent: () => {} });
  expect(watched.outcome).toEqual({ state: "unobservable", reason_code: "budget_exhausted" });
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
});

test("revision observation preserves retained results and rejects contradictory remote status", async () => {
  const f = await fixture(), old = (await f.client.content("daily")).show_content!;
  const preview = await previewRevision(f.config, f.key, "daily", old.revision_id, undefined, f.transport);
  const plan = sqliteRevisionPlanSchema.parse(preview.plan);
  await executeRevision(f.root, f.config, f.key, plan, plan.request_sha256, "confirm", f.transport);
  for (const fault of ["missing", "regressed"] as const) {
    const transport: typeof f.transport = async (input, init) => {
      if (fault === "missing") return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
      const response = await f.transport(input, init), status = await response.json() as Record<string, unknown>;
      return Response.json({ ...status, state: "queued" }, { headers: { "Cache-Control": "no-store" } });
    };
    const progress = progressResultSchema.parse(await f.run("progress", [plan.request.job_id], f.root, transport));
    expect(progress.state).toBe("succeeded"); expect(progress.observation).toMatchObject({ observed: false, stale: true });
    let now = 0;
    const watched = await watchSqliteJob(f.root, f.config, plan.request.job_id, { transport,
      timeoutSeconds: 1, intervalSeconds: 1, now: () => now, delay: async (ms) => { now += ms; }, onEvent: () => {} });
    expect(watched.outcome).toEqual({ state: "unobservable", reason_code: fault === "missing" ? "job_missing" : "budget_exhausted" });
  }
});
