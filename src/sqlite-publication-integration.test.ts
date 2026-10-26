import { afterEach, expect, test } from "bun:test";
import { episodeDraftFromRevision, stringifyToml } from "../packages/shared/src/index";
import { sqliteSchedulePlanHash, sqliteScheduleTimeSchema } from "../packages/shared/src/sqlite-schedule";
import { sqliteServiceConfigHash } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SqliteDraft } from "../packages/cli/src/sqlite-draft";
import { SqliteScheduleClient } from "../packages/cli/src/sqlite-schedule-client";
import type { SqliteDraftTarget } from "../packages/cli/src/sqlite-draft-journal";
import type { R2RestTransport } from "../packages/cli/src/verified-r2-put";
import { SqlitePublicationAlarm } from "./sqlite-publication-alarm";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { createSqlitePublicationExecutor } from "./sqlite-publication-executor";
import { createSqlitePublicationHttp } from "./sqlite-publication-http";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { sqlitePublicationBucket } from "./test-support/sqlite-publication-bucket";
import { createSqliteOperationRecords } from "./sqlite-operation-runtime";
import { createSqliteOperationHttp } from "./sqlite-operation-http";
import { SqlitePublicationSchedules } from "./sqlite-publication-schedules";
import { createSqliteScheduleHttp } from "./sqlite-schedule-http";
import { SqliteServiceRuntime } from "./sqlite-service-runtime";
import { createSqliteServiceHttp } from "./sqlite-service-http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function scheduleTime(at: number) {
  const seconds = Math.floor(at / 1000) * 1000, iso = new Date(seconds).toISOString().replace(/\.\d{3}Z$/, "Z");
  return sqliteScheduleTimeSchema.parse({ input: iso, scheduled_at: iso, scheduled_at_ms: seconds, input_offset: "+00:00",
    resolution_source: "offset", timezone: "UTC", timezone_source: "server", local_datetime: iso.slice(0, -1), offset: "+00:00" });
}

async function fixture() {
  const root = mkdtempSync("/tmp/opencode/castloop-sqlite-integration-");
  const config: SqliteServiceConfig = { schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: "service",
    account_id: "a".repeat(32), bucket_name: "private-bucket", worker_name: "test-worker", public_base_url: "https://public.example.com",
    workers_dev_base_url: "https://test-worker.example.workers.dev" };
  const queue = sqlitePublicationFixture({ runtime: { service_id: config.service_id, worker_version_id: crypto.randomUUID(),
    service_config_sha256: await sqliteServiceConfigHash(config) } });
  cleanups.push(() => { queue.close(); rmSync(root, { recursive: true, force: true }); });
  const objects = sqlitePublicationBucket(), content = new SqlitePublicationContent(queue.storage);
  content.registerShow("daily", crypto.randomUUID());
  let ready = true;
  const http = createSqlitePublicationHttp(queue.queue, "private-admin", () => ready, "daily");
  let scheduleNow = Date.now();
  const schedules = new SqlitePublicationSchedules(queue.storage, queue.queue, content, () => scheduleNow,
    { showId: "daily", ready: () => ready });
  const records = createSqliteOperationRecords(queue.storage, queue.queue, content, () => ready, "daily",
    (jobId) => schedules.hasActiveJob(jobId));
  schedules.operationRecords = records;
  const scheduleHttp = createSqliteScheduleHttp(schedules, "private-admin", "daily");
  const operations = createSqliteOperationHttp(records, "private-admin", () => ready, objects.bucket);
  const runtime = new SqliteServiceRuntime(queue.storage, queue.queue, content, objects.bucket, config,
    { describe: async () => ({ ...queue.runtime, cache_enabled: true }), purge: async () => {} });
  runtime.ready = () => ready;
  const service = createSqliteServiceHttp(runtime, "private-admin");
  const requests: Request[] = [];
  const transport: R2RestTransport = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    if (new URL(request.url).hostname !== "api.cloudflare.com") {
      const path = new URL(request.url).pathname;
      return path.startsWith("/admin/sqlite-operations/") ? operations(request) :
        path.startsWith("/admin/sqlite-service/") ? service(request) :
          path === "/admin/sqlite-schedules" || path.startsWith("/admin/sqlite-schedules/") ? scheduleHttp(request) : http(request);
    }
    expect(request.headers.get("Authorization")).toBe("Bearer private-token");
    const key = new URL(request.url).pathname.split("/objects/")[1]!;
    if (request.method === "PUT") {
      const object = (await objects.bucket.put(key, new Uint8Array(await request.arrayBuffer())))!;
      return Response.json({ success: true, result: { key, etag: object.etag, version: object.version, size: object.size } });
    }
    const object = await objects.bucket.get(key);
    return new Response(object!.body, { headers: { ETag: `"${object!.etag}"` } });
  };
  const purges: Array<{ showId: string; cover: boolean }> = [];
  const executor = createSqlitePublicationExecutor(content, objects.bucket, config, { purge: async (target) => { purges.push(target); },
    now: () => "2026-10-16T15:00:00Z" });
  const alarm = new SqlitePublicationAlarm(queue.queue, executor, () => {});
  const options = { administratorKey: "private-admin", managementTransport: transport,
    r2: { accountId: config.account_id, apiToken: "private-token", transport } };
  const directory = join(root, "daily"); mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "show.toml"), stringifyToml({ schema_version: 1, show_id: "daily", title: "Local Show", description: "Description",
    language: "ja", author: "Author", owner_name: "Owner", owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
    site_url: "https://example.com/podcast", image_path: "cover.jpg" }));
  writeFileSync(join(directory, "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  writeFileSync(join(directory, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  const target = (kind: "show" | "episode", episodeId = "first"): SqliteDraftTarget => ({ job_id: crypto.randomUUID(), kind, show_id: "daily",
    expected_show_state_version: kind === "show" ? 0 : 1, ...(kind === "episode" ? { episode_id: episodeId } : {}) });
  const open = (value: SqliteDraftTarget) => SqliteDraft.open(root, config, value, options);
  const run = async () => { queue.clearAlarm(); return alarm.alarm(); };
  return { ...queue, ...objects, root, config, directory, content, http, schedules, requests, options, open, target, run, purges,
    advanceSchedule: (milliseconds: number) => { scheduleNow += milliseconds; },
    notReady: () => { ready = false; } };
}

test("CLI upload → authenticated submit → FIFO Alarm → real publication → observation completes without Queue or R2 control records", async () => {
  const setup = await fixture();
  const show = await setup.open(setup.target("show"));
  await show.stage({ asset: "show" });
  expect(setup.queue.snapshot().drained).toBe(true);
  expect((await show.publish())?.state).toBe("queued");
  expect((await setup.run()).state).toBe("succeeded");
  await show.wait();
  for (const id of ["first", "second"]) {
    writeFileSync(join(setup.directory, `episode-${id}.toml`), stringifyToml({ schema_version: 1, episode_id: id, guid: `guid-${id}`,
      title: `Local ${id}`, description: "Description", published_at: "2026-10-16T12:00:00+09:00" }));
  }
  const first = await setup.open(setup.target("episode", "first")), second = await setup.open(setup.target("episode", "second"));
  for (const draft of [first, second]) {
    await draft.stage({ asset: "episode_metadata" });
    await draft.stage({ asset: "audio", audio_path: "audio.mp3" });
    expect((await draft.publish())?.state).toBe("queued");
  }
  expect(setup.queue.snapshot().queued).toBe(2);
  expect((await setup.run()).state).toBe("succeeded");
  expect((await first.wait()).state).toBe("succeeded");
  expect((await second.observe())?.state).toBe("queued");
  expect((await setup.run()).state).toBe("succeeded");
  await second.wait();
  const base = setup.content.episodes("daily").find((revision) => revision.episode_id === "first")!;
  const update = await setup.open({ ...setup.target("episode"), base_revision_id: base.revision_id,
    base_metadata_sha256: createHash("sha256").update(JSON.stringify(episodeDraftFromRevision(base))).digest("hex") });
  const metadataPath = join(setup.directory, "episode-first.toml");
  writeFileSync(metadataPath, readFileSync(metadataPath, "utf8").replace("Local first", "Updated first"));
  setup.calls.length = 0;
  await update.stage({ asset: "episode_metadata" });
  await update.publish(); await setup.run(); await update.wait();
  expect(setup.content.episodes("daily").find((revision) => revision.episode_id === "first")).toMatchObject({
    title: "Updated first", guid: base.guid, published_at: base.published_at, enclosure_url: base.enclosure_url });
  expect(setup.calls.some((call) => call.method === "PUT" && call.key.endsWith(".mp3"))).toBe(false);
  expect(setup.calls.some((call) => /^system\/(?:jobs|show-publications|management-requests|lifecycle-service)/.test(call.key))).toBe(false);
  expect(setup.requests.filter((request) => request.method === "POST" && new URL(request.url).pathname === "/admin/sqlite-publication/jobs")).toHaveLength(4);
  expect(setup.requests.some((request) => new URL(request.url).pathname.includes("queues"))).toBe(false);
  expect(setup.text(`public/podcasts/daily/feeds/${setup.content.inspect("daily").show!.feed_generation}.xml`)).toContain("Updated first");
  expect(setup.purges).toHaveLength(4);
});

test("HTTP authentication, protocol, bounded body, readiness and method gates cannot start publication IO", async () => {
  const setup = await fixture();
  const origin = `${setup.config.workers_dev_base_url}/admin/sqlite-publication/`;
  const headers = { "X-Castloop-Key": "private-admin", "Content-Type": "application/json" };
  expect((await setup.http(new Request(`${origin}status`))).status).toBe(401);
  expect((await setup.http(new Request(`${origin}jobs`, { method: "POST", headers, body: JSON.stringify({ protocol: "queue-management-v1" }) }))).status).toBe(400);
  expect((await setup.http(new Request(`${origin}jobs`, { method: "POST", headers, body: "x".repeat(16385) }))).status).toBe(400);
  expect((await setup.http(new Request(`${origin}jobs`, { headers }))).status).toBe(405);
  expect((await setup.http(new Request(`${origin}status?refresh=true`, { headers }))).status).toBe(400);
  expect((await setup.http(new Request(`${origin}retry`, { method: "POST", headers }))).status).toBe(404);
  setup.notReady();
  expect((await setup.http(new Request(`${origin}status`, { headers }))).status).toBe(503);
  expect((await setup.http(new Request(`${origin}jobs`, { method: "POST", headers, body: "{}" }))).status).toBe(503);
  const status = await setup.http(new Request(`${origin}jobs/${crypto.randomUUID()}`, { headers }));
  expect(status.status).toBe(404);
  expect(status.headers.get("Cache-Control")).toBe("no-store");
  expect(setup.calls).toEqual([]);
  expect(setup.queue.snapshot().drained).toBe(true);
});

test("CLI schedule freezes an Episode, stays outside the FIFO, then dispatches and publishes after its due time", async () => {
  const setup = await fixture();
  const show = await setup.open(setup.target("show"));
  await show.stage({ asset: "show" });
  await show.publish(); await setup.run(); await show.wait();
  writeFileSync(join(setup.directory, "episode-first.toml"), stringifyToml({ schema_version: 1, episode_id: "first",
    guid: "guid-first", title: "Scheduled first", description: "Description", published_at: "2026-10-16T12:00:00+09:00" }));
  const episode = await setup.open(setup.target("episode", "first"));
  await episode.stage({ asset: "episode_metadata" });
  await episode.stage({ asset: "audio", audio_path: "audio.mp3" });
  const at = new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const plan = await episode.schedulePlan(at);
  expect(plan.publishable).toBe(true);
  const scheduled = await episode.schedule({ at, expectedPreview: plan.approval_sha256 });
  expect(scheduled.schedule).toMatchObject({ state: "scheduled", publication_state: null });
  expect(setup.queue.snapshot().queued).toBe(0);
  expect(setup.text(`public/podcasts/daily/feeds/${setup.content.inspect("daily").show!.feed_generation}.xml`))
    .not.toContain("Scheduled first");
  setup.advanceSchedule(61000);
  expect(await setup.schedules.dispatchDue()).toBe(1);
  expect(setup.queue.snapshot().queued).toBe(1);
  expect((await setup.run()).state).toBe("succeeded");
  expect((await episode.observeSchedule()).schedule).toMatchObject({ state: "dispatched", publication_state: "succeeded" });
  expect(setup.text(`public/podcasts/daily/feeds/${setup.content.inspect("daily").show!.feed_generation}.xml`))
    .toContain("Scheduled first");
});

test("CLI schedule client reschedules and cancels an undispatched schedule and local status follows", async () => {
  const setup = await fixture();
  const show = await setup.open(setup.target("show"));
  await show.stage({ asset: "show" });
  await show.publish(); await setup.run(); await show.wait();
  writeFileSync(join(setup.directory, "episode-first.toml"), stringifyToml({ schema_version: 1, episode_id: "first",
    guid: "guid-first", title: "Scheduled first", description: "Description", published_at: "2026-10-16T12:00:00+09:00" }));
  const episode = await setup.open(setup.target("episode", "first"));
  await episode.stage({ asset: "episode_metadata" });
  await episode.stage({ asset: "audio", audio_path: "audio.mp3" });
  const at = new Date(Date.now() + 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const plan = await episode.schedulePlan(at);
  const scheduled = await episode.schedule({ at, expectedPreview: plan.approval_sha256 });
  const client = new SqliteScheduleClient(setup.config, "private-admin", setup.options.managementTransport);
  const movedTime = scheduleTime(Date.now() + 120000);
  const movedHash = await sqliteSchedulePlanHash({ schema_version: 1, action: "reschedule", show_id: "daily",
    schedule_id: scheduled.schedule.schedule_id, expected_version: scheduled.schedule.version, scheduled_at: movedTime });
  const moved = await client.reschedule({ schema_version: 1, protocol: "sqlite-schedule-v1", service_id: scheduled.service_id,
    worker_version_id: scheduled.worker_version_id, service_config_sha256: scheduled.service_config_sha256, show_id: "daily",
    schedule_id: scheduled.schedule.schedule_id, expected_version: scheduled.schedule.version, preview_sha256: movedHash,
    scheduled_at: movedTime });
  expect(moved.schedule).toMatchObject({ state: "scheduled", version: scheduled.schedule.version + 1,
    scheduled_at: { scheduled_at_ms: movedTime.scheduled_at_ms } });
  expect((await episode.observeSchedule()).schedule.scheduled_at.scheduled_at_ms).toBe(movedTime.scheduled_at_ms);
  const cancelHash = await sqliteSchedulePlanHash({ schema_version: 1, action: "cancel", show_id: "daily",
    schedule_id: moved.schedule.schedule_id, expected_version: moved.schedule.version });
  const cancelled = await client.cancel({ schema_version: 1, protocol: "sqlite-schedule-v1", service_id: moved.service_id,
    worker_version_id: moved.worker_version_id, service_config_sha256: moved.service_config_sha256, show_id: "daily",
    schedule_id: moved.schedule.schedule_id, expected_version: moved.schedule.version, preview_sha256: cancelHash });
  expect(cancelled.schedule.state).toBe("cancelled");
  expect((await episode.observeSchedule()).schedule.state).toBe("cancelled");
  expect(setup.queue.snapshot().queued).toBe(0);
});

test("CLI stages metadata/cover/both Show edits without publication and commits independent cover snapshots", async () => {
  const setup = await fixture(), initial = await setup.open(setup.target("show"));
  await initial.stage({ asset: "show" }); await initial.publish(); await setup.run(); await initial.wait();
  let generation = 1;
  for (const selection of ["metadata", "cover", "both"] as const) {
    const path = join(setup.directory, "show.toml"), before = setup.content.delivery("/podcasts/daily/cover.jpg");
    if (selection !== "cover") writeFileSync(path, readFileSync(path, "utf8").replace(/title = ".*"/, `title = "${selection} update"`));
    if (selection !== "metadata") writeFileSync(join(setup.directory, "cover.jpg"), Uint8Array.of(255, 216, 255, generation));
    const draft = await setup.open({ ...setup.target("show"), expected_show_state_version: setup.content.inspect("daily").show!.state_version });
    await draft.stage({ asset: "show" });
    expect(setup.content.delivery("/podcasts/daily/cover.jpg")).toEqual(before);
    expect(setup.queue.snapshot().drained).toBe(true);
    expect((await draft.publish())?.state).toBe("queued");
    expect((await setup.run()).state).toBe("succeeded"); await draft.wait(); generation++;
    expect(setup.content.delivery("/podcasts/daily/cover.jpg")).toMatchObject({ cache_props: { coverGeneration: generation } });
    expect(setup.entries.has(`public/podcasts/daily/covers/${generation}.jpg`)).toBe(true);
    expect(setup.entries.has(`public/podcasts/daily/covers/${generation - 1}.jpg`)).toBe(true);
    expect(setup.entries.has("public/podcasts/daily/cover.jpg")).toBe(false);
  }
});
