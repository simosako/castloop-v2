import { afterEach, expect, test } from "bun:test";
import { directPublicationFixture, directAudio } from "./test-support/direct-publication";
import { SqlitePublicationInputError } from "./sqlite-publication-queue";
import { createSqlitePublicationHttp } from "./sqlite-publication-http";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() { const value = await directPublicationFixture(); cleanups.push(value.close); return value; }

test("publication commits inline metadata and media references without R2 IO or operation/job tables", async () => {
  const f = await fixture();
  f.bucket.head = f.bucket.get = f.bucket.put = async () => { throw new Error("Publication must not read or write R2"); };
  const show = await f.publish(f.show()), episode = await f.publish(f.episode());
  expect(show.result).toBe("changed"); expect(episode.result).toBe("changed");
  expect(f.content.currentEpisodeRevision("daily", "first", f.config.public_base_url)?.revision_id).toBe(episode.revision_id);
  const tables = f.database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  expect(tables).not.toContain("publication_jobs");
  expect(tables.some((name) => name.startsWith("operations") || name.startsWith("operation_"))).toBe(false);
  expect(f.calls).toEqual([]);
  expect(f.content.renderFeed("daily", f.config.public_base_url)?.xml).toContain("saved-first");
});

test("identical requests including stale bases add no history, generations or purges", async () => {
  const f = await fixture(), request = f.show(), first = await f.publish(request);
  const snapshot = f.content.inspect("daily"), purges = f.purges.length;
  expect(await f.publish(request)).toMatchObject({ result: "unchanged", revision_id: first.revision_id });
  expect(f.content.inspect("daily")).toEqual(snapshot); expect(f.purges).toHaveLength(purges);
  const episode = f.episode(), published = await f.publish(episode), count = f.purges.length;
  expect(await f.publish(episode)).toMatchObject({ result: "unchanged", revision_id: published.revision_id });
  expect(f.purges).toHaveLength(count);
  expect(f.content.listEpisodeRevisions("daily", "first", f.config.public_base_url).items).toHaveLength(1);
});

test("metadata-only keeps audio URLs, GUID/date and immutable history", async () => {
  const f = await fixture(); await f.publish(f.show()); await f.publish(f.episode());
  const old = f.content.currentEpisodeRevision("daily", "first", f.config.public_base_url)!;
  const update = f.episode(); update.metadata.title = "Changed";
  await f.publish(update);
  const current = f.content.currentEpisodeRevision("daily", "first", f.config.public_base_url)!;
  expect(current.audio).toEqual(old.audio); expect(current.metadata.guid).toBe(old.metadata.guid);
  expect(current.metadata.published_at).toBe(old.metadata.published_at); expect(current.revision_id).not.toBe(old.revision_id);
  expect(f.content.episodeRevision("daily", "first", old.revision_id, f.config.public_base_url)).toEqual(old);
});

test("audio replacement preserves old audio delivery and resolves both to content-hash keys", async () => {
  const f = await fixture(); await f.publish(f.show()); await f.publish(f.episode());
  const old = f.content.currentEpisodeRevision("daily", "first", f.config.public_base_url)!;
  const update = f.episode(); update.audio = { ...directAudio, sha256: "d".repeat(64) }; await f.publish(update);
  const current = f.content.currentEpisodeRevision("daily", "first", f.config.public_base_url)!;
  expect(current.audio.enclosure_url).not.toBe(old.audio.enclosure_url);
  expect(current.metadata).toEqual(old.metadata);
  expect(f.content.delivery(new URL(old.audio.enclosure_url).pathname)).toMatchObject({ status: 200, key: `public/podcasts/daily/audio/${old.audio.sha256}.mp3` });
  expect(f.content.delivery(new URL(current.audio.enclosure_url).pathname)).toMatchObject({ status: 200, key: `public/podcasts/daily/audio/${current.audio.sha256}.mp3` });
  expect(f.content.delivery("/public/podcasts/daily/audio/" + current.audio.sha256 + ".mp3").status).toBe(404);
});

test("changed content with a stale base conflicts before purge", async () => {
  const f = await fixture(); await f.publish(f.show()); await f.publish(f.episode());
  const stale = f.episode(), next = f.episode(); next.metadata.title = "Next"; await f.publish(next);
  const count = f.purges.length; stale.metadata.title = "Stale";
  await expect(f.publish(stale)).rejects.toThrow("base_conflict"); expect(f.purges).toHaveLength(count);
});

test("GUID, date, duplicate GUID and cover extension changes are rejected", async () => {
  const f = await fixture(); await f.publish(f.show()); await f.publish(f.episode());
  const before = f.content.inspect("daily", "first");
  for (const field of ["guid", "published_at"] as const) {
    const request = f.episode(); request.metadata[field] = field === "guid" ? "changed" : "2026-10-17T00:00:00Z";
    await expect(f.publish(request)).rejects.toThrow("validation_failed");
  }
  const duplicate = f.episode("second"); duplicate.metadata.guid = "saved-first";
  await expect(f.publish(duplicate)).rejects.toThrow("validation_failed");
  const cover = f.show(); cover.metadata.image_path = "cover.png"; cover.cover.extension = "png";
  await expect(f.publish(cover)).rejects.toThrow("validation_failed");
  expect(f.content.inspect("daily", "first")).toEqual(before);
});

test("purge failure leaves committed content unchanged and does not write media", async () => {
  const f = await fixture(); await f.publish(f.show()); await f.publish(f.episode());
  const before = f.content.inspect("daily", "first"), update = f.episode(); update.metadata.title = "New";
  f.hooks.purge = async () => { throw new Error("Purge failure"); };
  await expect(f.publish(update)).rejects.toThrow("cache purge failed");
  expect(f.content.inspect("daily", "first")).toEqual(before); expect(f.calls).toEqual([]);
  f.hooks.purge = undefined; expect((await f.publish(update)).result).toBe("changed");
});

test("SQLite failure rolls back content, history, media, short IDs and Feed generation together", async () => {
  const f = await fixture(); await f.publish(f.show());
  const before = f.content.inspect("daily");
  f.database.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON publication_episode_revisions BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END");
  await expect(f.publish(f.episode())).rejects.toThrow("injected commit failure");
  expect(f.content.inspect("daily")).toEqual(before); expect(f.content.inspect("daily", "first").episode).toBeNull();
  expect(f.database.query("SELECT * FROM publication_media").all()).toEqual([]);
  expect(f.content.siteIds.get("daily", "first")).toBeNull();
});

test("overlapping publication during purge rejects the obsolete rendered Feed", async () => {
  const f = await fixture(); await f.publish(f.show());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let held = false;
  f.hooks.purge = async () => { if (!held) { held = true; entered.resolve(); await release.promise; } };
  const first = f.publish(f.episode("first")); await entered.promise;
  await f.publish(f.episode("second")); release.resolve();
  await expect(first).rejects.toThrow("base_conflict");
  expect(f.content.inspect("daily", "first").episode).toBeNull();
  expect(f.content.inspect("daily", "second").episode?.lifecycle).toBe("published");
});

test("a pending domain change during purge prevents publication commit", async () => {
  const f = await fixture(); await f.publish(f.show());
  f.hooks.purge = async () => {
    f.storage.sql.exec(`INSERT INTO publication_domain_changes (operation_id, request_json, request_sha256, state)
      VALUES ('${crypto.randomUUID()}', '{}', '${"a".repeat(64)}', 'prepared')`);
  };
  await expect(f.publish(f.episode())).rejects.toThrow("target_unavailable");
  expect(f.content.inspect("daily", "first").episode).toBeNull();
});

test("unpublish, restore and revision adoption are idempotent and retain saved audio", async () => {
  const f = await fixture(); await f.publish(f.show()); const original = await f.publish(f.episode());
  const old = f.content.currentEpisodeRevision("daily", "first", f.config.public_base_url)!;
  const update = f.episode(); update.metadata.title = "Next"; await f.publish(update);
  const adopt = f.action("restore_revision", "first", original.revision_id);
  expect((await f.queue.publish(adopt)).result).toBe("changed");
  expect((await f.queue.publish(adopt)).result).toBe("unchanged");
  expect(f.content.currentEpisodeRevision("daily", "first", f.config.public_base_url)?.audio).toEqual(old.audio);
  const hide = f.action("unpublish", "first"); await f.queue.publish(hide);
  expect((await f.queue.publish(hide)).result).toBe("unchanged");
  expect(f.content.delivery(new URL(old.audio.enclosure_url).pathname).status).toBe(404);
  const restore = f.action("restore", "first"); await f.queue.publish(restore);
  expect((await f.queue.publish(restore)).result).toBe("unchanged");
  expect(f.content.delivery(new URL(old.audio.enclosure_url).pathname).status).toBe(200);
});

test("Show restoration preserves individually unpublished Episodes and Show unpublish skips inventory", async () => {
  const f = await fixture(); await f.publish(f.show()); await f.publish(f.episode("first")); await f.publish(f.episode("second"));
  await f.queue.publish(f.action("unpublish", "first"));
  const episodes = f.content.episodes.bind(f.content); f.content.episodes = () => { throw new Error("Unexpected inventory read"); };
  await f.queue.publish(f.action("unpublish")); f.content.episodes = episodes;
  await f.queue.publish(f.action("restore"));
  expect(f.content.episodes("daily").map((episode) => episode.episode_id)).toEqual(["second"]);
});

test("builtin CSS, timezone, short URLs and on-demand pages follow committed Show revisions", async () => {
  const f = await fixture(), show = f.show(); show.metadata.site_css_path = "style.css"; show.metadata.site_css = "body { color: red; }"; show.metadata.site_timezone = "Asia/Tokyo";
  const original = await f.publish(show); await f.publish(f.episode());
  const id = f.content.siteIds.get("daily", "first")!;
  const rendered = f.content.renderSitePage({ kind: "episode", showId: "daily", siteId: id }, f.config.public_base_url)!;
  expect(rendered.css).toBe(show.metadata.site_css); expect(rendered.html).not.toContain("private@example.com");
  const update = { ...f.show(), metadata: { ...show.metadata, site_css: "body { color: blue; }", site_timezone: "UTC" } };
  await f.publish(update);
  expect(f.content.renderSitePage({ kind: "episode", showId: "daily", siteId: id }, f.config.public_base_url)?.css).toBe(update.metadata.site_css);
  await f.queue.publish(f.action("restore_revision", undefined, original.revision_id));
  expect(f.content.siteIds.get("daily", "first")).toBe(id);
  expect(f.content.renderSitePage({ kind: "episode", showId: "daily", siteId: id }, f.config.public_base_url)?.css).toBe(show.metadata.site_css);
});

test("publication HTTP authenticates, validates inline requests and reports synchronous results", async () => {
  const f = await fixture(), handler = createSqlitePublicationHttp(f.queue, "secret", () => true);
  const post = (body: unknown, key = "secret") => handler(new Request("https://example.com/admin/sqlite-publication/publish", {
    method: "POST", headers: { "X-Castloop-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  expect((await post(f.show(), "wrong")).status).toBe(401);
  expect((await post({ ...f.show(), job_id: crypto.randomUUID() })).status).toBe(400);
  const published = await post(f.show()); expect(published.status).toBe(200); expect(await published.json()).toMatchObject({ result: "changed" });
  expect(await (await post({ ...f.show(), expected_show_state_version: 0 })).json()).toMatchObject({ result: "unchanged" });
  const stale = f.show(); stale.expected_show_state_version = 0; stale.metadata.title = "Stale";
  expect((await post(stale)).status).toBe(409);
  expect((await handler(new Request("https://example.com/admin/sqlite-publication/jobs/" + crypto.randomUUID(), { headers: { "X-Castloop-Key": "secret" } }))).status).toBe(404);
});
