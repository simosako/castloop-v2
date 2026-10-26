import { afterEach, expect, test } from "bun:test";
import { episodeDraftFromRevision, parseEpisodeRevision, parseShowMetadata, stringifyToml } from "../packages/shared/src/index";
import { parseSqlitePublicationRequest, sqliteUploadKey } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationRequest, SqliteVerifiedUpload } from "../packages/shared/src/sqlite-publication";
import { sqliteServiceConfigHash } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SqlitePublicationAlarm } from "./sqlite-publication-alarm";
import { purgeSqliteCache } from "./sqlite-cache-purge";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { SqlitePublicationSchedules } from "./sqlite-publication-schedules";
import { createSqlitePublicationExecutor } from "./sqlite-publication-executor";
import { withSitePublication } from "./site-publication";
import { serveSiteGateway } from "./site-gateway";
import { serveCachedSitePage } from "./site-cache";
import { siteSnapshotKey } from "../packages/shared/src/website";
import type { SitePurgeTarget } from "./site-storage";
import type { SqlitePublicationEffectFailure } from "./sqlite-publication-executor";
import type { SqliteAvailabilityRequest } from "../packages/shared/src/sqlite-availability";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { sqlitePublicationBucket } from "./test-support/sqlite-publication-bucket";
import { sqliteFeedSnapshotKey } from "./sqlite-feed";
import { sqliteCoverSnapshotKey } from "./sqlite-cover";
import { reserveSqliteFeedGeneration } from "./sqlite-feed-generations";
import { serveCachedLifecycleAsset } from "./lifecycle-cache";
import { serveSqliteGateway } from "./sqlite-gateway";
import { createHash } from "node:crypto";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const show = { schema_version: 1 as const, show_id: "daily", title: "Private Show", description: "Private description", language: "ja",
  author: "Author", owner_name: "Owner", owner_email: "private@example.com", categories: ["Technology"], explicit: false,
  site_url: "https://example.com/podcast", image_path: "cover.jpg" };
const metadata = (episodeId: string) => ({ schema_version: 1 as const, episode_id: episodeId, guid: `stable-${episodeId}`,
  title: `Private ${episodeId}`, description: "Private description", published_at: "2026-10-16T12:00:00+09:00" });
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const shortId = (id: string) => hash(id).slice(0, 16);
const episodePage = (id = "first") => `/podcasts/daily/${shortId(id)}/`;

async function readPublic(setup: Awaited<ReturnType<typeof fixture>>, path = "/podcasts/daily/feed.xml", headers: HeadersInit = {}) {
  return serveSqliteGateway(new Request(`${setup.config.workers_dev_base_url}${path}`, { headers }), setup.config.workers_dev_base_url,
    { fetch: async () => new Response(null), delivery: async (value) => setup.content.delivery(value) },
    (request, props) => serveCachedLifecycleAsset(request, { CASTLOOP_BUCKET: setup.bucket } as never, props));
}

async function fixture(builtin = false) {
  const { site_url: externalUrl, ...withoutSite } = show;
  const showInput = builtin ? { ...withoutSite, site_mode: "builtin" as const } : show;
  const config: SqliteServiceConfig = { schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: "service",
    account_id: "a".repeat(32), bucket_name: "test-bucket", worker_name: "test-worker", public_base_url: "https://public.example.com",
    workers_dev_base_url: "https://test-worker.example.workers.dev" };
  const setup = sqlitePublicationFixture({ runtime: { service_id: config.service_id, worker_version_id: crypto.randomUUID(),
    service_config_sha256: await sqliteServiceConfigHash(config) } });
  cleanups.push(setup.close);
  const objects = sqlitePublicationBucket(), content = new SqlitePublicationContent(setup.storage);
  const reservationId = crypto.randomUUID();
  content.registerShow("daily", reservationId);
  const purges: Array<{ showId: string; cover: boolean; episodeId?: string }> = [];
  const effectFailures: SqlitePublicationEffectFailure[] = [];
  const sitePurges: SitePurgeTarget[] = [];
  const hooks: { purge?: () => Promise<void>; sitePurge?: () => Promise<void> } = {};
  const executor = withSitePublication(createSqlitePublicationExecutor(content, objects.bucket, config, { async purge(target) {
    purges.push(target); await hooks.purge?.();
  }, now: () => "2026-10-16T13:00:00Z", onFailure: (event) => effectFailures.push(event) }), content, objects.bucket, config,
  async (target) => { sitePurges.push(target); await hooks.sitePurge?.(); });
  const events: unknown[] = [];
  const runner = new SqlitePublicationAlarm(setup.queue, executor, (event) => events.push(event));
  async function payload(jobId: string, asset: SqliteVerifiedUpload["asset"], source: string | Uint8Array): Promise<SqliteVerifiedUpload> {
    const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
    const uploadId = crypto.randomUUID(), key = sqliteUploadKey({ show_id: "daily", draft_job_id: jobId, upload_id: uploadId, asset });
    const object = (await objects.bucket.put(key, bytes))!;
    return { upload_id: uploadId, key, asset, length_bytes: bytes.length, sha256: hash(bytes), etag: object.etag, version: object.version,
      verified: true, ...(asset === "audio" ? { duration_seconds: 1 } : {}) };
  }
  async function request(kind: "show" | "episode", episodeId = "first", base?: string,
    selection: "both" | "metadata" | "audio" = "both"): Promise<SqlitePublicationRequest> {
    const jobId = crypto.randomUUID();
    const payloads: SqliteVerifiedUpload[] = [];
    if (kind === "show") {
      payloads.push(await payload(jobId, "show_metadata", stringifyToml(showInput)), await payload(jobId, "cover_jpg", Uint8Array.from([255, 216, 255, 2])));
    } else {
      if (selection !== "audio") payloads.push(await payload(jobId, "episode_metadata", stringifyToml(metadata(episodeId))));
      if (selection !== "metadata") payloads.push(await payload(jobId, "audio", Uint8Array.from([255, 251, 144, 100, 1, 2, 3])));
    }
    return parseSqlitePublicationRequest({ schema_version: 1, protocol: "sqlite-sequential-v1", ...setup.runtime,
      admission_window_id: setup.windowId, action: "publish", request_id: crypto.randomUUID(), job_id: jobId, kind, show_id: "daily",
      expected_show_state_version: kind === "show" ? 0 : 1,
      ...(kind === "episode" ? { episode_id: episodeId, ...(base ? { base_revision_id: base } : {}) } : {}), payloads });
  }
  const run = async (value: SqlitePublicationRequest) => {
    await setup.queue.enqueue(value);
    let result;
    do { setup.clearAlarm(); result = await runner.alarm(); } while (result.state === "running");
    return result;
  };
  const publishShow = async () => { const value = await request("show"); expect((await run(value)).state).toBe("succeeded"); return value; };
  const publishEpisode = async (episodeId = "first") => { const value = await request("episode", episodeId); expect((await run(value)).state).toBe("succeeded"); return value; };
  const showUpdate = async (selection: "metadata" | "cover" | "both" = "both") => {
    const value = await request("show");
    value.expected_show_state_version = content.inspect("daily").show!.state_version;
    value.payloads = [await payload(value.job_id, "show_metadata", stringifyToml({ ...showInput,
      ...(selection === "cover" ? {} : { title: "Updated Show" }) })),
      await payload(value.job_id, "cover_jpg", Uint8Array.from([255, 216, 255, selection === "metadata" ? 2 : 3]))];
    return value;
  };
  const lifecycle = (action: "unpublish" | "restore", episodeId?: string) => {
    const target = content.inspect("daily", episodeId);
    return parseSqlitePublicationRequest({ schema_version: 1, protocol: "sqlite-sequential-v1", ...setup.runtime,
      admission_window_id: setup.windowId, request_id: crypto.randomUUID(), job_id: crypto.randomUUID(), action,
      kind: episodeId === undefined ? "show" : "episode", show_id: "daily", expected_show_state_version: target.show!.state_version,
      ...(episodeId === undefined ? {} : { episode_id: episodeId, base_revision_id: target.base!.revision_id, expected_episode_lifecycle_version: target.episode!.lifecycle_version }), payloads: [] });
  };
  const feed = () => objects.text(sqliteFeedSnapshotKey("daily", content.inspect("daily").show!.feed_generation));
  const control = (action: SqliteAvailabilityRequest["action"]) => setup.queue.applyControl({ ...setup.runtime, action, show_id: "daily",
    operation_id: crypto.randomUUID(), expected_availability_version: setup.queue.snapshot().availability_version,
    ...(action === "resume" ? { admission_window_id: crypto.randomUUID() } : {}) });
  return { ...setup, ...objects, feed, control, bucketHooks: objects.hooks, config, content, reservationId, purges, sitePurges, effectFailures, hooks, executor, events, runner, payload, request, run, publishShow, publishEpisode, showUpdate, lifecycle };
}

function revisionRequest(setup: Awaited<ReturnType<typeof fixture>>, revisionId: string, episodeId?: string) {
  return parseSqlitePublicationRequest({ ...setup.lifecycle("restore", episodeId), action: "restore_revision", target_revision_id: revisionId });
}

async function readSite(f: Awaited<ReturnType<typeof fixture>>, path = "/podcasts/daily/", headers: HeadersInit = {}) {
  return serveSiteGateway(new Request(`${f.config.public_base_url}${path}`, { headers }), {
    managementOrigin: f.config.workers_dev_base_url, publicOrigin: f.config.public_base_url,
    delivery: async (page) => f.content.siteDelivery(page),
    cachedFetch: (request, props) => serveCachedSitePage(request, f.bucket as never, props),
  });
}

test("Show CSS is immutable revision content across publication, Episode lifecycle and past revision adoption", async () => {
  const f = await fixture(true), firstCss = ":root{--cl-accent:red}", nextCss = ":root{--cl-accent:blue}";
  const publishCss = async (css: string, initial = false) => {
    const request = initial ? await f.request("show") : await f.showUpdate();
    const { site_url, ...metadata } = show;
    request.payloads[0] = await f.payload(request.job_id, "show_metadata", stringifyToml({ ...metadata,
      site_mode: "builtin", site_css_path: "site.css", site_css: css }));
    expect((await f.run(request)).state).toBe("succeeded");
    return f.content.currentShowRevision("daily", f.config.public_base_url)!;
  };
  const first = await publishCss(firstCss, true);
  await f.publishEpisode("first"); await f.publishEpisode("second");
  const check = async (css: string) => {
    for (const path of ["/podcasts/daily/", episodePage(), episodePage("second")]) {
      const response = await readSite(f, path), html = await response.text();
      expect(response.status).toBe(200); expect(html).toContain(css);
      const style = html.match(/<style>([\s\S]*?)<\/style>/)![1];
      expect(response.headers.get("Content-Security-Policy")).toContain(createHash("sha256").update(style).digest("base64"));
    }
  };
  await check(firstCss);
  await publishCss(nextCss); await check(nextCss);
  await f.run(f.lifecycle("unpublish", "first"));
   expect((await readSite(f, episodePage())).status).toBe(404);
  await f.run(f.lifecycle("restore", "first")); await check(nextCss);
  expect((await f.run(revisionRequest(f, first.revision_id))).state).toBe("succeeded"); await check(firstCss);
  expect(f.content.showRevision("daily", first.revision_id, f.config.public_base_url)!.metadata.site_css).toBe(firstCss);
  await f.control("pause"); expect((await readSite(f)).status).toBe(503);
});

test("Show timezone updates regenerate all pages atomically and survive Episode updates, lifecycle and revision adoption", async () => {
  const f = await fixture(true), utc = await f.publishShow();
  const first = await f.publishEpisode(); await f.publishEpisode("second");
  const feed = f.feed(), episodes = f.content.episodes("daily").map(episodeDraftFromRevision);
  const paths = ["/podcasts/daily/", episodePage(), episodePage("second")];
  const check = async (date: string) => {
    for (const path of paths) expect(await (await readSite(f, path)).text()).toContain(date);
    expect(f.content.episodes("daily").map(episodeDraftFromRevision)).toEqual(episodes);
    expect(f.feed()).toBe(feed);
  };
  await check("2026-10-16 (UTC+00:00)");
  const update = await f.showUpdate();
  const metadata = f.content.currentShowRevision("daily", f.config.public_base_url)!.metadata;
  update.payloads[0] = await f.payload(update.job_id, "show_metadata", stringifyToml({ ...metadata, site_timezone: "Asia/Tokyo" }));
  f.hooks.sitePurge = async () => { await check("2026-10-16 (UTC+00:00)"); };
  expect((await f.run(update)).state).toBe("succeeded"); f.hooks.sitePurge = undefined;
  const tokyo = f.content.currentShowRevision("daily", f.config.public_base_url)!;
  expect(tokyo.metadata.site_timezone).toBe("Asia/Tokyo");
  for (const path of paths.slice(1)) {
    const siteId = path.split("/").at(-2)!;
    expect(f.content.sites.page({ kind: "episode", showId: "daily", siteId })!.generation).toBe(f.content.inspect("daily").show!.feed_generation);
  }
  await check("2026-10-16 (UTC+09:00)");
  const audio = await f.request("episode", "first", first.job_id, "audio");
  audio.expected_show_state_version = f.content.inspect("daily").show!.state_version;
  expect((await f.run(audio)).state).toBe("succeeded");
  expect(await (await readSite(f, episodePage())).text()).toContain("2026-10-16 (UTC+09:00)");
  expect((await f.run(revisionRequest(f, first.job_id, "first"))).state).toBe("succeeded");
  await check("2026-10-16 (UTC+09:00)");
  expect((await f.run(f.lifecycle("unpublish", "first"))).state).toBe("succeeded");
  expect((await f.run(f.lifecycle("restore", "first"))).state).toBe("succeeded");
  await check("2026-10-16 (UTC+09:00)");
  expect((await f.run(revisionRequest(f, utc.job_id))).state).toBe("succeeded");
  await check("2026-10-16 (UTC+00:00)");
  expect((await f.run(revisionRequest(f, tokyo.revision_id))).state).toBe("succeeded");
  expect((await f.run(f.lifecycle("unpublish"))).state).toBe("succeeded");
  expect((await f.run(f.lifecycle("restore"))).state).toBe("succeeded");
  await check("2026-10-16 (UTC+09:00)");
});

test("scheduled publication uses builtin CSS, safe descriptions, short URLs and the Show timezone only when due", async () => {
  const f = await fixture(true), showRequest = await f.request("show");
  const { site_url, ...showMetadata } = show;
  showRequest.payloads[0] = await f.payload(showRequest.job_id, "show_metadata", stringifyToml({ ...showMetadata,
    site_mode: "builtin", site_css_path: "site.css", site_css: ":root{--cl-accent:red}", site_timezone: "Asia/Tokyo" }));
  expect((await f.run(showRequest)).state).toBe("succeeded");
  let now = 1000;
  const schedules = new SqlitePublicationSchedules(f.storage, f.queue, f.content, () => now,
    { showId: "daily", ready: () => true });
  const publication = await f.request("episode");
  publication.payloads[0] = await f.payload(publication.job_id, "episode_metadata", stringifyToml({ ...metadata("first"),
    published_at: "2025-12-16T22:00:00Z", description: '<p>全文<br><a href="https://example.com/story">記事</a></p>' }));
  const scheduleId = crypto.randomUUID();
  await schedules.create({ schema_version: 1, protocol: "sqlite-schedule-v1", ...f.runtime, show_id: "daily",
    schedule_id: scheduleId, expected_version: 0, preview_sha256: "c".repeat(64), publication,
    scheduled_at: { input: "1970-01-01T00:00:02Z", scheduled_at: "1970-01-01T00:00:02Z", scheduled_at_ms: 2000,
      input_offset: "+00:00", resolution_source: "offset", timezone: "UTC", timezone_source: "server",
      local_datetime: "1970-01-01T00:00:02", offset: "+00:00" } });
  expect(await schedules.dispatchDue()).toBe(0);
  expect(f.queue.snapshot().queued).toBe(0);
  expect((await readSite(f, episodePage())).status).toBe(404);
  expect(f.feed()).not.toContain("<item>");
  now = 2000;
  expect(await schedules.dispatchDue()).toBe(1);
  let result;
  do { f.clearAlarm(); result = await f.runner.alarm(); } while (result.state === "running");
  expect(result.state).toBe("succeeded");
  expect(schedules.status(scheduleId).schedule).toMatchObject({ state: "dispatched", publication_state: "succeeded" });
  for (const path of ["/podcasts/daily/", episodePage()]) {
    const response = await readSite(f, path), html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("2025-12-17 (UTC+09:00)");
    expect(html).toContain(":root{--cl-accent:red}");
    expect(html).toContain(`<a href="${episodePage()}">`);
    expect(html).toContain('<audio controls preload="none"');
    expect(html).not.toContain("<footer");
    if (path === episodePage()) expect(html).toContain('<a href="https://example.com/story">記事</a>');
  }
  expect(f.feed()).toContain(`<link>https://public.example.com${episodePage()}</link>`);
  expect(f.content.episodes("daily")[0].published_at).toBe("2025-12-16T22:00:00Z");
});

test("builtin publication atomically exposes static pages, native audio and RSS links without private Show fields", async () => {
  const f = await fixture(true);
  expect((await readSite(f)).status).toBe(404);
  await f.publishShow();
  expect(await (await readSite(f)).text()).toContain("公開済みのEpisodeはありません");
  const episode = await f.publishEpisode();
  const html = await (await readSite(f)).text();
  expect(html).toContain('<audio controls preload="none"');
  expect(html).toContain(`${episode.job_id}.mp3`);
  expect(html).not.toContain("private@example.com");
  const page = await readSite(f, episodePage());
  expect(page.status).toBe(200);
  expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'none'");
  for (const path of ["/podcasts/daily/episodes/first/", `/podcasts/daily/e/${shortId("first")}/`, "/podcasts/daily/aaaaaaaaaaaaaaaa/"]) {
    expect((await readSite(f, path)).status).toBe(404);
  }
  expect(f.feed()).toContain("<link>https://public.example.com/podcasts/daily/</link>");
  expect(f.feed()).toContain(`<link>https://public.example.com${episodePage()}</link>`);
  expect(f.sitePurges).toEqual([{ showId: "daily" }, { showId: "daily", siteId: shortId("first") }]);
  await f.control("pause");
  expect((await readSite(f, episodePage(), { "If-None-Match": "*" })).status).toBe(503);
});

test("extended short URLs stay aligned across HTML, Feed, cache, lifecycle and revision restoration", async () => {
  const f = await fixture(true); await f.publishShow();
  f.storage.sql.exec("INSERT INTO publication_site_ids (show_id, episode_id, site_id) VALUES (?, ?, ?)", "daily", "reserved", shortId("first"));
  const first = await f.publishEpisode(), siteId = hash("first").slice(0, 20), path = `/podcasts/daily/${siteId}/`;
  const check = async () => {
    const listing = await (await readSite(f)).text();
    expect(listing).toContain(`href="${path}"`);
    const response = await readSite(f, path), html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`rel="canonical" href="${f.config.public_base_url}${path}"`);
    expect(html).toContain(`property="og:url" content="${f.config.public_base_url}${path}"`);
    expect(f.feed()).toContain(`<link>${f.config.public_base_url}${path}</link>`);
    expect((await readSite(f, episodePage())).status).toBe(404);
    const props = f.content.siteDelivery({ kind: "episode", showId: "daily", siteId });
    if (props.status !== 200) throw new Error("Expected approved short page");
    const cached = await serveCachedSitePage(new Request(`https://cache.invalid${path}`), f.bucket as never, props.props);
    expect(cached.headers.get("Cache-Tag")).toContain(`site-episode-daily/${siteId}`);
  };
  await check();
  const update = await f.request("episode", "first", first.job_id, "metadata");
  expect((await f.run(update)).state).toBe("succeeded"); await check();
  await f.run(f.lifecycle("unpublish", "first"));
  expect((await readSite(f, path, { "If-None-Match": "*" })).status).toBe(404);
  expect(f.content.sites.ids.get("daily", "first")).toBe(siteId);
  expect(f.content.sites.page({ kind: "episode", showId: "daily", siteId })).toBeNull();
  await f.run(f.lifecycle("restore", "first")); await check();
  expect((await f.run(revisionRequest(f, first.job_id, "first"))).state).toBe("succeeded"); await check();
  expect(f.sitePurges.slice(1).every((target) => target.siteId === siteId)).toBe(true);
});

test("builtin metadata/audio revisions and saved revision adoption preserve page URLs and unaffected Episode snapshots", async () => {
  const f = await fixture(true); await f.publishShow(); const first = await f.publishEpisode(); await f.publishEpisode("second");
  const other = f.content.sites.page({ kind: "episode", showId: "daily", siteId: shortId("second") });
  const update = await f.request("episode", "first", first.job_id, "metadata");
  update.payloads = [await f.payload(update.job_id, "episode_metadata", stringifyToml({ ...metadata("first"), title: "New title" }))];
  expect((await f.run(update)).state).toBe("succeeded");
  let html = await (await readSite(f, episodePage())).text();
  expect(html).toContain("New title"); expect(html).toContain(`${first.job_id}.mp3`);
  const audio = await f.request("episode", "first", update.job_id, "audio");
  expect((await f.run(audio)).state).toBe("succeeded");
  html = await (await readSite(f, episodePage())).text();
  expect(html).toContain(`${audio.job_id}.mp3`);
  expect((await f.run(revisionRequest(f, first.job_id, "first"))).state).toBe("succeeded");
  html = await (await readSite(f, episodePage())).text();
  expect(html).toContain(`${first.job_id}.mp3`); expect(html).not.toContain("New title");
  expect(f.content.sites.page({ kind: "episode", showId: "daily", siteId: shortId("second") })).toEqual(other);
  expect(f.entries.has(`public/podcasts/daily/episodes/first/${audio.job_id}.mp3`)).toBe(true);
});

test("builtin lifecycle hides removed Episodes and regenerates Show restoration including saved revision content", async () => {
  const f = await fixture(true), original = await f.publishShow(); await f.publishEpisode();
  expect((await f.run(f.lifecycle("unpublish", "first"))).state).toBe("succeeded");
  expect((await readSite(f, episodePage())).status).toBe(404);
  expect(await (await readSite(f)).text()).not.toContain("<audio");
  expect((await f.run(f.lifecycle("restore", "first"))).state).toBe("succeeded");
  expect((await readSite(f, episodePage())).status).toBe(200);
  expect((await f.run(f.lifecycle("unpublish"))).state).toBe("succeeded");
  expect((await readSite(f)).status).toBe(404);
  expect((await f.run(f.lifecycle("restore"))).state).toBe("succeeded");
  expect(await (await readSite(f)).text()).toContain("<audio");
  expect((await f.run(await f.showUpdate())).state).toBe("succeeded");
  expect((await f.run(revisionRequest(f, original.job_id))).state).toBe("succeeded");
  expect(await (await readSite(f)).text()).not.toContain("Updated Show");
});

test("external/builtin changes require explicit publication and clear or regenerate all page references", async () => {
  const f = await fixture(true), original = await f.publishShow(); await f.publishEpisode();
  const update = await f.showUpdate();
  update.payloads[0] = await f.payload(update.job_id, "show_metadata", stringifyToml(show));
  expect((await readSite(f)).status).toBe(200);
  expect((await f.run(update)).state).toBe("succeeded");
  expect((await readSite(f)).status).toBe(404);
  expect((await readSite(f, episodePage())).status).toBe(404);
  expect(f.feed()).toContain(`<link>${show.site_url}</link>`);
  expect((await f.run(revisionRequest(f, original.job_id))).state).toBe("succeeded");
  expect((await readSite(f, episodePage())).status).toBe(200);
});

test("bounded site batches survive restart, retain committed reads, and serialize queued publication across admission pause", async () => {
  const f = await fixture(true); await f.publishShow();
  for (let index = 0; index < 21; index++) await f.publishEpisode(`ep-${String(index).padStart(2, "0")}`);
  expect((await (await readSite(f)).text()).match(/<audio /g)).toHaveLength(20);
  expect((await (await readSite(f, "/podcasts/daily/page/2/")).text()).match(/<audio /g)).toHaveLength(1);
  const old = await (await readSite(f)).text(), request = await f.showUpdate();
  await f.queue.enqueue(request); await f.control("admission-pause"); f.clearAlarm(); f.calls.length = 0;
  expect((await f.runner.alarm()).state).toBe("running");
  expect(f.calls.filter((call) => call.method === "PUT" && call.key.includes("/sites/"))).toHaveLength(20);
  expect(f.calls.some((call) => call.method === "PUT" && call.key.includes("/feeds/"))).toBe(false);
  expect(await (await readSite(f)).text()).toBe(old);
  await expect(f.control("resume")).rejects.toThrow("drained");
  const queue = new SqlitePublicationQueue(f.storage, f.runtime), content = new SqlitePublicationContent(f.storage);
  const executor = withSitePublication(createSqlitePublicationExecutor(content, f.bucket, f.config, { purge: async () => {} }), content, f.bucket, f.config, async () => {});
  const runner = new SqlitePublicationAlarm(queue, executor, () => {});
  f.clearAlarm(); expect((await runner.alarm()).state).toBe("succeeded");
  expect(f.calls.filter((call) => call.method === "PUT" && call.key.includes("/sites/"))).toHaveLength(23);
  expect(await (await readSite(f)).text()).toContain("Updated Show");
  expect(queue.snapshot()).toMatchObject({ state: "admission_paused", drained: true });
});

test("removing the last second-page Episode removes its listing URL without exposing staged HTML", async () => {
  const f = await fixture(true); await f.publishShow();
  for (let index = 0; index < 21; index++) await f.publishEpisode(`ep-${index}`);
  expect((await readSite(f, "/podcasts/daily/page/2/")).status).toBe(200);
  expect((await f.run(f.lifecycle("unpublish", "ep-20"))).state).toBe("succeeded");
  expect((await readSite(f, "/podcasts/daily/page/2/")).status).toBe(404);
  const root = f.content.sites.page({ kind: "listing", showId: "daily", page: 1 })!;
  expect(f.entries.has(siteSnapshotKey({ kind: "listing", showId: "daily", page: 1 }, root.generation))).toBe(true);
});

for (const fault of ["html", "media-purge", "site-purge"] as const) test(`builtin ${fault} uncertainty blocks without replay and leaves only the approved site visible`, async () => {
  const f = await fixture(true); await f.publishShow(); await f.publishEpisode();
  const old = await (await readSite(f)).text(), feed = f.feed(), update = await f.showUpdate();
  if (fault === "html") f.bucketHooks.afterPut = async (key) => { if (key.includes("/sites/")) throw new Error("Private unknown IO"); };
  if (fault === "media-purge") f.hooks.purge = async () => { throw new Error("Unknown media purge"); };
  if (fault === "site-purge") f.hooks.sitePurge = async () => { throw new Error("Unknown site purge"); };
  expect((await f.run(update)).state).toBe("blocked");
  expect(f.content.sites.build(update.job_id)).toMatchObject({ media_purged: fault === "site-purge" ? 1 : 0, site_purged: 0 });
  expect(f.feed()).toBe(feed); expect(await (await readSite(f)).text()).toBe(old);
  const calls = f.calls.length, purges = f.purges.length, sitePurges = f.sitePurges.length;
  expect((await new SqlitePublicationAlarm(f.queue, f.executor, () => {}).alarm()).state).toBe("blocked");
  expect(f.calls).toHaveLength(calls); expect(f.purges).toHaveLength(purges); expect(f.sitePurges).toHaveLength(sitePurges);
  expect(JSON.stringify(f.events)).not.toContain("Private unknown IO");
});

test("site continuation scheduling failure never promotes partial pages or authorizes a replay", async () => {
  const f = await fixture(true); await f.publishShow();
  for (let index = 0; index < 20; index++) await f.publishEpisode(`ep-${index}`);
  const old = await (await readSite(f)).text(), request = await f.showUpdate();
  await f.queue.enqueue(request); f.clearAlarm(); f.failAlarm();
  expect((await f.runner.alarm()).state).toBe("blocked");
  expect(await (await readSite(f)).text()).toBe(old);
  const writes = f.calls.filter((call) => call.method === "PUT").length;
  expect((await f.runner.alarm()).state).toBe("blocked");
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(writes);
});

for (const kind of ["show", "episode"] as const) {
  test(`${kind} revision adoption appends a new committed record without recopying saved media`, async () => {
    const f = await fixture(), originalShow = await f.publishShow(), originalEpisode = await f.publishEpisode();
    if (kind === "show") await f.run(await f.showUpdate());
    else {
      const update = await f.request("episode", "first", originalEpisode.job_id, "both");
      update.payloads[0] = await f.payload(update.job_id, "episode_metadata", stringifyToml({ ...metadata("first"), title: "Corrected title" }));
      await f.run(update);
    }
    const id = kind === "show" ? originalShow.job_id : originalEpisode.job_id;
    const request = revisionRequest(f, id, kind === "episode" ? "first" : undefined);
    f.calls.length = 0;
    expect((await f.run(request)).state).toBe("succeeded");
    expect(f.calls.some((call) => call.method === "PUT" && (call.key.endsWith(".mp3") || call.key.includes("/covers/")))).toBe(false);
    const history = kind === "show" ? f.content.listShowRevisions("daily", f.config.public_base_url).items :
      f.content.listEpisodeRevisions("daily", "first", f.config.public_base_url).items;
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ revision_id: request.job_id, restored_from_revision_id: id, is_current: true });
    expect(history[2]).toMatchObject({ revision_id: id, is_current: false });
  });

  for (const phase of ["revision", "feed", "purge", "commit"] as const) {
    test(`${kind} revision ${phase} failure keeps old delivery and history without replay`, async () => {
      const f = await fixture(), originalShow = await f.publishShow(), originalEpisode = await f.publishEpisode();
      if (kind === "show") await f.run(await f.showUpdate());
      else await f.run(await f.request("episode", "first", originalEpisode.job_id, "audio"));
      const request = revisionRequest(f, kind === "show" ? originalShow.job_id : originalEpisode.job_id, kind === "episode" ? "first" : undefined);
      const body = f.feed(), cover = await (await readPublic(f, "/podcasts/daily/cover.jpg")).arrayBuffer();
      const before = f.storage.sql.exec(`SELECT * FROM publication_${kind}_revisions`).toArray();
      if (phase === "revision" || phase === "feed") f.bucketHooks.afterPut = async (key) => {
        if (key.includes(phase === "revision" ? "/revisions/" : "/feeds/")) throw new Error("Unknown output");
      };
      if (phase === "purge") f.hooks.purge = async () => { throw new Error("Unknown purge"); };
      if (phase === "commit") {
        await f.queue.enqueue(request); await f.queue.enqueue(await f.request("episode", "later")); f.clearAlarm();
        f.hooks.purge = async () => { f.failAlarm(); };
        await expect(f.runner.alarm()).rejects.toThrow();
      } else expect((await f.run(request)).state).toBe("blocked");
      expect(f.storage.sql.exec(`SELECT * FROM publication_${kind}_revisions`).toArray()).toEqual(before);
      expect(await (await readPublic(f)).text()).toBe(body);
      expect(await (await readPublic(f, "/podcasts/daily/cover.jpg")).arrayBuffer()).toEqual(cover);
      const queue = new SqlitePublicationQueue(f.storage, f.runtime), content = new SqlitePublicationContent(f.storage);
      const runner = new SqlitePublicationAlarm(queue, createSqlitePublicationExecutor(content, f.bucket, f.config, { purge: async () => {} }), () => {});
      const calls = f.calls.length;
      expect((await runner.alarm()).state).toBe("blocked"); expect(f.calls).toHaveLength(calls);
    });
  }

  test(`${kind} revision preview base is invalidated by lifecycle ABA before output writes`, async () => {
    const f = await fixture(), show = await f.publishShow(), episode = await f.publishEpisode();
    const request = revisionRequest(f, kind === "show" ? show.job_id : episode.job_id, kind === "episode" ? "first" : undefined);
    await f.run(f.lifecycle("unpublish", kind === "episode" ? "first" : undefined));
    await f.run(f.lifecycle("restore", kind === "episode" ? "first" : undefined));
    f.calls.length = 0;
    expect(await f.run(request)).toMatchObject({ state: "failed", reason_code: "base_conflict" });
    expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
  });

  test(`${kind} revision of an unpublished target stays unavailable until completion`, async () => {
    const f = await fixture(), show = await f.publishShow(), episode = await f.publishEpisode();
    await f.run(f.lifecycle("unpublish", kind === "episode" ? "first" : undefined));
    const request = revisionRequest(f, kind === "show" ? show.job_id : episode.job_id, kind === "episode" ? "first" : undefined);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    f.hooks.purge = async () => { entered.resolve(); await release.promise; };
    const operation = f.run(request);
    try { await entered.promise; expect((await readPublic(f)).status).toBe(503); }
    finally { release.resolve(); }
    expect((await operation).state).toBe("succeeded"); expect((await readPublic(f)).status).toBe(200);
  });
}

test("saved revision metadata has an independent bounded read budget rather than a new input limit", async () => {
  const f = await fixture(); await f.publishShow(); const original = await f.publishEpisode();
  const key = `public/episodes/daily/first/revisions/${original.job_id}.toml`;
  await f.bucket.put(key, `${f.text(key)}\n# ${"x".repeat(1_000_000)}\n`);
  expect((await f.run(revisionRequest(f, original.job_id, "first"))).state).toBe("succeeded");
});

for (const fault of ["missing", "corrupt", "media", "throw", "unknown-revision", "oversized"] as const) {
  test(`revision ${fault} validation cannot publish or append history`, async () => {
    const f = await fixture(); await f.publishShow(); const original = await f.publishEpisode();
    const request = revisionRequest(f, fault === "unknown-revision" ? crypto.randomUUID() : original.job_id, "first");
    const key = `public/episodes/daily/first/revisions/${original.job_id}.toml`;
    if (fault === "missing") f.entries.delete(key);
    if (fault === "corrupt") await f.bucket.put(key, "invalid metadata");
    if (fault === "media") f.entries.delete(`public/podcasts/daily/episodes/first/${original.job_id}.mp3`);
    if (fault === "throw") f.bucketHooks.beforeGet = async () => { throw new Error("Private body secret"); };
    if (fault === "oversized") await f.bucket.put(key, "x".repeat(8_388_609));
    f.calls.length = 0;
    expect((await f.run(request)).state).toBe(fault === "throw" ? "blocked" : "failed");
    expect(f.content.listEpisodeRevisions("daily", "first", f.config.public_base_url).items).toHaveLength(1);
    expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
    expect(JSON.stringify(f.events)).not.toContain("Private body secret");
  });
}

test("admission stop drains a running publication while serving only committed generations", async () => {
  const value = await fixture(); await value.publishShow(); const old = await value.publishEpisode();
  const previousFeed = value.feed(), next = await value.request("episode", "second");
  await value.queue.enqueue(next); await value.control("admission-pause");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
  value.hooks.purge = async () => { enter(); await released; };
  value.clearAlarm(); const pending = value.runner.alarm(); await entered;
  try {
    const response = await readPublic(value); expect(response.status).toBe(200); expect(await response.text()).toBe(previousFeed!);
    expect((await readPublic(value, "/podcasts/daily/cover.jpg")).status).toBe(200);
    expect((await readPublic(value, `/podcasts/daily/episodes/first/${old.job_id}.mp3`)).status).toBe(200);
    expect((await readPublic(value, `/podcasts/daily/episodes/second/${next.job_id}.mp3`)).status).toBe(404);
    await expect(value.control("resume")).rejects.toThrow("drained");
    await value.control("pause"); expect((await readPublic(value)).status).toBe(503);
    await expect(value.control("delivery-resume")).rejects.toThrow("drained");
  } finally { release(); }
  expect((await pending).state).toBe("succeeded");
  expect(value.queue.snapshot()).toMatchObject({ state: "paused", drained: true, admission_window_id: value.windowId });
  await value.control("delivery-resume");
  expect(await (await readPublic(value)).text()).not.toBe(previousFeed!);
  expect((await readPublic(value, `/podcasts/daily/episodes/second/${next.job_id}.mp3`)).status).toBe(200);
});

for (const action of ["initial", "unpublish", "restore"] as const) {
  test(`admission stop does not allow delivery during ${action} publication or its uncertain interruption`, async () => {
    const value = await fixture();
    if (action !== "initial") { await value.publishShow(); await value.publishEpisode(); }
    if (action === "restore") await value.run(value.lifecycle("unpublish", "first"));
    const request = action === "initial" ? await value.request("show") : value.lifecycle(action, "first");
    await value.queue.enqueue(request); await value.control("admission-pause");
    expect(value.queue.claim().state).toBe("claimed");
    expect((await readPublic(value)).status).toBe(503);
    await value.queue.block(request.job_id, "execution_interrupted");
    expect((await readPublic(value)).status).toBe(503);
    await expect(value.control("resume")).rejects.toThrow("drained");
  });
}

test("admission stop preserves only verified blocked reads and still rejects broken guards", async () => {
  const value = await fixture(); await value.publishShow(); await value.publishEpisode();
  const oldFeed = value.feed(), request = await value.request("episode", "second");
  await value.queue.enqueue(request); await value.control("admission-pause");
  value.hooks.purge = async () => { throw new Error("Injected purge failure"); };
  value.clearAlarm(); expect((await value.runner.alarm()).state).toBe("blocked");
  expect(await (await readPublic(value)).text()).toBe(oldFeed!);
  value.storage.sql.exec("UPDATE publication_jobs SET read_request_sha256 = ? WHERE job_id = ?", "f".repeat(64), request.job_id);
  expect((await readPublic(value)).status).toBe(503);
});

test("domain Feed reservations cannot collide with later publication or change cover and revision identity", async () => {
  const value = await fixture();
  reserveSqliteFeedGeneration(value.storage, { kind: "domain", id: crypto.randomUUID(), showId: "daily", requestSha256: "f".repeat(64) });
  await value.publishShow();
  expect(value.content.inspect("daily").show!.feed_generation).toBe(2);
  expect(value.entries.has(sqliteCoverSnapshotKey("daily", 1, "jpg"))).toBe(true);
  expect(value.entries.has(sqliteFeedSnapshotKey("daily", 2))).toBe(true);
  const episode = await value.publishEpisode();
  expect(value.content.inspect("daily", "first").base!.revision_id).toBe(episode.job_id);
  expect(value.content.inspect("daily").show!.feed_generation).toBe(3);
  const update = await value.showUpdate(); expect((await value.run(update)).state).toBe("succeeded");
  expect(value.entries.has(sqliteCoverSnapshotKey("daily", 3, "jpg"))).toBe(true);
  expect(value.content.inspect("daily").show!.feed_generation).toBe(4);
  expect((await value.run(value.lifecycle("unpublish", "first"))).state).toBe("succeeded");
  expect(value.content.inspect("daily").show!.feed_generation).toBe(5);
});

test("Episode lifecycle removes all revision delivery and restores the same snapshot without audio or metadata writes", async () => {
  const value = await fixture(); await value.publishShow(); const first = await value.publishEpisode(); await value.publishEpisode("second");
  const update = await value.request("episode", "first", first.job_id);
  expect((await value.run(update)).state).toBe("succeeded");
  const base = value.content.inspect("daily", "first").base!, paths = [first.job_id, update.job_id].map((id) => `/podcasts/daily/episodes/first/${id}.mp3`);
  const previous = value.content.delivery(paths[0]);
  const preserved = new Map([...value.entries].filter(([key]) => key.endsWith(".mp3") || key.endsWith(".toml")).map(([key, object]) => [key, object.etag]));
  value.calls.length = 0;
  const stop = value.lifecycle("unpublish", "first"); expect((await value.run(stop)).state).toBe("succeeded");
  for (const path of paths) expect(value.content.delivery(path).status).toBe(404);
  expect(value.feed()).not.toContain("Private first");
  expect(value.feed()).toContain("Private second");
  expect(value.purges.at(-1)).toEqual({ showId: "daily", cover: false, episodeId: "first" });
  expect((await value.run(value.lifecycle("restore", "first"))).state).toBe("succeeded");
  expect(value.content.inspect("daily", "first").base).toEqual(base);
  expect(value.feed()).toContain("Private first");
  for (const path of paths) expect(value.content.delivery(path).status).toBe(200);
  expect(value.content.delivery(paths[0])).not.toEqual(previous);
  for (const [key, etag] of preserved) expect(value.entries.get(key)!.etag).toBe(etag);
  expect(value.calls.filter((call) => call.method === "PUT").every((call) => /\/feeds\/\d+\.xml$/.test(call.key))).toBe(true);
  const puts = value.calls.filter((call) => call.method === "PUT").length;
  expect((await value.queue.enqueue(stop)).state).toBe("succeeded"); value.clearAlarm(); await value.runner.alarm();
  expect(value.calls.filter((call) => call.method === "PUT")).toHaveLength(puts);
});

for (const action of ["addition", "metadata", "restore"] as const) test(`post-operation inventory rejects overflowing ${action} without blocking the next job`, async () => {
  const value = await fixture(); await value.publishShow(); const first = await value.publishEpisode();
  const base = value.content.inspect("daily", "first").base!;
  if (action === "restore") expect((await value.run(value.lifecycle("unpublish", "first"))).state).toBe("succeeded");
  let characters = action === "restore" ? 0 : JSON.stringify(base).length;
  for (let index = 0; characters < 1_999_800; index++) {
    const id = `seed-${index}`, revisionId = crypto.randomUUID();
    const revision = { ...base, episode_id: id, guid: id, revision_id: revisionId, description: "" };
    revision.description = "a".repeat(Math.min(10_000, 1_999_800 - characters - JSON.stringify(revision).length));
    const source = JSON.stringify(revision);
    value.storage.sql.exec("INSERT INTO publication_episodes (show_id, episode_id, lifecycle, revision_id) VALUES ('daily', ?, 'published', ?)", id, revisionId);
    value.storage.sql.exec("INSERT INTO publication_episode_content VALUES ('daily', ?, ?, ?)", id, revision.guid, source);
    characters += source.length;
  }
  expect(value.content.episodes("daily").length).toBeGreaterThan(1);
  const next = action === "restore" ? value.lifecycle("restore", "first") : await value.request("episode",
    action === "addition" ? "new" : "first", action === "metadata" ? first.job_id : undefined,
    action === "metadata" ? "metadata" : "both");
  if (action === "metadata") next.payloads = [await value.payload(next.job_id, "episode_metadata",
    stringifyToml({ ...metadata("first"), description: "a".repeat(10_000) }))];
  value.calls.length = 0; const purges = value.purges.length;
  expect(await value.run(next)).toMatchObject({ state: "failed", reason_code: "validation_failed" });
  expect(value.calls.some((call) => call.method === "PUT")).toBe(false);
  expect(value.purges).toHaveLength(purges);
  expect(value.content.episodes("daily").length).toBeGreaterThan(1);
  expect((await value.run(value.lifecycle("unpublish"))).state).toBe("succeeded");
  expect(value.queue.snapshot().drained).toBe(true);
});

test("Show unpublish does not read or render the Episode inventory", async () => {
  const value = await fixture(); await value.publishShow();
  value.content.episodes = () => { throw new Error("Episode inventory must not be read"); };
  expect((await value.run(value.lifecycle("unpublish"))).state).toBe("succeeded");
});

test("Show restore never revives individually unpublished Episodes, including child stops while the Show is hidden", async () => {
  const value = await fixture(); await value.publishShow(); const first = await value.publishEpisode(); const second = await value.publishEpisode("second"); await value.publishEpisode("third");
  expect((await value.run(value.lifecycle("unpublish", "first"))).state).toBe("succeeded");
  expect((await value.run(value.lifecycle("unpublish"))).state).toBe("succeeded");
  expect(value.content.delivery("/podcasts/daily/feed.xml").status).toBe(404);
  expect(value.content.delivery("/podcasts/daily/cover.jpg").status).toBe(404);
  value.calls.length = 0;
  expect((await value.run(value.lifecycle("unpublish", "second"))).state).toBe("succeeded");
  expect(value.calls.some((call) => call.method === "PUT")).toBe(false);
  expect(await value.run(value.lifecycle("restore", "first"))).toMatchObject({ state: "failed", reason_code: "target_unavailable" });
  expect((await value.run(value.lifecycle("restore"))).state).toBe("succeeded");
  const feed = value.feed();
  expect(feed).toContain("Private third"); expect(feed).not.toContain("Private first"); expect(feed).not.toContain("Private second");
  for (const request of [first, second]) expect(value.content.delivery(`/podcasts/daily/episodes/${request.episode_id}/${request.job_id}.mp3`).status).toBe(404);
});

test("lifecycle versions prevent Episode ABA without invalidating unrelated Episode drafts", async () => {
  const value = await fixture(); await value.publishShow(); const first = await value.publishEpisode(); const second = await value.publishEpisode("second");
  const old = await value.request("episode", "first", first.job_id, "metadata"), unrelated = await value.request("episode", "second", second.job_id, "metadata");
  const oldStop = value.lifecycle("unpublish", "first");
  expect((await value.run(value.lifecycle("unpublish", "first"))).state).toBe("succeeded");
  expect((await value.run(value.lifecycle("restore", "first"))).state).toBe("succeeded");
  expect(await value.run(old)).toMatchObject({ state: "failed", reason_code: "base_conflict" });
  expect(await value.run(oldStop)).toMatchObject({ state: "failed", reason_code: "base_conflict" });
  expect((await value.run(unrelated)).state).toBe("succeeded");
  const current = value.content.inspect("daily", "first"), fresh = await value.request("episode", "first", first.job_id, "metadata");
  expect((await value.run({ ...fresh, expected_episode_lifecycle_version: current.episode!.lifecycle_version })).state).toBe("succeeded");
});

test("lifecycle purge keeps the target gated and completion pending, then blocks the FIFO on failure", async () => {
  const value = await fixture(); await value.publishShow(); await value.publishEpisode();
  const stop = value.lifecycle("unpublish", "first"), next = value.lifecycle("unpublish");
  await value.queue.enqueue(stop); await value.queue.enqueue(next); value.clearAlarm();
  let reject!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  value.hooks.purge = () => { entered(); return new Promise<void>((_, fail) => { reject = () => fail(new Error("private diagnostic")); }); };
  const running = value.runner.alarm(); await started;
  expect(value.queue.status(stop.request_id)!.state).toBe("running");
  expect(value.content.inspect("daily", "first").episode!.lifecycle).toBe("published");
  expect(value.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
  reject(); expect(await running).toMatchObject({ state: "blocked", reason_code: "execution_failed" });
  const count = value.calls.length; await value.runner.alarm();
  expect(value.calls).toHaveLength(count); expect(value.queue.status(next.request_id)!.state).toBe("queued");
  expect(JSON.stringify(value.events)).not.toContain("private diagnostic");
});

test("restore refuses missing immutable media before writes and does not silently revive deleted or draft targets", async () => {
  const value = await fixture(); await value.publishShow(); const episode = await value.publishEpisode();
  await value.run(value.lifecycle("unpublish", "first"));
  value.entries.delete(`public/podcasts/daily/episodes/first/${episode.job_id}.mp3`); value.calls.length = 0;
  expect(await value.run(value.lifecycle("restore", "first"))).toMatchObject({ state: "failed", reason_code: "validation_failed" });
  expect(value.calls.some((call) => call.method === "PUT")).toBe(false);
  const deleted = value.lifecycle("restore", "first");
  value.storage.sql.exec("UPDATE publication_episodes SET lifecycle = 'deleted' WHERE episode_id = 'first'");
  expect(await value.run(deleted)).toMatchObject({ state: "failed", reason_code: "target_unavailable" });
});

test("lifecycle SQL completion and next Alarm roll back together, and interrupted IO is never rerun", async () => {
  const value = await fixture(); await value.publishShow(); await value.publishEpisode();
  const stop = value.lifecycle("unpublish", "first"), next = value.lifecycle("unpublish");
  await value.queue.enqueue(stop); await value.queue.enqueue(next); value.clearAlarm(); value.failAlarm();
  await expect(value.runner.alarm()).rejects.toThrow();
  expect(value.queue.status(stop.request_id)!.state).toBe("running");
  expect(value.content.inspect("daily", "first").episode!.lifecycle).toBe("published");
  const count = value.calls.length;
  const restarted = new SqlitePublicationAlarm(value.queue, value.executor, () => {});
  expect(await restarted.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_interrupted" });
  expect(value.calls).toHaveLength(count); expect(value.queue.status(next.request_id)!.state).toBe("queued");
});

test("real executor publishes a registered Show and Episode using no R2 lock/status records", async () => {
  const setup = await fixture();
  expect(setup.content.delivery("/podcasts/daily/feed.xml")).toEqual({ status: 404 });
  await setup.publishShow();
  const episode = await setup.publishEpisode();
  const current = parseEpisodeRevision(setup.text("public/episodes/daily/first/metadata.toml"));
  expect(current.revision_id).toBe(episode.job_id);
  expect(current.enclosure_url).toBe(`${setup.config.public_base_url}/podcasts/daily/episodes/first/${episode.job_id}.mp3`);
  expect(setup.content.episodes("daily")).toEqual([current]);
  expect(setup.feed()).toContain('<guid isPermaLink="false">stable-first</guid>');
  expect(setup.feed()).toContain("Fri, 16 Oct 2026 03:00:00 GMT");
  expect(setup.purges).toEqual([{ showId: "daily", cover: true }, { showId: "daily", cover: false, episodeId: "first" }]);
  expect(setup.calls.some((call) => /^system\/(?:jobs|show-publications|lifecycle-service|episode-lifecycle|management-requests)/.test(call.key))).toBe(false);
  expect([...setup.entries.keys()].some((key) => key.endsWith("commit.json"))).toBe(false);
  expect(setup.content.delivery(`/podcasts/daily/episodes/first/${episode.job_id}.mp3`).status).toBe(200);
  expect(setup.content.delivery(`/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`).status).toBe(404);
  expect(setup.content.delivery("/system/shows/daily/show.toml").status).toBe(404);
  expect(setup.content.delivery("/staging/uploads/daily/audio.mp3").status).toBe(404);
});

test("XML-invalid Show and Episode payloads fail validation before any publication writes", async () => {
  const setup = await fixture();
  for (const kind of ["show", "episode"] as const) {
    if (kind === "episode") await setup.publishShow();
    const request = await setup.request(kind);
    const source = kind === "show" ? { ...show, title: "private\u0000title" } : { ...metadata("first"), description: "private\u0008description" };
    request.payloads[0] = await setup.payload(request.job_id, kind === "show" ? "show_metadata" : "episode_metadata", stringifyToml(source));
    const before = new Map(setup.entries);
    const purges = setup.purges.length;
    setup.calls.length = 0;
    expect(await setup.run(request)).toMatchObject({ state: "failed", reason_code: "validation_failed" });
    expect(setup.calls.some((call) => call.method === "PUT")).toBe(false);
    expect(setup.entries).toEqual(before);
    expect(setup.purges).toHaveLength(purges);
    expect(setup.queue.snapshot().drained).toBe(true);
    expect(JSON.stringify(setup.queue.status(request.request_id))).not.toContain("private");
  }
});

test("Apple-based input limits fail validation before any publication writes", async () => {
  const setup = await fixture();
  for (const kind of ["show", "episode"] as const) {
    if (kind === "episode") await setup.publishShow();
    const request = await setup.request(kind);
    const source = kind === "show" ? { ...show, description: "あ".repeat(1334) } : { ...metadata("first"), description: "d".repeat(10001) };
    request.payloads[0] = await setup.payload(request.job_id, kind === "show" ? "show_metadata" : "episode_metadata", stringifyToml(source));
    const before = new Map(setup.entries);
    setup.calls.length = 0;
    expect(await setup.run(request)).toMatchObject({ state: "failed", reason_code: "validation_failed" });
    expect(setup.calls.some((call) => call.method === "PUT")).toBe(false);
    expect(setup.entries).toEqual(before);
  }
});

test("metadata-only publishes no audio and preserves immutable history, GUID, time and enclosure", async () => {
  const setup = await fixture();
  await setup.publishShow();
  const first = await setup.publishEpisode();
  const base = setup.content.episodes("daily")[0], originalAudio = setup.entries.get(`public${new URL(base.enclosure_url).pathname}`)!;
  const update = await setup.request("episode", "first", first.job_id, "metadata");
  update.payloads[0] = await setup.payload(update.job_id, "episode_metadata", stringifyToml({ ...metadata("first"), title: "Updated title" }));
  setup.calls.length = 0;
  expect((await setup.run(update)).state).toBe("succeeded");
  const current = setup.content.episodes("daily")[0];
  expect(current).toMatchObject({ ...episodeDraftFromRevision(base), title: "Updated title", enclosure_url: base.enclosure_url,
    sha256: base.sha256, length_bytes: base.length_bytes, duration_seconds: base.duration_seconds, revision_id: update.job_id });
  expect(setup.entries.get(originalAudio.key)).toBe(originalAudio);
  expect(setup.calls.filter((call) => call.method === "PUT" && call.key.endsWith(".mp3"))).toEqual([]);
  expect(setup.entries.has(`public/episodes/daily/first/revisions/${first.job_id}.toml`)).toBe(true);
  expect(setup.entries.has(`public/episodes/daily/first/revisions/${update.job_id}.toml`)).toBe(true);
});

test("audio-only advances the audio URL without changing metadata and keeps old media deliverable", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  const previous = setup.content.episodes("daily")[0];
  const update = await setup.request("episode", "first", first.job_id, "audio");
  expect((await setup.run(update)).state).toBe("succeeded");
  const current = setup.content.episodes("daily")[0];
  expect(episodeDraftFromRevision(current)).toEqual(episodeDraftFromRevision(previous));
  expect(current.enclosure_url).not.toBe(previous.enclosure_url);
  expect(setup.content.delivery(new URL(previous.enclosure_url).pathname).status).toBe(200);
  expect(setup.content.delivery(new URL(current.enclosure_url).pathname).status).toBe(200);
});

test("multiple different Episodes run FIFO without invalidating the shared Show state version", async () => {
  const setup = await fixture(); await setup.publishShow();
  const requests = await Promise.all(["first", "second", "third"].map((id) => setup.request("episode", id)));
  for (const value of requests) await setup.queue.enqueue(value);
  for (const value of requests) {
    setup.clearAlarm(); expect((await setup.runner.alarm()).state).toBe("succeeded");
    expect(setup.queue.status(value.request_id)?.state).toBe("succeeded");
  }
  expect(setup.content.episodes("daily").map((revision) => revision.episode_id)).toEqual(["first", "second", "third"]);
  expect((setup.events as Array<{ phase: string; job_id: string }>).filter((event) => event.phase === "started").slice(1).map((event) => event.job_id)).toEqual(requests.map((value) => value.job_id));
});

test("the second update from the same Episode base fails before writes and the next target can run", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  const updates = await Promise.all([setup.request("episode", "first", first.job_id, "metadata"),
    setup.request("episode", "first", first.job_id, "metadata"), setup.request("episode", "second")]);
  for (const request of updates) await setup.queue.enqueue(request);
  setup.clearAlarm(); expect((await setup.runner.alarm()).state).toBe("succeeded");
  setup.calls.length = 0;
  setup.clearAlarm(); expect(await setup.runner.alarm()).toMatchObject({ state: "failed", reason_code: "base_conflict" });
  expect(setup.calls.filter((call) => call.method === "PUT")).toEqual([]);
  setup.clearAlarm(); expect((await setup.runner.alarm()).state).toBe("succeeded");
});

for (const change of [{ guid: "other-guid" }, { published_at: "2026-10-17T12:00:00Z" }, { guid_is_permalink: true }]) {
  test("published Episode identity cannot be changed by a metadata update", async () => {
    const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
    const update = await setup.request("episode", "first", first.job_id, "metadata");
    update.payloads[0] = await setup.payload(update.job_id, "episode_metadata", stringifyToml({ ...metadata("first"), ...change }));
    setup.calls.length = 0;
    expect(await setup.run(update)).toMatchObject({ state: "failed", reason_code: "validation_failed" });
    expect(setup.calls.some((call) => call.method === "PUT")).toBe(false);
  });
}

test("duplicate GUID, orphan outputs and replaced staging objects are rejected before public writes", async () => {
  const setup = await fixture(); await setup.publishShow(); await setup.publishEpisode();
  const duplicate = await setup.request("episode", "second");
  duplicate.payloads[0] = await setup.payload(duplicate.job_id, "episode_metadata", stringifyToml({ ...metadata("second"), guid: "stable-first" }));
  expect(await setup.run(duplicate)).toMatchObject({ state: "failed", reason_code: "validation_failed" });
  const orphan = await setup.request("episode", "third");
  await setup.bucket.put("public/episodes/daily/third/metadata.toml", "orphan");
  setup.calls.length = 0;
  expect(await setup.run(orphan)).toMatchObject({ state: "failed", reason_code: "validation_failed" });
  expect(setup.calls.some((call) => call.method === "PUT")).toBe(false);
  const replacement = await setup.request("episode", "fourth");
  await setup.bucket.put(replacement.payloads[0].key, "replacement");
  expect(await setup.run(replacement)).toMatchObject({ state: "failed", reason_code: "validation_failed" });
});

test("purge failure blocks later jobs but preserves committed delivery after a candidate Feed was written", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  const update = await setup.request("episode", "first", first.job_id, "metadata"), next = await setup.request("episode", "second");
  await setup.queue.enqueue(update); await setup.queue.enqueue(next);
  setup.hooks.purge = async () => { throw new Error("Private title private@example.com secret"); };
  setup.clearAlarm(); expect(await setup.runner.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_failed" });
  expect(setup.content.episodes("daily")[0].revision_id).toBe(first.job_id);
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(200);
  expect(setup.content.delivery(`/podcasts/daily/episodes/first/${first.job_id}.mp3`).status).toBe(200);
  setup.calls.length = 0;
  expect((await setup.runner.alarm()).state).toBe("blocked");
  expect(setup.calls).toEqual([]);
  expect(setup.queue.status(next.request_id)?.state).toBe("queued");
  expect(JSON.stringify(setup.events)).not.toMatch(/Private title|private@example|secret/);
  expect(setup.effectFailures).toEqual([{ event: "sqlite_publication_effect_failed", job_id: update.job_id,
    request_id: update.request_id, phase: "cache_purge", reason_code: "publication_effect_unverified" }]);
  expect(JSON.stringify(setup.effectFailures)).not.toMatch(/Private title|private@example|secret/);
});

test("purge rejection waiting retains the running job and old Feed without replaying R2 output", async () => {
  const setup = await fixture(); await setup.publishShow();
  const episode = await setup.request("episode");
  let calls = 0, enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
  setup.hooks.purge = () => purgeSqliteCache({ async purge() { return { success: ++calls === 2, errors: [{ code: 999, message: "Rate limit exceeded" }] }; } }, { showId: "daily", episodeId: "first" }, {
    delay: async (milliseconds) => { expect(milliseconds).toBe(12000); enter(); await released; }, onEvent: () => {},
  });
  setup.calls.length = 0;
  const running = setup.run(episode);
  await entered;
  try {
    expect(setup.queue.status(episode.request_id)?.state).toBe("running");
    expect(setup.queue.snapshot().drained).toBe(false);
    expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(200);
    expect(setup.content.episodes("daily")).toEqual([]);
    expect(await setup.runner.alarm()).toEqual({ state: "busy" });
  } finally { release(); }
  expect((await running).state).toBe("succeeded");
  expect(setup.calls.filter((call) => call.method === "PUT").map((call) => call.key)).toEqual([
    `public/podcasts/daily/episodes/first/${episode.job_id}.mp3`,
    `public/episodes/daily/first/revisions/${episode.job_id}.toml`, "public/episodes/daily/first/metadata.toml", sqliteFeedSnapshotKey("daily", 2),
  ]);
  expect(calls).toBe(2);
  expect(setup.effectFailures).toEqual([]);
});

test("36 sequential publications tolerate acknowledged purge throttling without duplicate media writes", async () => {
  const setup = await fixture(); await setup.publishShow();
  let tokens = 25, waits = 0, purges = 0;
  setup.hooks.purge = () => purgeSqliteCache({ async purge() {
    purges++; const success = tokens > 0; if (success) tokens--;
    return { success, errors: success ? [] : [{ code: 999, message: "Rate limit exceeded" }] };
  } }, { showId: "daily" }, { delay: async (milliseconds) => { expect(milliseconds).toBe(12000); tokens++; waits++; }, onEvent: () => {} });
  setup.calls.length = 0;
  for (let index = 0; index < 36; index++) await setup.publishEpisode(`episode-${index}`);
  expect(setup.content.episodes("daily")).toHaveLength(36);
  expect(setup.calls.filter((call) => call.method === "PUT" && call.key.startsWith("public/") && call.key.endsWith(".mp3"))).toHaveLength(36);
  expect(waits).toBe(11);
  expect(purges).toBe(47);
  expect(setup.queue.snapshot().drained).toBe(true);
});

test("an unknown write blocks without overwriting history or retrying any output", async () => {
  const setup = await fixture(); await setup.publishShow();
  const episode = await setup.request("episode");
  setup.calls.length = 0;
  setup.bucketHooks.afterPut = async (key) => {
    if (key.endsWith(".mp3")) throw new Error("Unknown result after immutable media write");
  };
  await setup.queue.enqueue(episode); setup.clearAlarm();
  expect(await setup.runner.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_failed" });
  const writes = setup.calls.filter((call) => call.method === "PUT");
  expect(writes).toHaveLength(1);
  expect(setup.effectFailures).toEqual([{ event: "sqlite_publication_effect_failed", job_id: episode.job_id,
    request_id: episode.request_id, phase: "audio", reason_code: "publication_effect_unverified" }]);
  expect((await setup.runner.alarm()).state).toBe("blocked");
  expect(setup.calls.filter((call) => call.method === "PUT")).toEqual(writes);
});

test("completion and the content index roll back together when scheduling the next Alarm fails", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  const update = await setup.request("episode", "first", first.job_id, "metadata"), next = await setup.request("episode", "second");
  await setup.queue.enqueue(update); await setup.queue.enqueue(next); setup.clearAlarm();
  setup.hooks.purge = async () => { setup.failAlarm(); };
  await expect(setup.runner.alarm()).rejects.toThrow("scheduling failure");
  expect(setup.queue.status(update.request_id)?.state).toBe("running");
  expect(setup.content.episodes("daily")[0].revision_id).toBe(first.job_id);
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(200);
  expect(await setup.runner.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_interrupted" });
  expect(setup.queue.status(next.request_id)?.state).toBe("queued");
});

test("running additions preserve delivery until explicitly paused and accepted jobs can drain paused", async () => {
  const setup = await fixture(); await setup.publishShow();
  const first = await setup.request("episode", "first"), second = await setup.request("episode", "second");
  let enter!: () => void, release!: () => void, enterPurge!: () => void, releasePurge!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; }), released = new Promise<void>((resolve) => { release = resolve; });
  const purging = new Promise<void>((resolve) => { enterPurge = resolve; }), purged = new Promise<void>((resolve) => { releasePurge = resolve; });
  setup.bucketHooks.beforePut = async (key) => { if (key.startsWith("public/") && key.endsWith(".mp3")) { enter(); await released; } };
  setup.hooks.purge = async () => { enterPurge(); await purged; };
  await setup.queue.enqueue(first); setup.clearAlarm();
  const running = setup.runner.alarm();
  await entered;
  try {
    await setup.queue.enqueue(second);
    expect(setup.queue.status(first.request_id)?.state).toBe("running");
    expect(setup.queue.status(second.request_id)?.state).toBe("queued");
    expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(200);
    expect(setup.content.episodes("daily")).toEqual([]);
    expect(await setup.runner.alarm()).toEqual({ state: "busy" });
    setup.queue.pause();
    release(); await purging;
    expect(setup.queue.status(first.request_id)?.state).toBe("running");
    expect(setup.content.episodes("daily")).toEqual([]);
  } finally { release(); releasePurge(); await running; }
  expect(setup.queue.status(first.request_id)?.state).toBe("succeeded");
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
  setup.hooks.purge = undefined; setup.bucketHooks.beforePut = undefined;
  setup.clearAlarm(); expect((await setup.runner.alarm()).state).toBe("succeeded");
  expect(setup.queue.snapshot()).toMatchObject({ state: "paused", drained: true });
  setup.queue.resume(crypto.randomUUID());
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(200);
});

test("the binding verifies streamed audio checksums without buffering MP3 in the executor", async () => {
  const setup = await fixture(); await setup.publishShow();
  const episode = await setup.request("episode");
  const audio = episode.payloads.find((payload) => payload.asset === "audio")!;
  const object = setup.entries.get(audio.key)!;
  object.bytes = new Uint8Array(object.bytes.length);
  setup.calls.length = 0;
  expect(await setup.run(episode)).toMatchObject({ state: "blocked", reason_code: "execution_failed" });
  expect(setup.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(setup.entries.has(`public/podcasts/daily/episodes/first/${episode.job_id}.mp3`)).toBe(false);
  expect(setup.content.episodes("daily")).toEqual([]);
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(200);
});

test("invalid content schema and corrupt frozen requests never reset content or execute an effect", async () => {
  const setup = await fixture(); await setup.publishShow();
  setup.storage.sql.exec("UPDATE publication_content_schema SET version = 99 WHERE id = 1");
  expect(() => new SqlitePublicationContent(setup.storage)).toThrow("Unsupported");
  expect(setup.content.registerShow("daily", setup.reservationId).state_version).toBe(1);
  const episode = await setup.request("episode");
  await setup.queue.enqueue(episode);
  setup.storage.sql.exec("UPDATE publication_jobs SET request_json = '{invalid' WHERE job_id = ?", episode.job_id);
  setup.calls.length = 0;
  expect(await setup.runner.alarm()).toMatchObject({ state: "blocked", reason_code: "stored_request_invalid" });
  expect(setup.calls).toEqual([]);
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
});

test("a valid-shaped but hash-mismatched stored request blocks before validation or public writes", async () => {
  const setup = await fixture(); await setup.publishShow();
  const episode = await setup.request("episode");
  await setup.queue.enqueue(episode);
  setup.storage.sql.exec("UPDATE publication_jobs SET request_sha256 = ? WHERE job_id = ?", "f".repeat(64), episode.job_id);
  setup.calls.length = 0;
  expect(await setup.runner.alarm()).toMatchObject({ state: "blocked", reason_code: "stored_request_invalid" });
  expect(setup.calls).toEqual([]);
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
});

test("Show updates advance only the Show state, regenerate its feed, and preserve the cover extension", async () => {
  const setup = await fixture(); await setup.publishShow(); await setup.publishEpisode();
  const update = await setup.showUpdate();
  setup.calls.length = 0;
  expect((await setup.run(update)).state).toBe("succeeded");
  expect(parseShowMetadata(setup.text("system/shows/daily/show.toml")).title).toBe("Updated Show");
  expect(setup.feed()).toContain("Updated Show");
  expect(setup.feed()).toContain("stable-first");
  expect(setup.content.delivery("/podcasts/daily/cover.jpg").status).toBe(200);
  expect(setup.content.delivery("/podcasts/daily/cover.png").status).toBe(404);
  expect(setup.calls.some((call) => call.key.endsWith(".mp3"))).toBe(false);
  expect(setup.content.registerShow("daily", setup.reservationId).state_version).toBe(2);
});

test("permanent identities cannot be claimed again, and tombstones/paused admission gate delivery", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  expect(() => setup.content.registerShow("daily", crypto.randomUUID())).toThrow("permanent reservation");
  setup.storage.sql.exec("UPDATE publication_episodes SET lifecycle = 'unpublished' WHERE episode_id = 'first'");
  expect(setup.content.delivery(`/podcasts/daily/episodes/first/${first.job_id}.mp3`).status).toBe(404);
  setup.storage.sql.exec("UPDATE publication_episodes SET lifecycle = 'deleted' WHERE episode_id = 'first'");
  expect(setup.content.delivery(`/podcasts/daily/episodes/first/${first.job_id}.mp3`).status).toBe(410);
  const recreate = await setup.request("episode", "first");
  expect(await setup.run(recreate)).toMatchObject({ state: "failed", reason_code: "target_unavailable" });
  setup.storage.sql.exec("UPDATE publication_shows SET lifecycle = 'deleted' WHERE show_id = 'daily'");
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(410);
  expect(setup.content.registerShow("daily", setup.reservationId).lifecycle).toBe("deleted");
  setup.queue.pause();
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
});

for (const selection of ["addition", "metadata", "audio", "both"] as const) {
for (const phase of ["validation", "audio", "revision", "metadata", "snapshot", "purge"] as const) {
  if (selection === "metadata" && phase === "audio") continue;
  test(`${selection} serves the committed Feed during ${phase}, then switches atomically`, async () => {
    const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
    const old = await readPublic(setup), etag = old.headers.get("ETag")!, body = await old.text();
    const oldDecision = setup.content.delivery("/podcasts/daily/feed.xml");
    if (oldDecision.status !== 200) throw new Error("Expected committed Feed");
    const next = selection === "addition" ? await setup.request("episode", "second") :
      await setup.request("episode", "first", first.job_id, selection);
    const episodeId = next.episode_id!;
    if (selection === "metadata") next.payloads = [await setup.payload(next.job_id, "episode_metadata",
      stringifyToml({ ...metadata(episodeId), description: "Updated description" }))];
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const hold = async () => { entered.resolve(); await release.promise; };
    if (phase === "validation") setup.bucketHooks.beforeGet = async (key) => { if (key === next.payloads[0].key) await hold(); };
    if (phase === "audio") setup.bucketHooks.beforePut = async (key) => { if (key.endsWith(`${next.job_id}.mp3`)) await hold(); };
    if (phase === "snapshot") setup.bucketHooks.afterPut = async (key) => { if (key.includes("/feeds/")) await hold(); };
    if (phase === "revision" || phase === "metadata") setup.bucketHooks.afterPut = async (key) => {
      if (phase === "revision" ? key.endsWith(`/revisions/${next.job_id}.toml`) : key.endsWith("/metadata.toml")) await hold();
    };
    if (phase === "purge") setup.hooks.purge = hold;
    const running = setup.run(next);
    try {
      await entered.promise;
      expect(await (await readPublic(setup)).text()).toBe(body);
      expect((await readPublic(setup, undefined, { "If-None-Match": etag })).status).toBe(304);
      expect((await readPublic(setup, `/podcasts/daily/episodes/first/${first.job_id}.mp3`)).status).toBe(200);
      expect((await readPublic(setup, "/podcasts/daily/cover.jpg")).status).toBe(200);
      expect((await readPublic(setup, `/podcasts/daily/episodes/second/${next.job_id}.mp3`)).status).toBe(404);
      expect(setup.queue.status(next.request_id)?.state).toBe("running");
      expect(setup.content.inspect("daily", "first").base!.revision_id).toBe(first.job_id);
      expect((await readPublic(setup, `/podcasts/daily/episodes/${episodeId}/${next.job_id}.mp3`)).status).toBe(404);
    } finally { release.resolve(); await running; }
    const current = await readPublic(setup, undefined, { "If-None-Match": etag });
    expect(current.status).toBe(200); expect(await current.text()).toContain(`Private ${episodeId}`);
    expect((await readPublic(setup, `/podcasts/daily/episodes/${episodeId}/${next.job_id}.mp3`)).status).toBe(selection === "metadata" ? 404 : 200);
    expect((await readPublic(setup, `/podcasts/daily/episodes/first/${first.job_id}.mp3`)).status).toBe(200);
    const late = await serveCachedLifecycleAsset(new Request("https://cache.invalid/podcasts/daily/feed.xml"),
      { CASTLOOP_BUCKET: setup.bucket } as never, oldDecision.cache_props);
    expect(await late.text()).toBe(body);
    expect(setup.entries.has("public/podcasts/daily/feed.xml")).toBe(false);
  });
}
}

for (const update of [false, true]) {
for (const phase of ["validation", "audio", "revision", "metadata", "snapshot", "purge", "commit"] as const) {
  test(`isolated ${update ? "update" : "addition"} ${phase} failure preserves old delivery but never releases the blocked FIFO`, async () => {
    const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
    const old = await (await readPublic(setup)).text(), next = await setup.request("episode", update ? "first" : "second", update ? first.job_id : undefined);
    const later = await setup.request("episode", "third");
    await setup.queue.enqueue(next); await setup.queue.enqueue(later); setup.clearAlarm();
    if (phase === "validation") setup.bucketHooks.beforeGet = async (key) => {
      if (key === next.payloads[0].key) throw new Error("Validation unavailable");
    };
    if (phase === "audio" || phase === "snapshot") setup.bucketHooks.afterPut = async (key) => {
      if (phase === "audio" ? key.endsWith(".mp3") : key.includes("/feeds/")) throw new Error("Unknown output result");
    };
    if (phase === "revision" || phase === "metadata") setup.bucketHooks.afterPut = async (key) => {
      if (phase === "revision" ? key.endsWith(`/revisions/${next.job_id}.toml`) : key.endsWith("/metadata.toml")) throw new Error("Unknown private metadata write");
    };
    if (phase === "purge") setup.hooks.purge = async () => { throw new Error("Unknown purge result"); };
    if (phase === "commit") {
      setup.failAlarm(); await expect(setup.runner.alarm()).rejects.toThrow();
      expect(setup.queue.status(next.request_id)?.state).toBe("running");
    }
    const recoveredQueue = new SqlitePublicationQueue(setup.storage, setup.runtime);
    const recoveredContent = new SqlitePublicationContent(setup.storage);
    const restarted = new SqlitePublicationAlarm(recoveredQueue,
      createSqlitePublicationExecutor(recoveredContent, setup.bucket, setup.config, { purge: async () => { await setup.hooks.purge?.(); } }), () => {});
    expect((await restarted.alarm()).state).toBe("blocked");
    expect(recoveredContent.delivery("/podcasts/daily/feed.xml").status).toBe(200);
    expect(await (await readPublic(setup)).text()).toBe(old);
    expect(setup.content.inspect("daily", "first").base!.revision_id).toBe(first.job_id);
    expect((await readPublic(setup, `/podcasts/daily/episodes/${next.episode_id}/${next.job_id}.mp3`)).status).toBe(404);
    expect((await readPublic(setup, `/podcasts/daily/episodes/second/${next.job_id}.mp3`)).status).toBe(404);
    const count = setup.calls.length; await restarted.alarm(); expect(setup.calls).toHaveLength(count);
    expect(setup.queue.status(later.request_id)?.state).toBe("queued");
    expect(setup.queue.snapshot().drained).toBe(false);
    setup.queue.pause(); expect((await readPublic(setup)).status).toBe(503);
    expect(() => setup.queue.resume(crypto.randomUUID())).toThrow("drained");
    expect(() => setup.queue.resume(setup.windowId!)).toThrow();
  });
}
}

test("read guards fail closed on corruption, changed committed state and missing snapshots", async () => {
  for (const column of ["delivery_policy", "read_request_sha256", "read_show_version", "read_feed_generation", "read_episode_id"] as const) {
    const setup = await fixture(); await setup.publishShow(); const next = await setup.request("episode");
    await setup.queue.enqueue(next); const claim = setup.queue.claim(); expect(claim.state).toBe("claimed");
    expect((await readPublic(setup)).status).toBe(200);
    setup.storage.sql.exec("PRAGMA ignore_check_constraints = ON");
    setup.storage.sql.exec(`UPDATE publication_jobs SET ${column} = ? WHERE job_id = ?`,
      column === "delivery_policy" ? "exclusive" : column.endsWith("version") || column.endsWith("generation") ? 999 : null, next.job_id);
    expect((await readPublic(setup)).status).toBe(503);
  }
  for (const column of ["state_version", "feed_generation", "lifecycle"] as const) {
    const setup = await fixture(); await setup.publishShow(); const next = await setup.request("episode");
    await setup.queue.enqueue(next); setup.queue.claim();
    setup.storage.sql.exec(`UPDATE publication_shows SET ${column} = ? WHERE show_id = 'daily'`, column === "lifecycle" ? "unpublished" : 999);
    expect((await readPublic(setup)).status).toBe(503);
  }
  const setup = await fixture(); await setup.publishShow(); const next = await setup.request("episode");
  await setup.queue.enqueue(next); setup.queue.claim();
  setup.entries.delete(sqliteFeedSnapshotKey("daily", 1));
  const missing = await readPublic(setup); expect(missing.status).toBe(503); expect(missing.headers.get("Cache-Control")).toBe("no-store");
  for (const path of ["/podcasts/daily/feeds/1.xml", "/system/service.toml", "/staging/uploads/secret"]) {
    expect((await readPublic(setup, path)).status).toBe(404);
  }
});

test("invalid frozen policies block before writes and cannot grant committed reads", async () => {
  const setup = await fixture(); await setup.publishShow(); const next = await setup.request("episode");
  await setup.queue.enqueue(next);
  setup.storage.sql.exec("UPDATE publication_jobs SET delivery_policy = 'exclusive' WHERE job_id = ?", next.job_id);
  const before = setup.calls.length;
  expect(await setup.runner.alarm()).toMatchObject({ state: "blocked", reason_code: "stored_request_invalid" });
  expect(setup.calls).toHaveLength(before); expect((await readPublic(setup)).status).toBe(503);
});

test("lifecycle operations without Feed output retain the actual snapshot generation", async () => {
  const setup = await fixture(); await setup.publishShow(); await setup.publishEpisode();
  const generation = setup.content.inspect("daily").show!.feed_generation;
  await setup.run(setup.lifecycle("unpublish"));
  await setup.run(setup.lifecycle("unpublish", "first"));
  expect(setup.content.inspect("daily").show!.feed_generation).toBe(generation);
  await setup.run(setup.lifecycle("restore"));
  expect(setup.content.inspect("daily").show!.feed_generation).toBeGreaterThan(generation);
  expect(await (await readPublic(setup)).text()).not.toContain("Private first");
});

test("old persisted queue and content schemas are rejected without conversion", async () => {
  const setup = await fixture(); await setup.publishShow();
  const before = new Map(setup.entries);
  setup.storage.sql.exec("UPDATE publication_content_schema SET version = 5 WHERE id = 1");
  expect(() => new SqlitePublicationContent(setup.storage)).toThrow("Unsupported");
  expect(setup.storage.sql.exec("SELECT version FROM publication_content_schema").toArray()).toEqual([{ version: 5 }]);
  setup.storage.sql.exec("UPDATE publication_queue_schema SET version = 4 WHERE id = 1");
  expect(() => new SqlitePublicationQueue(setup.storage, setup.runtime)).toThrow("Unsupported");
  expect(setup.storage.sql.exec("SELECT version FROM publication_queue_schema").toArray()).toEqual([{ version: 4 }]);
  expect(setup.entries).toEqual(before);
});

test("existing candidate snapshots are never adopted or overwritten", async () => {
  const setup = await fixture(); await setup.publishShow();
  const next = await setup.request("episode"), key = sqliteFeedSnapshotKey("daily", 2);
  await setup.bucket.put(key, "unapproved candidate");
  const etag = setup.entries.get(key)!.etag, old = setup.feed();
  expect(await setup.run(next)).toMatchObject({ state: "blocked", reason_code: "execution_failed" });
  expect(setup.entries.get(key)!.etag).toBe(etag);
  expect(await (await readPublic(setup)).text()).toBe(old);
});

test("corrupt committed content never receives the verified blocked-read permission", async () => {
  const setup = await fixture(); await setup.publishShow(); const next = await setup.request("episode");
  setup.storage.sql.exec("UPDATE publication_show_content SET metadata_json = '{invalid' WHERE show_id = 'daily'");
  expect(await setup.run(next)).toMatchObject({ state: "blocked", reason_code: "validation_unavailable" });
  expect((await readPublic(setup)).status).toBe(503);
});

test("updates preserve distinct metadata and audio revisions across sequential updates", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  let base = first.job_id;
  for (const selection of ["metadata", "audio", "both", "metadata"] as const) {
    const next = await setup.request("episode", "first", base, selection);
    const old = setup.content.inspect("daily", "first").base!, body = setup.feed();
    setup.hooks.purge = async () => {
      expect(setup.feed()).toBe(body);
      expect((await readPublic(setup)).status).toBe(200);
      expect((await readPublic(setup, new URL(old.enclosure_url).pathname, { Range: "bytes=0-2" })).status).toBe(206);
      expect(setup.content.inspect("daily", "first").base!.revision_id).toBe(base);
    };
    expect((await setup.run(next)).state).toBe("succeeded");
    expect(setup.content.inspect("daily", "first").base!.enclosure_url).toBe(selection === "metadata" ? old.enclosure_url :
      `${setup.config.public_base_url}/podcasts/daily/episodes/first/${next.job_id}.mp3`);
    base = next.job_id;
  }
});

test("update guards reject changed revisions, lifecycle ABA and malformed evidence", async () => {
  for (const fault of ["revision", "lifecycle", "missing", "guard-revision", "guard-lifecycle", "guard-state"] as const) {
    const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
    const next = await setup.request("episode", "first", first.job_id);
    await setup.queue.enqueue(next); setup.queue.claim();
    expect((await readPublic(setup)).status).toBe(200);
    if (fault === "revision") setup.storage.sql.exec("UPDATE publication_episodes SET revision_id = ?", crypto.randomUUID());
    if (fault === "lifecycle") setup.storage.sql.exec("UPDATE publication_episodes SET lifecycle_version = lifecycle_version + 2");
    if (fault === "missing") setup.storage.sql.exec("DELETE FROM publication_episodes");
    if (fault === "guard-revision") setup.storage.sql.exec("UPDATE publication_jobs SET read_episode_revision_id = 'invalid' WHERE job_id = ?", next.job_id);
    if (fault === "guard-lifecycle") setup.storage.sql.exec("UPDATE publication_jobs SET read_episode_lifecycle_version = -1 WHERE job_id = ?", next.job_id);
    if (fault === "guard-state") {
      expect(() => setup.storage.sql.exec("UPDATE publication_jobs SET read_episode_state = NULL WHERE job_id = ?", next.job_id)).toThrow();
      expect(() => setup.storage.sql.exec("UPDATE publication_jobs SET read_episode_state = NULL, read_episode_revision_id = NULL, read_episode_lifecycle_version = NULL WHERE job_id = ?", next.job_id)).toThrow();
      setup.storage.sql.exec("PRAGMA ignore_check_constraints = ON");
      setup.storage.sql.exec("UPDATE publication_jobs SET read_episode_state = NULL, read_episode_revision_id = NULL, read_episode_lifecycle_version = NULL WHERE job_id = ?", next.job_id);
    }
    expect((await readPublic(setup)).status).toBe(503);
  }
});

test("corrupt old media and interruption before verification cannot authorize blocked update reads", async () => {
  for (const corruptMedia of [false, true]) {
    const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
    const next = await setup.request("episode", "first", first.job_id, "audio");
    if (corruptMedia) {
      setup.storage.sql.exec("UPDATE publication_media SET sha256 = ?", "f".repeat(64));
      expect(await setup.run(next)).toMatchObject({ state: "blocked", reason_code: "validation_unavailable" });
    } else {
      await setup.queue.enqueue(next); setup.queue.claim();
      expect((await setup.runner.alarm()).state).toBe("blocked");
    }
    expect((await readPublic(setup)).status).toBe(503);
  }
});

for (const selection of ["metadata", "cover", "both"] as const) {
for (const phase of ["old-cover", "validation", "metadata", "cover-writing", "cover-stored", "snapshot", "purge"] as const) {
  test(`Show ${selection} update preserves committed Feed, cover and audio during ${phase}`, async () => {
    const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
    const oldFeed = await readPublic(setup), feedEtag = oldFeed.headers.get("ETag")!, body = await oldFeed.text();
    const oldCover = await readPublic(setup, "/podcasts/daily/cover.jpg"), coverEtag = oldCover.headers.get("ETag")!;
    const coverBytes = new Uint8Array(await oldCover.arrayBuffer()), episodes = setup.content.episodes("daily");
    const feedDecision = setup.content.delivery("/podcasts/daily/feed.xml"), coverDecision = setup.content.delivery("/podcasts/daily/cover.jpg");
    if (feedDecision.status !== 200 || coverDecision.status !== 200) throw new Error("Expected committed assets");
    const next = await setup.showUpdate(selection);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const hold = async () => { entered.resolve(); await release.promise; };
    let held = false;
    if (phase === "old-cover") setup.bucketHooks.beforeHead = async (key) => {
      if (!held && key === sqliteCoverSnapshotKey("daily", 1, "jpg")) { held = true; await hold(); }
    };
    if (phase === "validation") setup.bucketHooks.beforeGet = async (key) => { if (key === next.payloads[0].key) await hold(); };
    if (phase === "cover-writing") setup.bucketHooks.beforePut = async (key) => { if (key.includes("/covers/")) await hold(); };
    if (["metadata", "cover-stored", "snapshot"].includes(phase)) setup.bucketHooks.afterPut = async (key) => {
      if (phase === "metadata" ? key === "system/shows/daily/show.toml" : key.includes(phase === "snapshot" ? "/feeds/" : "/covers/")) await hold();
    };
    if (phase === "purge") setup.hooks.purge = hold;
    setup.calls.length = 0;
    const running = setup.run(next);
    try {
      await entered.promise;
      expect(setup.queue.status(next.request_id)?.state).toBe("running");
      expect(await (await readPublic(setup)).text()).toBe(body);
      expect((await readPublic(setup, undefined, { "If-None-Match": feedEtag })).status).toBe(304);
      expect(new Uint8Array(await (await readPublic(setup, "/podcasts/daily/cover.jpg")).arrayBuffer())).toEqual(coverBytes);
      expect((await readPublic(setup, "/podcasts/daily/cover.jpg", { "If-None-Match": coverEtag })).status).toBe(304);
      expect((await readPublic(setup, `/podcasts/daily/episodes/first/${first.job_id}.mp3`)).status).toBe(200);
      expect((await readPublic(setup, "/podcasts/daily/covers/3.jpg")).status).toBe(404);
      expect(setup.content.delivery("/podcasts/daily/cover.jpg")).toEqual(coverDecision);
      expect(setup.content.inspect("daily").show).toMatchObject({ state_version: 1, feed_generation: 2 });
    } finally { release.resolve(); await running; }
    expect(setup.queue.status(next.request_id)?.state).toBe("succeeded");
    expect(setup.content.inspect("daily").show).toMatchObject({ state_version: 2, feed_generation: 3 });
    expect(setup.content.delivery("/podcasts/daily/cover.jpg")).toMatchObject({ cache_props: { coverGeneration: 3, showGeneration: 2 } });
    expect(setup.content.episodes("daily")).toEqual(episodes);
    const currentFeed = await readPublic(setup, undefined, { "If-None-Match": feedEtag });
    expect(currentFeed.status).toBe(selection === "cover" ? 304 : 200);
    const currentCover = await readPublic(setup, "/podcasts/daily/cover.jpg", { "If-None-Match": coverEtag });
    expect(currentCover.status).toBe(selection === "metadata" ? 304 : 200);
    if (currentCover.status === 200) expect(hash(new Uint8Array(await currentCover.arrayBuffer()))).not.toBe(hash(coverBytes));
    for (const [path, props, expected] of [["feed.xml", feedDecision.cache_props, hash(body)], ["cover.jpg", coverDecision.cache_props, hash(coverBytes)]] as const) {
      const late = await serveCachedLifecycleAsset(new Request(`https://cache.invalid/podcasts/daily/${path}`), { CASTLOOP_BUCKET: setup.bucket } as never, props);
      expect(hash(new Uint8Array(await late.arrayBuffer()))).toBe(expected);
    }
    expect(setup.entries.has("public/podcasts/daily/cover.jpg")).toBe(false);
    expect(setup.calls.some((call) => call.method === "PUT" && (call.key.endsWith(".mp3") || call.key.startsWith("public/episodes/")))).toBe(false);
    expect(setup.entries.has(`system/shows/daily/revisions/${next.job_id}.toml`)).toBe(true);
    expect(setup.entries.has(sqliteCoverSnapshotKey("daily", 1, "jpg"))).toBe(true);
    expect(setup.entries.has(sqliteCoverSnapshotKey("daily", 3, "jpg"))).toBe(true);
  });
}
}

for (const phase of ["validation", "metadata", "cover", "snapshot", "purge", "commit"] as const) {
  test(`Show ${phase} failure retains committed content and blocks FIFO without replay after restart`, async () => {
    const setup = await fixture(); await setup.publishShow(); await setup.publishEpisode();
    const next = await setup.showUpdate(), later = await setup.request("episode", "second");
    const body = setup.feed(), oldContent = setup.storage.sql.exec("SELECT * FROM publication_show_content").toArray();
    const cover = new Uint8Array(await (await readPublic(setup, "/podcasts/daily/cover.jpg")).arrayBuffer());
    await setup.queue.enqueue(next); await setup.queue.enqueue(later); setup.clearAlarm();
    if (phase === "validation") setup.bucketHooks.beforeGet = async (key) => { if (key === next.payloads[0].key) throw new Error("Unavailable input"); };
    if (["metadata", "cover", "snapshot"].includes(phase)) setup.bucketHooks.afterPut = async (key) => {
      if (phase === "metadata" ? key.endsWith("/show.toml") : key.includes(phase === "cover" ? "/covers/" : "/feeds/")) throw new Error("Unknown write outcome");
    };
    if (phase === "purge") setup.hooks.purge = async () => { throw new Error("Unknown purge outcome"); };
    if (phase === "commit") { setup.failAlarm(); await expect(setup.runner.alarm()).rejects.toThrow(); }
    else expect((await setup.runner.alarm()).state).toBe("blocked");
    const queue = new SqlitePublicationQueue(setup.storage, setup.runtime), content = new SqlitePublicationContent(setup.storage);
    const restarted = new SqlitePublicationAlarm(queue, createSqlitePublicationExecutor(content, setup.bucket, setup.config, { purge: async () => {} }), () => {});
    expect((await restarted.alarm()).state).toBe("blocked");
    expect(content.delivery("/podcasts/daily/feed.xml").status).toBe(200);
    expect(await (await readPublic(setup)).text()).toBe(body);
    expect(new Uint8Array(await (await readPublic(setup, "/podcasts/daily/cover.jpg")).arrayBuffer())).toEqual(cover);
    expect(setup.storage.sql.exec("SELECT * FROM publication_show_content").toArray()).toEqual(oldContent);
    expect(setup.content.inspect("daily").show).toMatchObject({ state_version: 1, feed_generation: 2 });
    const calls = setup.calls.length; await restarted.alarm(); expect(setup.calls).toHaveLength(calls);
    expect(queue.status(later.request_id)?.state).toBe("queued");
    queue.pause(); expect((await readPublic(setup)).status).toBe(503); expect(() => queue.resume(crypto.randomUUID())).toThrow();
  });
}

test("Show initial publication has no committed guard; a published empty Show can update continuously", async () => {
  const setup = await fixture(), first = await setup.request("show");
  expect((await readPublic(setup)).status).toBe(404);
  await setup.queue.enqueue(first); const claim = setup.queue.claim();
  if (claim.state !== "claimed") throw new Error("Expected claim");
  expect((await readPublic(setup)).status).toBe(503);
  const prepared = await setup.executor.validate(claim.request); await setup.executor.publish(prepared);
  await setup.queue.finish(first.job_id, undefined, () => setup.executor.commit!(prepared));
  setup.hooks.purge = async () => { expect((await readPublic(setup)).status).toBe(200); };
  expect((await setup.run(await setup.showUpdate())).state).toBe("succeeded");
  expect(setup.content.episodes("daily")).toEqual([]);
});

test("Show updates reject stale targets, extension changes and changed frozen inputs before public writes", async () => {
  for (const fault of ["stale", "extension", "frozen"] as const) {
    const setup = await fixture(); await setup.publishShow(); const next = await setup.showUpdate();
    if (fault === "stale") next.expected_show_state_version = 0;
    if (fault === "extension") next.payloads = [await setup.payload(next.job_id, "show_metadata", stringifyToml({ ...show, image_path: "cover.png" })),
      await setup.payload(next.job_id, "cover_png", Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))];
    if (fault === "frozen") await setup.bucket.put(next.payloads[0].key, "changed");
    setup.calls.length = 0;
    expect((await setup.run(next)).state).toBe("failed");
    expect(setup.calls.some((call) => call.method === "PUT")).toBe(false);
    expect((await readPublic(setup)).status).toBe(200);
  }
});

test("unverified or corrupt committed cover cannot grant blocked Show reads and missing cover never falls back", async () => {
  for (const fault of ["missing", "key", "size", "hash", "unavailable", "interrupted"] as const) {
    const setup = await fixture(); await setup.publishShow(); const next = await setup.showUpdate();
    const key = sqliteCoverSnapshotKey("daily", 1, "jpg"), object = setup.entries.get(key)!;
    if (fault === "missing") setup.entries.delete(key);
    if (fault === "key") object.key = "wrong";
    if (fault === "size") object.size++;
    if (fault === "hash") object.checksums.sha256 = new Uint8Array(32).buffer;
    if (fault === "unavailable") setup.bucketHooks.beforeHead = async () => { throw new Error("Unavailable"); };
    if (fault === "interrupted") { await setup.queue.enqueue(next); setup.queue.claim(); expect((await readPublic(setup)).status).toBe(200); }
    expect((await (fault === "interrupted" ? setup.runner.alarm() : setup.run(next))).state).toBe("blocked");
    expect((await readPublic(setup)).status).toBe(503);
    expect(setup.storage.sql.exec("SELECT read_verified FROM publication_jobs WHERE job_id = ?", next.job_id).toArray()).toEqual([{ read_verified: 0 }]);
  }
  const setup = await fixture(); await setup.publishShow(); setup.entries.delete(sqliteCoverSnapshotKey("daily", 1, "jpg"));
  await setup.bucket.put("public/podcasts/daily/cover.jpg", "must not be served");
  const response = await readPublic(setup, "/podcasts/daily/cover.jpg");
  expect(response.status).toBe(503); expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test("Show guards reject malformed target kinds, partial guards and mismatched cover generations", async () => {
  for (const [column, value] of [["read_target_kind", null], ["read_target_kind", "unknown"], ["read_target_kind", "episode"],
    ["read_cover_generation", null], ["read_cover_generation", 999], ["read_episode_id", "first"], ["read_episode_state", "absent"]] as const) {
    const setup = await fixture(); await setup.publishShow(); const next = await setup.showUpdate();
    await setup.queue.enqueue(next); setup.queue.claim();
    if (column !== "read_cover_generation" || value === null) expect(() => setup.storage.sql.exec(`UPDATE publication_jobs SET ${column} = ? WHERE job_id = ?`, value, next.job_id)).toThrow();
    setup.storage.sql.exec("PRAGMA ignore_check_constraints = ON");
    setup.storage.sql.exec(`UPDATE publication_jobs SET ${column} = ? WHERE job_id = ?`, value, next.job_id);
    expect((await readPublic(setup)).status).toBe(503);
  }
});

test("Show restore reuses the committed cover, and subsequent Episode and Show publications keep independent generations", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  expect((await setup.run(await setup.showUpdate())).state).toBe("succeeded");
  const cover = setup.content.delivery("/podcasts/daily/cover.jpg");
  expect(cover).toMatchObject({ cache_props: { coverGeneration: 3 } });
  expect((await setup.run(setup.lifecycle("unpublish"))).state).toBe("succeeded");
  setup.calls.length = 0;
  expect((await setup.run(setup.lifecycle("restore"))).state).toBe("succeeded");
  expect(setup.calls.some((call) => call.method === "PUT" && call.key.includes("/covers/"))).toBe(false);
  expect(setup.calls.some((call) => call.method === "HEAD" && call.key === sqliteCoverSnapshotKey("daily", 3, "jpg"))).toBe(true);
  const next = await setup.request("episode", "first", first.job_id, "metadata");
  next.expected_show_state_version = setup.content.inspect("daily").show!.state_version;
  expect((await setup.run(next)).state).toBe("succeeded");
  expect(setup.content.delivery("/podcasts/daily/cover.jpg")).toMatchObject({ cache_props: { coverGeneration: 3 } });
  expect((await setup.run(await setup.showUpdate("metadata"))).state).toBe("succeeded");
  expect(setup.content.delivery("/podcasts/daily/cover.jpg")).toMatchObject({ cache_props: { coverGeneration: 7 } });
  expect(setup.content.inspect("daily", "first").base).toMatchObject({ guid: "stable-first", enclosure_url: `${setup.config.public_base_url}/podcasts/daily/episodes/first/${first.job_id}.mp3` });
});

test("preexisting cover candidates are never overwritten or adopted", async () => {
  const setup = await fixture(); await setup.publishShow(); const next = await setup.showUpdate();
  const key = sqliteCoverSnapshotKey("daily", 2, "jpg"); await setup.bucket.put(key, "unknown candidate");
  expect((await setup.run(next)).state).toBe("blocked");
  expect(setup.text(key)).toBe("unknown candidate");
  expect((await readPublic(setup)).status).toBe(200);
  expect(setup.content.delivery("/podcasts/daily/cover.jpg")).toMatchObject({ cache_props: { coverGeneration: 1 } });
});

test("cover PUT must confirm the exact immutable key, length and SHA-256 before publication", async () => {
  for (const fault of ["null", "key", "size", "checksum"] as const) {
    const setup = await fixture(); await setup.publishShow(); const next = await setup.showUpdate();
    const executor = createSqlitePublicationExecutor(setup.content, { ...setup.bucket, async put(key, body, options) {
      const result = await setup.bucket.put(key, body, options);
      if (!key.includes("/covers/") || !result) return result;
      expect(options?.onlyIf instanceof Headers && options.onlyIf.get("If-None-Match")).toBe("*");
      expect(options?.sha256).toBe(next.payloads[1].sha256);
      return fault === "null" ? null : { ...result, ...(fault === "key" ? { key: "wrong" } : fault === "size" ? { size: result.size + 1 } : { checksums: {} }) };
    } }, setup.config, { purge: async () => { throw new Error("Must not purge unverified cover"); }, onFailure: () => {} });
    await setup.queue.enqueue(next);
    expect((await new SqlitePublicationAlarm(setup.queue, executor, () => {}).alarm()).state).toBe("blocked");
    expect((await readPublic(setup)).status).toBe(200);
    expect(setup.content.delivery("/podcasts/daily/cover.jpg")).toMatchObject({ cache_props: { coverGeneration: 1 } });
    expect(setup.entries.has(sqliteFeedSnapshotKey("daily", 2))).toBe(false);
  }
});
