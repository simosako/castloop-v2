import { afterEach, expect, test } from "bun:test";
import { episodeDraftFromRevision, parseEpisodeRevision, parseShowMetadata, stringifyToml } from "../packages/shared/src/index";
import { parseSqlitePublicationRequest, sqliteUploadKey } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationRequest, SqliteVerifiedUpload } from "../packages/shared/src/sqlite-publication";
import { sqliteServiceConfigHash } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SqlitePublicationAlarm } from "./sqlite-publication-alarm";
import { purgeSqliteCache } from "./sqlite-cache-purge";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { createSqlitePublicationExecutor } from "./sqlite-publication-executor";
import type { SqlitePublicationEffectFailure } from "./sqlite-publication-executor";
import { sqlitePublicationFixture } from "./test-support/sqlite-publication";
import { sqlitePublicationBucket } from "./test-support/sqlite-publication-bucket";
import { createHash } from "node:crypto";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const show = { schema_version: 1 as const, show_id: "daily", title: "Private Show", description: "Private description", language: "ja",
  author: "Author", owner_name: "Owner", owner_email: "private@example.com", categories: ["Technology"], explicit: false,
  site_url: "https://example.com/podcast", image_path: "cover.jpg" };
const metadata = (episodeId: string) => ({ schema_version: 1 as const, episode_id: episodeId, guid: `stable-${episodeId}`,
  title: `Private ${episodeId}`, description: "Private description", published_at: "2026-10-16T12:00:00+09:00" });
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const config: SqliteServiceConfig = { schema_version: 2, publication_protocol: "sqlite-sequential-v1", service_id: "service",
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
  const hooks: { purge?: () => Promise<void> } = {};
  const executor = createSqlitePublicationExecutor(content, objects.bucket, config, { async purge(target) {
    purges.push(target); await hooks.purge?.();
  }, now: () => "2026-10-16T13:00:00Z", onFailure: (event) => effectFailures.push(event) });
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
      payloads.push(await payload(jobId, "show_metadata", stringifyToml(show)), await payload(jobId, "cover_jpg", Uint8Array.from([255, 216, 255, 2])));
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
    await setup.queue.enqueue(value); setup.clearAlarm(); return runner.alarm();
  };
  const publishShow = async () => { const value = await request("show"); expect((await run(value)).state).toBe("succeeded"); return value; };
  const publishEpisode = async (episodeId = "first") => { const value = await request("episode", episodeId); expect((await run(value)).state).toBe("succeeded"); return value; };
  const lifecycle = (action: "unpublish" | "restore", episodeId?: string) => {
    const target = content.inspect("daily", episodeId);
    return parseSqlitePublicationRequest({ schema_version: 1, protocol: "sqlite-sequential-v1", ...setup.runtime,
      admission_window_id: setup.windowId, request_id: crypto.randomUUID(), job_id: crypto.randomUUID(), action,
      kind: episodeId === undefined ? "show" : "episode", show_id: "daily", expected_show_state_version: target.show!.state_version,
      ...(episodeId === undefined ? {} : { episode_id: episodeId, base_revision_id: target.base!.revision_id, expected_episode_lifecycle_version: target.episode!.lifecycle_version }), payloads: [] });
  };
  return { ...setup, ...objects, bucketHooks: objects.hooks, config, content, reservationId, purges, effectFailures, hooks, executor, events, runner, payload, request, run, publishShow, publishEpisode, lifecycle };
}

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
  expect(value.text("public/podcasts/daily/feed.xml")).not.toContain("Private first");
  expect(value.text("public/podcasts/daily/feed.xml")).toContain("Private second");
  expect(value.purges.at(-1)).toEqual({ showId: "daily", cover: false, episodeId: "first" });
  expect((await value.run(value.lifecycle("restore", "first"))).state).toBe("succeeded");
  expect(value.content.inspect("daily", "first").base).toEqual(base);
  expect(value.text("public/podcasts/daily/feed.xml")).toContain("Private first");
  for (const path of paths) expect(value.content.delivery(path).status).toBe(200);
  expect(value.content.delivery(paths[0])).not.toEqual(previous);
  for (const [key, etag] of preserved) expect(value.entries.get(key)!.etag).toBe(etag);
  expect(value.calls.filter((call) => call.method === "PUT").every((call) => call.key.endsWith("feed.xml"))).toBe(true);
  const puts = value.calls.filter((call) => call.method === "PUT").length;
  expect((await value.queue.enqueue(stop)).state).toBe("succeeded"); value.clearAlarm(); await value.runner.alarm();
  expect(value.calls.filter((call) => call.method === "PUT")).toHaveLength(puts);
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
  const feed = value.text("public/podcasts/daily/feed.xml");
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
  expect(setup.text("public/podcasts/daily/feed.xml")).toContain('<guid isPermaLink="false">stable-first</guid>');
  expect(setup.text("public/podcasts/daily/feed.xml")).toContain("Fri, 16 Oct 2026 03:00:00 GMT");
  expect(setup.purges).toEqual([{ showId: "daily", cover: true }, { showId: "daily", cover: false, episodeId: "first" }]);
  expect(setup.calls.some((call) => /^system\/(?:jobs|show-publications|lifecycle-service|episode-lifecycle|management-requests)/.test(call.key))).toBe(false);
  expect([...setup.entries.keys()].some((key) => key.endsWith("commit.json"))).toBe(false);
  expect(setup.content.delivery(`/podcasts/daily/episodes/first/${episode.job_id}.mp3`).status).toBe(200);
  expect(setup.content.delivery(`/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`).status).toBe(404);
  expect(setup.content.delivery("/system/shows/daily/show.toml").status).toBe(404);
  expect(setup.content.delivery("/staging/uploads/daily/audio.mp3").status).toBe(404);
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

test("purge failure blocks later jobs and closes delivery even after the fixed feed was written", async () => {
  const setup = await fixture(); await setup.publishShow(); const first = await setup.publishEpisode();
  const update = await setup.request("episode", "first", first.job_id, "metadata"), next = await setup.request("episode", "second");
  await setup.queue.enqueue(update); await setup.queue.enqueue(next);
  setup.hooks.purge = async () => { throw new Error("Private title private@example.com secret"); };
  setup.clearAlarm(); expect(await setup.runner.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_failed" });
  expect(setup.content.episodes("daily")[0].revision_id).toBe(first.job_id);
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
  expect(setup.content.delivery(`/podcasts/daily/episodes/first/${first.job_id}.mp3`).status).toBe(503);
  setup.calls.length = 0;
  expect((await setup.runner.alarm()).state).toBe("blocked");
  expect(setup.calls).toEqual([]);
  expect(setup.queue.status(next.request_id)?.state).toBe("queued");
  expect(JSON.stringify(setup.events)).not.toMatch(/Private title|private@example|secret/);
  expect(setup.effectFailures).toEqual([{ event: "sqlite_publication_effect_failed", job_id: update.job_id,
    request_id: update.request_id, phase: "cache_purge", reason_code: "publication_effect_unverified" }]);
  expect(JSON.stringify(setup.effectFailures)).not.toMatch(/Private title|private@example|secret/);
});

test("purge rejection waiting retains the running job and closed delivery without replaying R2 output", async () => {
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
    expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
    expect(setup.content.episodes("daily")).toEqual([]);
    expect(await setup.runner.alarm()).toEqual({ state: "busy" });
  } finally { release(); }
  expect((await running).state).toBe("succeeded");
  expect(setup.calls.filter((call) => call.method === "PUT").map((call) => call.key)).toEqual([
    `public/podcasts/daily/episodes/first/${episode.job_id}.mp3`,
    `public/episodes/daily/first/revisions/${episode.job_id}.toml`, "public/episodes/daily/first/metadata.toml", "public/podcasts/daily/feed.xml",
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
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
  expect(await setup.runner.alarm()).toMatchObject({ state: "blocked", reason_code: "execution_interrupted" });
  expect(setup.queue.status(next.request_id)?.state).toBe("queued");
});

test("running media IO and purge keep delivery closed and completion pending while accepted jobs can drain paused", async () => {
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
    expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
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
  expect(setup.content.delivery("/podcasts/daily/feed.xml").status).toBe(503);
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
});

test("Show updates advance only the Show state, regenerate its feed, and deny the old cover extension", async () => {
  const setup = await fixture(); await setup.publishShow(); await setup.publishEpisode();
  const update = await setup.request("show");
  update.expected_show_state_version = 1;
  update.payloads = [await setup.payload(update.job_id, "show_metadata", stringifyToml({ ...show, title: "Updated Show", image_path: "cover.png" })),
    await setup.payload(update.job_id, "cover_png", Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]))];
  setup.calls.length = 0;
  expect((await setup.run(update)).state).toBe("succeeded");
  expect(parseShowMetadata(setup.text("system/shows/daily/show.toml")).title).toBe("Updated Show");
  expect(setup.text("public/podcasts/daily/feed.xml")).toContain("Updated Show");
  expect(setup.text("public/podcasts/daily/feed.xml")).toContain("stable-first");
  expect(setup.content.delivery("/podcasts/daily/cover.jpg").status).toBe(404);
  expect(setup.content.delivery("/podcasts/daily/cover.png").status).toBe(200);
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
