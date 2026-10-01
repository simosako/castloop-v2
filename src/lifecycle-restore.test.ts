import { describe, expect, test } from "bun:test";
import { episodeLifecycleSchema, episodeRevisionSchema, parseJobStatus, parseLifecycleProgress, parseShowMetadata,
  stringifyLifecycleToml, stringifyToml } from "../packages/shared/src/index";
import type { LifecycleState } from "../packages/shared/src/index";
import { acquireShowExecution, claimShowOperation, readEpisodeLifecycle, readPublicVisibility, readShowControl,
  releaseShowExecution } from "./lifecycle-control";
import { renderFeed } from "./feed";
import { runLifecycleRestore } from "./lifecycle-restore";
import type { RestoreEffects } from "./lifecycle-restore";

async function fixture(kind: "show" | "episode" = "episode", empty = false) {
  const entries = new Map<string, { data: string; size: number; etag: string }>();
  const reads: string[] = [];
  let version = 0;
  const bucket = {
    async get(key: string) {
      reads.push(key);
      if (key.endsWith(".mp3") || key.endsWith(".jpg")) throw new Error("Restore must not read media bodies");
      const value = entries.get(key);
      return value ? { key, ...value, text: async () => value.data, json: async () => JSON.parse(value.data) } : null;
    },
    async head(key: string) { const value = entries.get(key); return value ? { key, ...value } : null; },
    async list(options: { prefix: string; cursor?: string; limit: number }) {
      const matching = [...entries].filter(([key]) => key.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, size: value.size, etag: value.etag }));
      const offset = Number(options.cursor ?? 0);
      return { objects: matching.slice(offset, offset + options.limit), truncated: offset + options.limit < matching.length,
        cursor: String(offset + options.limit) };
    },
    async put(key: string, data: string, options?: { onlyIf?: Headers | { etagMatches: string } }) {
      const previous = entries.get(key);
      if (options?.onlyIf instanceof Headers && previous) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches !== previous?.etag) return null;
      const etag = String(++version);
      entries.set(key, { data, size: new TextEncoder().encode(data).length, etag });
      return { key, etag };
    },
  };
  const env = { CASTLOOP_BUCKET: bucket } as never;
  await bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
    lifecycle: kind === "show" ? "unpublished" : "active", generation: 0, feed_generation: 0 }));
  const show = parseShowMetadata("schema_version = 1\nshow_id = 'daily'\ntitle = 'Saved title'\ndescription = 'Saved description'\nlanguage = 'en'\nauthor = 'Author'\nowner_name = 'Owner'\nowner_email = 'owner@example.com'\ncategories = ['Arts']\nexplicit = false\nsite_url = 'https://example.com'\nimage_path = 'cover.jpg'\n");
  await bucket.put("system/shows/daily/show.toml", stringifyToml(show));
  await bucket.put("system/service.toml", "schema_version = 1\nservice_id = 'service'\naccount_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\nbucket_name = 'test-bucket'\nworker_name = 'test-worker'\nqueue_name = 'test-queue'\ndlq_name = 'test-dlq'\npublic_base_url = 'https://current.example'\n");
  await bucket.put("public/podcasts/daily/cover.jpg", "cover");
  await bucket.put("public/podcasts/daily/feed.xml", "old feed");
  const states: Record<string, LifecycleState> = empty ? {} : { first: kind === "episode" ? "unpublished" : "active",
    second: "active", stopped: "unpublished", draft: "draft", deleted: "deleted" };
  const revisions = new Map<string, ReturnType<typeof episodeRevisionSchema.parse>>();
  for (const [episodeId, lifecycle] of Object.entries(states)) {
    await bucket.put(`system/episode-lifecycle/daily/${episodeId}.toml`, stringifyLifecycleToml(episodeLifecycleSchema.parse({
      schema_version: 1, show_id: "daily", episode_id: episodeId, lifecycle, generation: 0,
    })));
    if (lifecycle === "deleted" || lifecycle === "draft") continue;
    const audioRevision = crypto.randomUUID();
    const revision = episodeRevisionSchema.parse({ schema_version: 1, episode_id: episodeId, guid: crypto.randomUUID(),
      title: `Saved ${episodeId} title`, description: "Saved description", published_at: "2026-09-01T12:34:56+09:00",
      revision_id: crypto.randomUUID(), enclosure_url: `https://old.example/podcasts/daily/episodes/${episodeId}/${audioRevision}.mp3`,
      content_type: "audio/mpeg", length_bytes: 1, duration_seconds: 1, sha256: "a".repeat(64), updated_at: "2026-09-02T00:00:00Z" });
    revisions.set(episodeId, revision);
    await bucket.put(`public/episodes/daily/${episodeId}/metadata.toml`, stringifyToml(revision));
    await bucket.put(`public/episodes/daily/${episodeId}/revisions/${revision.revision_id}.toml`, stringifyToml(revision));
    await bucket.put(new URL(revision.enclosure_url).pathname.replace(/^\//, "public/"), "x");
  }
  await bucket.put(`staging/shows/daily/${crypto.randomUUID()}/show.toml`, "Private unpublished edit");
  await bucket.put(`staging/episodes/daily/first/${crypto.randomUUID()}/episode.toml`, "Private unpublished edit");
  const jobId = crypto.randomUUID();
  await claimShowOperation(env, { schema_version: 1, job_id: jobId, show_id: "daily", kind, action: "restore",
    expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z",
    ...(kind === "episode" ? { episode_id: "first", expected_episode_generation: 0 } : {}) });
  const execution = await acquireShowExecution(env, "daily", jobId, 1);
  const events: string[] = [];
  const target = { showId: "daily", ...(kind === "episode" ? { episodeId: "first" } : {}) };
  const effects: RestoreEffects = {
    async checkDeliveryGate(received) { expect(received).toEqual(target); },
    async writeFeed(snapshot) {
      events.push("feed");
      expect(snapshot.show).toEqual(show);
      expect(snapshot.service.public_base_url).toBe("https://current.example");
      expect(snapshot.episodes.map((episode) => episode.episode_id).sort()).toEqual(empty ? [] : ["first", "second"]);
      expect(await readPublicVisibility(env, "daily", kind === "episode" ? "first" : undefined)).toBe("not_found");
      await bucket.put("public/podcasts/daily/feed.xml",
        renderFeed(snapshot.show, snapshot.episodes, snapshot.service.public_base_url, snapshot.coverExtension));
    },
    async purge(received) {
      events.push("purge");
      expect(received).toEqual(target);
      expect(await readPublicVisibility(env, "daily", kind === "episode" ? "first" : undefined)).toBe("not_found");
      expect((await readShowControl(env, "daily"))?.value.last_feed_job_id).toBe(jobId);
    },
  };
  return { env, bucket, entries, reads, execution, jobId, effects, events, revisions, kind, target,
    progressKey: `system/jobs/${jobId}/progress.toml`, statusKey: `system/jobs/${jobId}/status.toml` };
}

describe("M6 saved-snapshot restoration", () => {
  test("Episode restores unchanged GUID/date/revision/audio and rebuilds the feed at the current URL", async () => {
    const setup = await fixture();
    const retained = new Map([...setup.entries].filter(([key]) => key !== "system/show-publications/daily.json" &&
      key !== "system/episode-lifecycle/daily/first.toml" && key !== "public/podcasts/daily/feed.xml"));
    await runLifecycleRestore(setup.env, setup.execution, setup.effects);
    expect(setup.events).toEqual(["feed", "purge"]);
    for (const [key, value] of retained) expect(setup.entries.get(key)).toEqual(value);
    expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.lifecycle).toBe("active");
    expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.generation).toBe(1);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
    expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(1);
    const feed = setup.entries.get("public/podcasts/daily/feed.xml")!.data;
    const revision = setup.revisions.get("first")!;
    expect(feed).toContain(revision.guid);
    expect(feed).toContain(new URL(revision.enclosure_url).pathname);
    expect(feed).toContain("https://current.example/podcasts/daily/");
    expect(feed).toContain("Tue, 01 Sep 2026 03:34:56 GMT");
    expect(feed).not.toContain("https://old.example");
    expect(feed).not.toContain("Private unpublished edit");
    expect(setup.reads.some((key) => key.startsWith("staging/") || key.endsWith(".mp3"))).toBe(false);
    expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("public");
    expect(parseJobStatus(setup.entries.get(setup.statusKey)!.data).state).toBe("completed");
  });

  test("Show restores only active children and preserves individual stops/deletions/drafts", async () => {
    const setup = await fixture("show");
    const controls = new Map([...setup.entries].filter(([key]) => key.startsWith("system/episode-lifecycle/")));
    await runLifecycleRestore(setup.env, setup.execution, setup.effects);
    expect((await readShowControl(setup.env, "daily"))?.value.lifecycle).toBe("active");
    for (const [key, value] of controls) expect(setup.entries.get(key)).toEqual(value);
    expect(await readPublicVisibility(setup.env, "daily", "stopped")).toBe("not_found");
    expect(await readPublicVisibility(setup.env, "daily", "deleted")).toBe("gone");
    expect(await readPublicVisibility(setup.env, "daily", "draft")).toBe("not_found");
    expect(await readPublicVisibility(setup.env, "daily", "second")).toBe("public");
  });

  test("an empty stopped Show restores a valid empty feed", async () => {
    const setup = await fixture("show", true);
    await runLifecycleRestore(setup.env, setup.execution, setup.effects);
    expect(setup.entries.get("public/podcasts/daily/feed.xml")!.data).toContain("<channel>");
    expect(setup.entries.get("public/podcasts/daily/feed.xml")!.data).not.toContain("<item>");
  });

  test("purge failure never opens delivery and a settled invocation can hand off for retry", async () => {
    for (const kind of ["episode", "show"] as const) {
      const setup = await fixture(kind);
      const secret = "Private title owner@example.com Bearer secret";
      await expect(runLifecycleRestore(setup.env, setup.execution, { ...setup.effects, async purge() { throw new Error(secret); } }))
        .rejects.toThrow(secret);
      expect(await readPublicVisibility(setup.env, "daily", setup.target.episodeId)).toBe("not_found");
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBe(setup.execution.executionId);
      expect(setup.entries.get(setup.statusKey)!.data).not.toContain(secret);
      const status = parseJobStatus(setup.entries.get(setup.statusKey)!.data);
      if (status.schema_version === 2) expect(status.reason_code).toBe("cache_purge_failed");
      await releaseShowExecution(setup.env, setup.execution);
      const next = await acquireShowExecution(setup.env, "daily", setup.jobId, 1);
      await runLifecycleRestore(setup.env, next, setup.effects);
      expect(setup.events).toEqual(["feed", "purge"]);
      expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(1);
    }
  });

  test("missing, oversized or mismatched saved snapshots block restoration before feed/purge", async () => {
    for (const fault of ["show", "service", "cover", "audio", "metadata", "show-id", "oversized"] as const) {
      const setup = await fixture();
      if (fault === "show") setup.entries.delete("system/shows/daily/show.toml");
      if (fault === "service") setup.entries.delete("system/service.toml");
      if (fault === "cover") setup.entries.delete("public/podcasts/daily/cover.jpg");
      if (fault === "audio") setup.entries.delete(new URL(setup.revisions.get("first")!.enclosure_url).pathname.replace(/^\//, "public/"));
      if (fault === "metadata") setup.entries.delete("public/episodes/daily/first/metadata.toml");
      if (fault === "show-id") await setup.bucket.put("system/shows/daily/show.toml",
        setup.entries.get("system/shows/daily/show.toml")!.data.replace('show_id = "daily"', 'show_id = "other"'));
      if (fault === "oversized") await setup.bucket.put("system/shows/daily/show.toml", "x".repeat(1_000_001));
      await expect(runLifecycleRestore(setup.env, setup.execution, setup.effects)).rejects.toThrow();
      expect(setup.events).toEqual([]);
      expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.lifecycle).toBe("unpublished");
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.jobId);
      expect(parseJobStatus(setup.entries.get(setup.statusKey)!.data).state).toBe("retrying");
    }
  });

  test("feed and delivery-gate failures keep restoration closed and recover without generation duplication", async () => {
    for (const fault of ["feed", "gate"] as const) {
      const setup = await fixture();
      const effects = { ...setup.effects, ...(fault === "feed" ? { async writeFeed() { throw new Error("Feed failed"); } } :
        { async checkDeliveryGate() { throw new Error("Gateway not ready"); } }) };
      await expect(runLifecycleRestore(setup.env, setup.execution, effects)).rejects.toThrow();
      expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("not_found");
      await runLifecycleRestore(setup.env, setup.execution, setup.effects);
      expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.generation).toBe(1);
      expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(1);
    }
  });

  test("response loss at feed generation, purge proof, restored state, completion and release recovers", async () => {
    for (const kind of ["episode", "show"] as const) {
      for (const fault of ["feed-generation", "purge-proof", "state", "finished", "status", "release"] as const) {
        const setup = await fixture(kind);
        let lose = true;
        const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
          const written = await setup.bucket.put(...args);
          const [key, text] = args;
          const match = fault === "feed-generation" ? key === "system/show-publications/daily.json" && text.includes('"last_feed_job_id"') :
            fault === "purge-proof" ? key === setup.progressKey && text.includes('phase = "visibility"') :
            fault === "state" ? (kind === "episode" ? key === "system/episode-lifecycle/daily/first.toml" && text.includes('lifecycle = "active"') :
              key === "system/show-publications/daily.json" && text.includes('"lifecycle":"active"')) :
            fault === "finished" ? key === setup.progressKey && text.includes('phase = "finished"') :
            fault === "status" ? key === setup.statusKey && text.includes('state = "completed"') :
            key === "system/show-publications/daily.json" && text.includes('"last_finished_operation"');
          if (lose && written && match) { lose = false; throw new Error("Injected response loss"); }
          return written;
        } } } as never;
        await expect(runLifecycleRestore(env, setup.execution, setup.effects)).rejects.toThrow("Injected response loss");
        await runLifecycleRestore(env, setup.execution, setup.effects);
        expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
        expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(1);
        if (kind === "episode") expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.generation).toBe(1);
        expect(setup.events.filter((event) => event === "purge")).toHaveLength(1);
        expect(parseLifecycleProgress(setup.entries.get(setup.progressKey)!.data).phase).toBe("finished");
      }
    }
  });

  test("completed restore replay preserves a newer owner and rejects stale invocation tokens", async () => {
    const setup = await fixture();
    await expect(runLifecycleRestore(setup.env, { ...setup.execution, executionId: crypto.randomUUID() }, setup.effects))
      .rejects.toThrow("execution token");
    await runLifecycleRestore(setup.env, setup.execution, setup.effects);
    const nextJob = crypto.randomUUID();
    await claimShowOperation(setup.env, { schema_version: 1, job_id: nextJob, show_id: "daily", kind: "show", action: "unpublish",
      expected_show_generation: 1, created_at: "2026-10-01T12:00:00Z" });
    await runLifecycleRestore(setup.env, setup.execution, setup.effects);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(nextJob);
    expect(setup.events).toEqual(["feed", "purge"]);
  });

  test("a failed gate after purge leaves durable preparation reusable but delivery still closed", async () => {
    const setup = await fixture();
    let calls = 0;
    await expect(runLifecycleRestore(setup.env, setup.execution, { ...setup.effects, async checkDeliveryGate() {
      if (++calls === 3) throw new Error("Gateway became unavailable");
    } })).rejects.toThrow("Gateway became unavailable");
    expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("not_found");
    const progress = parseLifecycleProgress(setup.entries.get(setup.progressKey)!.data);
    expect(progress.phase).toBe("visibility");
    expect(progress.purge_confirmed).toBe(true);
    await runLifecycleRestore(setup.env, setup.execution, setup.effects);
    expect(setup.events).toEqual(["feed", "purge"]);
    expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("public");
  });

  test("parent or target changes after purge are rejected instead of reopening deleted content", async () => {
    for (const fault of ["parent", "target", "generation"] as const) {
      const setup = await fixture();
      const effects = { ...setup.effects, async purge(received: Parameters<RestoreEffects["purge"]>[0]) {
        await setup.effects.purge(received);
        if (fault === "parent") {
          const current = (await readShowControl(setup.env, "daily"))!.value;
          await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ ...current, lifecycle: "unpublished" }));
        } else {
          const episode = (await readEpisodeLifecycle(setup.env, "daily", "first"))!;
          await setup.bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({ ...episode,
            ...(fault === "target" ? { lifecycle: "deleted" as const } : { generation: 2 }) }));
        }
      } };
      await expect(runLifecycleRestore(setup.env, setup.execution, effects)).rejects.toThrow();
      expect(await readPublicVisibility(setup.env, "daily", "first")).not.toBe("public");
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.jobId);
      expect(parseJobStatus(setup.entries.get(setup.statusKey)!.data).state).toBe("retrying");
    }
  });
});
