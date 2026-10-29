import { afterEach, expect, test } from "bun:test";
import { episodeDraftFromRevision, stringifyToml } from "../packages/shared/src/index";
import { parseSqlitePublicationRequest, sqliteUploadKey } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationRequest, SqliteVerifiedUpload } from "../packages/shared/src/sqlite-publication";
import { sqliteServiceConfigHash } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { purgeSqliteCache } from "./sqlite-cache-purge";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { SqlitePublicationSchedules } from "./sqlite-publication-schedules";
import { createSqlitePublicationExecutor } from "./sqlite-publication-executor";
import { serveSiteGateway } from "./site-gateway";
import { serveCachedSitePage } from "./site-cache";
import type { SitePurgeTarget } from "./site-storage";
import type { SqlitePublicationEffectFailure } from "./sqlite-publication-executor";
import type { SqliteAvailabilityRequest } from "../packages/shared/src/sqlite-availability";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { sqlitePublicationBucket } from "./test-support/sqlite-publication-bucket";
import { sqliteCoverSnapshotKey } from "./sqlite-cover";
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
    (request, props) => serveCachedLifecycleAsset(request, {
      CASTLOOP_BUCKET: setup.bucket as unknown as Pick<R2Bucket, "head" | "get">,
      renderFeed: (showId, cacheProps) => setup.content.renderFeed(showId, setup.config.public_base_url, cacheProps),
    }, props));
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
  const executor = createSqlitePublicationExecutor(content, objects.bucket, config, {
    async purge(target) { purges.push(target); await hooks.purge?.(); },
    async purgeSite(target) { sitePurges.push(target); await hooks.sitePurge?.(); },
    now: () => "2026-10-16T13:00:00Z",
    onFailure: (event) => effectFailures.push(event),
  });
  setup.queue.executor = executor;
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
      expected_show_state_version: kind === "show" ? 0 : content.inspect("daily").show!.state_version || 1,
      ...(kind === "episode" ? { episode_id: episodeId, ...(base ? { base_revision_id: base } : {}) } : {}), payloads });
  }
  const run = (value: SqlitePublicationRequest) => setup.queue.enqueue(value);
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
  const feed = () => content.renderFeed("daily", config.public_base_url)!.xml;
  const control = (action: SqliteAvailabilityRequest["action"]) => setup.queue.applyControl({ ...setup.runtime, action, show_id: "daily",
    operation_id: crypto.randomUUID(), expected_availability_version: setup.queue.snapshot().availability_version,
    ...(action === "resume" ? { admission_window_id: crypto.randomUUID() } : {}) });
  return { ...setup, ...objects, feed, control, bucketHooks: objects.hooks, config, content, reservationId, purges, sitePurges, effectFailures, hooks, executor, payload, request, run, publishShow, publishEpisode, showUpdate, lifecycle };
}

function revisionRequest(setup: Awaited<ReturnType<typeof fixture>>, revisionId: string, episodeId?: string) {
  return parseSqlitePublicationRequest({ ...setup.lifecycle("restore", episodeId), action: "restore_revision", target_revision_id: revisionId });
}

async function readSite(f: Awaited<ReturnType<typeof fixture>>, path = "/podcasts/daily/", headers: HeadersInit = {}) {
  return serveSiteGateway(new Request(`${f.config.public_base_url}${path}`, { headers }), {
    managementOrigin: f.config.workers_dev_base_url, publicOrigin: f.config.public_base_url,
    delivery: async (page) => f.content.siteDelivery(page),
    cachedFetch: (request, props) => serveCachedSitePage(request,
      (page, candidate) => f.content.renderSitePage(page, f.config.public_base_url, candidate), props),
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

test("Show timezone updates render all pages with the new timezone and survive Episode updates, lifecycle and revision adoption", async () => {
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
    const decision = f.content.siteDelivery({ kind: "episode", showId: "daily", siteId });
    expect(decision).toMatchObject({ status: 200, props: { generation: f.content.inspect("daily").show!.feed_generation } });
  }
  await check("2026-10-16 (UTC+09:00)");
  const audio = await f.request("episode", "first", first.job_id, "audio");
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

test("builtin publication atomically exposes on-demand pages, native audio and RSS links without private Show fields or R2 HTML", async () => {
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
  expect([...f.entries.keys()].some((key) => key.includes("/sites/") || key.includes("/feeds/"))).toBe(false);
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
    const cached = await serveCachedSitePage(new Request(`https://cache.invalid${path}`),
      (page, candidate) => f.content.renderSitePage(page, f.config.public_base_url, candidate), props.props);
    expect(cached.headers.get("Cache-Tag")).toContain(`site-episode-daily/${siteId}`);
  };
  await check();
  const update = await f.request("episode", "first", first.job_id, "metadata");
  expect((await f.run(update)).state).toBe("succeeded"); await check();
  await f.run(f.lifecycle("unpublish", "first"));
  expect((await readSite(f, path, { "If-None-Match": "*" })).status).toBe(404);
  expect(f.content.sites.ids.get("daily", "first")).toBe(siteId);
  expect(f.content.siteDelivery({ kind: "episode", showId: "daily", siteId })).toEqual({ status: 404 });
  await f.run(f.lifecycle("restore", "first")); await check();
  expect((await f.run(revisionRequest(f, first.job_id, "first"))).state).toBe("succeeded"); await check();
  expect(f.sitePurges.slice(1).every((target) => target.siteId === siteId)).toBe(true);
});

test("builtin metadata/audio revisions and saved revision adoption preserve page URLs and unaffected Episode snapshots", async () => {
  const f = await fixture(true); await f.publishShow(); const first = await f.publishEpisode(); await f.publishEpisode("second");
  const otherHtml = await (await readSite(f, episodePage("second"))).text();
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
  expect(await (await readSite(f, episodePage("second"))).text()).toBe(otherHtml);
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

test("removing the last second-page Episode removes its listing URL immediately", async () => {
  const f = await fixture(true); await f.publishShow();
  for (let index = 0; index < 21; index++) await f.publishEpisode(`ep-${index}`);
  expect((await readSite(f, "/podcasts/daily/page/2/")).status).toBe(200);
  expect((await f.run(f.lifecycle("unpublish", "ep-20"))).state).toBe("succeeded");
  expect((await readSite(f, "/podcasts/daily/page/2/")).status).toBe(404);
  expect((await readSite(f, "/podcasts/daily/")).status).toBe(200);
});

test("transient media or site purge failure leaves SQLite untouched and succeeds idempotently on retry", async () => {
  const f = await fixture(true); await f.publishShow(); await f.publishEpisode();
  const old = await (await readSite(f)).text(), feed = f.feed(), update = await f.showUpdate();
  f.hooks.sitePurge = async () => { throw new Error("Transient site purge error"); };
  await expect(f.run(update)).rejects.toThrow("SQLite publication effect was not verified");
  expect(f.queue.status(update.request_id)).toBeNull();
  expect(f.feed()).toBe(feed);
  expect(await (await readSite(f)).text()).toBe(old);
  f.hooks.sitePurge = undefined;
  const coverPutsBefore = f.calls.filter((call) => call.method === "PUT" && call.key.includes("/covers/")).length;
  expect((await f.run(update)).state).toBe("succeeded");
  expect(f.calls.filter((call) => call.method === "PUT" && call.key.includes("/covers/")).length).toBe(coverPutsBefore);
  expect(await (await readSite(f)).text()).toContain("Updated Show");
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
    expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
    const history = kind === "show" ? f.content.listShowRevisions("daily", f.config.public_base_url).items :
      f.content.listEpisodeRevisions("daily", "first", f.config.public_base_url).items;
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ revision_id: request.job_id, restored_from_revision_id: id, is_current: true });
    expect(history[2]).toMatchObject({ revision_id: id, is_current: false });
  });

  test(`${kind} revision preview base is invalidated by lifecycle ABA before output writes`, async () => {
    const f = await fixture(), show = await f.publishShow(), episode = await f.publishEpisode();
    const request = revisionRequest(f, kind === "show" ? show.job_id : episode.job_id, kind === "episode" ? "first" : undefined);
    await f.run(f.lifecycle("unpublish", kind === "episode" ? "first" : undefined));
    await f.run(f.lifecycle("restore", kind === "episode" ? "first" : undefined));
    f.calls.length = 0;
    expect(await f.run(request)).toMatchObject({ state: "failed", reason_code: "base_conflict" });
    expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
  });
}

for (const fault of ["media", "unknown-revision"] as const) {
  test(`revision ${fault} validation cannot publish or append history`, async () => {
    const f = await fixture(); await f.publishShow(); const original = await f.publishEpisode();
    const request = revisionRequest(f, fault === "unknown-revision" ? crypto.randomUUID() : original.job_id, "first");
    if (fault === "media") f.entries.delete(`public/podcasts/daily/episodes/first/${original.job_id}.mp3`);
    f.calls.length = 0;
    expect((await f.run(request)).state).toBe("failed");
    expect(f.content.listEpisodeRevisions("daily", "first", f.config.public_base_url).items).toHaveLength(1);
    expect(f.calls.some((call) => call.method === "PUT")).toBe(false);
  });
}

test("Episode lifecycle removes all revision delivery and restores the same snapshot without audio or metadata writes", async () => {
  const value = await fixture(); await value.publishShow(); const first = await value.publishEpisode(); await value.publishEpisode("second");
  const update = await value.request("episode", "first", first.job_id);
  expect((await value.run(update)).state).toBe("succeeded");
  const base = value.content.inspect("daily", "first").base!, paths = [first.job_id, update.job_id].map((id) => `/podcasts/daily/episodes/first/${id}.mp3`);
  const previous = value.content.delivery(paths[0]);
  const preserved = new Map([...value.entries].filter(([key]) => key.endsWith(".mp3")).map(([key, object]) => [key, object.etag]));
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
  expect(value.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  expect((await value.queue.enqueue(stop)).state).toBe("succeeded");
  expect(value.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
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

test("real executor publishes a registered Show and Episode using only media R2 objects and SQLite metadata", async () => {
  const setup = await fixture();
  expect(setup.content.delivery("/podcasts/daily/feed.xml")).toEqual({ status: 404 });
  await setup.publishShow();
  const episode = await setup.publishEpisode();
  const current = setup.content.episodes("daily")[0]!;
  expect(current.revision_id).toBe(episode.job_id);
  expect(current.enclosure_url).toBe(`${setup.config.public_base_url}/podcasts/daily/episodes/first/${episode.job_id}.mp3`);
  expect(setup.feed()).toContain('<guid isPermaLink="false">stable-first</guid>');
  expect(setup.feed()).toContain("Fri, 16 Oct 2026 03:00:00 GMT");
  expect(setup.purges).toEqual([{ showId: "daily", cover: true }, { showId: "daily", cover: false, episodeId: "first" }]);
  expect(setup.calls.some((call) => /^system\/|^public\/episodes\/|\/feeds\//.test(call.key))).toBe(false);
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
  expect(setup.calls.filter((call) => call.method === "PUT")).toEqual([]);
  expect(setup.content.listEpisodeRevisions("daily", "first", setup.config.public_base_url).items).toHaveLength(2);
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

test("multiple different Episodes run sequentially without invalidating the shared Show state version", async () => {
  const setup = await fixture(); await setup.publishShow();
  const requests = await Promise.all(["first", "second", "third"].map((id) => setup.request("episode", id)));
  for (const value of requests) {
    expect((await setup.queue.enqueue(value)).state).toBe("succeeded");
    expect(setup.queue.status(value.request_id)?.state).toBe("succeeded");
  }
  expect(setup.content.episodes("daily").map((revision) => revision.episode_id)).toEqual(["first", "second", "third"]);
});

test("the second update from the same Episode base fails before writes and the next target can run", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  const [u1, u2, u3] = await Promise.all([setup.request("episode", "first", first.job_id, "metadata"),
    setup.request("episode", "first", first.job_id, "metadata"), setup.request("episode", "second")]);
  expect((await setup.queue.enqueue(u1)).state).toBe("succeeded");
  setup.calls.length = 0;
  expect(await setup.queue.enqueue(u2)).toMatchObject({ state: "failed", reason_code: "base_conflict" });
  expect(setup.calls.filter((call) => call.method === "PUT")).toEqual([]);
  expect((await setup.queue.enqueue(u3)).state).toBe("succeeded");
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

test("duplicate GUID and replaced staging objects are rejected before public writes", async () => {
  const setup = await fixture(); await setup.publishShow(); await setup.publishEpisode();
  const duplicate = await setup.request("episode", "second");
  duplicate.payloads[0] = await setup.payload(duplicate.job_id, "episode_metadata", stringifyToml({ ...metadata("second"), guid: "stable-first" }));
  expect(await setup.run(duplicate)).toMatchObject({ state: "failed", reason_code: "validation_failed" });
  const replacement = await setup.request("episode", "fourth");
  await setup.bucket.put(replacement.payloads[0].key, "replacement");
  expect(await setup.run(replacement)).toMatchObject({ state: "failed", reason_code: "validation_failed" });
});

test("purge failure leaves SQLite untouched, preserves committed delivery, and allows retry without re-uploading media", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  const next = await setup.request("episode", "second");
  setup.hooks.purge = async () => { throw new Error("Private title private@example.com secret"); };
  await expect(setup.run(next)).rejects.toThrow("SQLite publication effect was not verified");
  expect(setup.queue.status(next.request_id)).toBeNull();
  expect(setup.content.episodes("daily").map((ep) => ep.episode_id)).toEqual(["first"]);
  expect((await readPublic(setup)).status).toBe(200);
  expect((await readPublic(setup, `/podcasts/daily/episodes/first/${first.job_id}.mp3`)).status).toBe(200);
  expect(setup.effectFailures).toEqual([{ event: "sqlite_publication_effect_failed", job_id: next.job_id,
    request_id: next.request_id, phase: "cache_purge", reason_code: "publication_effect_unverified" }]);
  expect(JSON.stringify(setup.effectFailures)).not.toMatch(/Private title|private@example|secret/);
  setup.hooks.purge = undefined;
  setup.calls.length = 0;
  expect((await setup.run(next)).state).toBe("succeeded");
  expect(setup.calls.filter((call) => call.method === "PUT")).toEqual([]);
  expect(setup.content.episodes("daily").map((ep) => ep.episode_id)).toEqual(["first", "second"]);
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

test("Show updates advance only the Show state, update on-demand Feed, and preserve the cover extension", async () => {
  const setup = await fixture(); await setup.publishShow(); await setup.publishEpisode();
  const update = await setup.showUpdate();
  setup.calls.length = 0;
  expect((await setup.run(update)).state).toBe("succeeded");
  expect(setup.content.currentShowRevision("daily", setup.config.public_base_url)!.metadata.title).toBe("Updated Show");
  expect(setup.feed()).toContain("Updated Show");
  expect(setup.feed()).toContain("stable-first");
  expect(setup.content.delivery("/podcasts/daily/cover.jpg").status).toBe(200);
  expect(setup.content.delivery("/podcasts/daily/cover.png").status).toBe(404);
  expect(setup.calls.some((call) => call.key.endsWith(".mp3"))).toBe(false);
  expect(setup.entries.has(sqliteCoverSnapshotKey("daily", 2, "jpg"))).toBe(true);
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

test("during media placement and cache purge, public delivery serves the committed Feed and switches atomically on commit", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  const old = await readPublic(setup), etag = old.headers.get("ETag")!, body = await old.text();
  const next = await setup.request("episode", "second");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  setup.hooks.purge = async () => { entered.resolve(); await release.promise; };
  const running = setup.run(next);
  try {
    await entered.promise;
    expect(await (await readPublic(setup)).text()).toBe(body);
    expect((await readPublic(setup, undefined, { "If-None-Match": etag })).status).toBe(304);
    expect((await readPublic(setup, `/podcasts/daily/episodes/first/${first.job_id}.mp3`)).status).toBe(200);
    expect((await readPublic(setup, `/podcasts/daily/episodes/second/${next.job_id}.mp3`)).status).toBe(404);
  } finally { release.resolve(); await running; }
  const current = await readPublic(setup, undefined, { "If-None-Match": etag });
  expect(current.status).toBe(200);
  expect(await current.text()).toContain("Private second");
  expect((await readPublic(setup, `/podcasts/daily/episodes/second/${next.job_id}.mp3`)).status).toBe(200);
});
