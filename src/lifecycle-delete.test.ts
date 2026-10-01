import { describe, expect, test } from "bun:test";
import { episodeLifecycleSchema, episodeRevisionSchema, parseJobStatus, parseLifecycleProgress, parseShowMetadata,
  stringifyLifecycleToml, stringifyToml } from "../packages/shared/src/index";
import type { LifecycleState } from "../packages/shared/src/index";
import { acquireShowExecution, claimShowOperation, readEpisodeLifecycle, readPublicVisibility, readShowControl } from "./lifecycle-control";
import { stepLifecycleDelete } from "./lifecycle-delete";
import type { DeleteEffects } from "./lifecycle-delete";
import { classifyLifecycleDeletionKey } from "./lifecycle-deletion";
import type { DeletionTarget } from "./lifecycle-deletion";
import { renderFeed } from "./feed";

async function fixture(options: { kind?: "show" | "episode"; parent?: LifecycleState; targetState?: LifecycleState;
  secondState?: LifecycleState } = {}) {
  const entries = new Map<string, { data: string; etag: string; size: number }>();
  const deleted: string[][] = [];
  const reads: string[] = [];
  let version = 0;
  const bucket = {
    async put(key: string, data: string, options?: { onlyIf?: Headers | { etagMatches: string } }) {
      const previous = entries.get(key);
      if (options?.onlyIf instanceof Headers && previous) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches !== previous?.etag) return null;
      const etag = String(++version);
      entries.set(key, { data, etag, size: new TextEncoder().encode(data).length });
      return { key, etag };
    },
    async get(key: string) {
      reads.push(key);
      if (key.endsWith(".mp3")) throw new Error("Deletion must not read media bodies");
      const value = entries.get(key);
      return value ? { key, ...value, text: async () => value.data, json: async () => JSON.parse(value.data) } : null;
    },
    async head(key: string) { const value = entries.get(key); return value ? { key, ...value } : null; },
    async list(options: { prefix: string; cursor?: string; limit: number }) {
      const matching = [...entries].filter(([key]) => key.startsWith(options.prefix)).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => ({ key, etag: value.etag, size: value.size }));
      const offset = Number(options.cursor ?? 0);
      return { objects: matching.slice(offset, offset + options.limit), truncated: offset + options.limit < matching.length,
        cursor: String(offset + options.limit) };
    },
    async delete(input: string | string[]) {
      const keys = typeof input === "string" ? [input] : input;
      deleted.push(keys);
      for (const key of keys) entries.delete(key);
    },
  };
  const env = { CASTLOOP_BUCKET: bucket } as never;
  const kind = options.kind ?? "episode";
  const target: DeletionTarget = kind === "show" ? { kind, showId: "daily" } : { kind, showId: "daily", episodeId: "first" };
  const show = parseShowMetadata("schema_version = 1\nshow_id = 'daily'\ntitle = 'Private Show title'\ndescription = 'Private description'\nlanguage = 'en'\nauthor = 'Author'\nowner_name = 'Owner'\nowner_email = 'owner@example.com'\ncategories = ['Arts']\nexplicit = false\nsite_url = 'https://example.com'\nimage_path = 'cover.jpg'\n");
  await bucket.put("system/shows/daily/show.toml", stringifyToml(show));
  await bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
    lifecycle: options.parent ?? "active", generation: 0, feed_generation: 0 }));
  await bucket.put("system/show-reservations/daily.json", JSON.stringify({ show_id: "daily", reservation_id: crypto.randomUUID() }));
  await bucket.put("public/podcasts/daily/feed.xml", "original feed");
  await bucket.put("public/podcasts/daily/cover.jpg", "cover");
  const states: Record<string, LifecycleState> = { first: options.targetState ?? "active", second: options.secondState ?? "active",
    stopped: "unpublished", draft: "draft", retired: "deleted" };
  const retiredJob = crypto.randomUUID();
  for (const [episodeId, lifecycle] of Object.entries(states)) {
    await bucket.put(`system/episode-lifecycle/daily/${episodeId}.toml`, stringifyLifecycleToml(episodeLifecycleSchema.parse({
      schema_version: 1, show_id: "daily", episode_id: episodeId, lifecycle, generation: 0,
      ...(episodeId === "retired" ? { last_job_id: retiredJob } : {}),
    })));
    if (lifecycle === "draft" || lifecycle === "deleted") continue;
    const revisionId = crypto.randomUUID();
    const revision = episodeRevisionSchema.parse({ schema_version: 1, episode_id: episodeId, guid: crypto.randomUUID(),
      title: `Private ${episodeId} title`, description: "Private description", published_at: "2026-10-01T12:00:00Z",
      revision_id: revisionId, enclosure_url: `https://public.example/podcasts/daily/episodes/${episodeId}/${revisionId}.mp3`,
      content_type: "audio/mpeg", length_bytes: 1, duration_seconds: 1, sha256: "a".repeat(64), updated_at: "2026-10-01T12:00:00Z" });
    await bucket.put(`public/episodes/daily/${episodeId}/metadata.toml`, stringifyToml(revision));
    await bucket.put(`public/episodes/daily/${episodeId}/revisions/${revisionId}.toml`, stringifyToml(revision));
    await bucket.put(`public/podcasts/daily/episodes/${episodeId}/${revisionId}.mp3`, "x");
  }
  const publishedJob = crypto.randomUUID();
  const marker = `staging/episodes/daily/first/${publishedJob}/commit.json`;
  await bucket.put(marker, JSON.stringify({ schema_version: 1, kind: "episode", show_id: "daily", episode_id: "first",
    job_id: publishedJob, metadata_sha256: "a".repeat(64), audio_sha256: "b".repeat(64), audio_length_bytes: 1,
    duration_seconds: 1, committed_at: "2026-10-01T12:00:00Z" }));
  await bucket.put(`staging/episodes/daily/first/${publishedJob}/episode.toml`, "Private staged title");
  await bucket.put(`staging/episodes/daily/first/${publishedJob}/audio.mp3`, "x");
  await bucket.put("system/service.toml", "keep service");
  await bucket.put("public/podcasts/daily-two/feed.xml", "keep other Show");
  const jobId = crypto.randomUUID();
  await claimShowOperation(env, { schema_version: 1, show_id: "daily", job_id: jobId, kind, action: "delete",
    expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z",
    ...(kind === "episode" ? { episode_id: "first", expected_episode_generation: 0 } : {}) });
  const execution = await acquireShowExecution(env, "daily", jobId, 1);
  const events: string[] = [];
  const effects: DeleteEffects = {
    async checkDelivery(received) {
      expect(received).toEqual(target);
      expect(await readPublicVisibility(env, "daily", kind === "episode" ? "first" : undefined))
        .toBe(kind === "episode" && (options.parent === "unpublished" || options.parent === "draft") ? "not_found" : "gone");
    },
    async writeFeed(episodes) {
      events.push("feed");
      expect(kind).toBe("episode");
      expect(episodes.map((episode) => episode.episode_id)).not.toContain("first");
      expect(episodes.map((episode) => episode.episode_id)).not.toContain("stopped");
      await bucket.put("public/podcasts/daily/feed.xml", renderFeed(show, episodes, "https://public.example", "jpg"));
    },
    async purge() { events.push("purge"); },
  };
  return { env, bucket, entries, deleted, reads, execution, jobId, target, effects, events, marker, retiredJob,
    progressKey: `system/jobs/${jobId}/progress.toml`, statusKey: `system/jobs/${jobId}/status.toml` };
}

async function complete(setup: Awaited<ReturnType<typeof fixture>>, env = setup.env, effects = setup.effects) {
  for (let step = 0; step < 200; step += 1) {
    const result = await stepLifecycleDelete(env, setup.execution, effects, { maximumObjects: 2 });
    if (result.state === "completed") return;
  }
  throw new Error("Deletion did not converge");
}

describe("M6 complete deletion state machine", () => {
  test("Episode deletion closes delivery before feed/purge, deletes payload and releases only after final purge", async () => {
    const setup = await fixture();
    let purgeCalls = 0;
    const effects = { ...setup.effects, async purge(target: DeletionTarget) {
      purgeCalls += 1;
      expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("gone");
      const payload = [...setup.entries.keys()].filter((key) => classifyLifecycleDeletionKey(target, key) === "payload");
      if (purgeCalls === 1) expect(payload.length).toBeGreaterThan(0);
      else expect(payload).toEqual([]);
      await setup.effects.purge(target);
    } };
    await complete(setup, setup.env, effects);
    expect(setup.events).toEqual(["feed", "purge", "purge"]);
    const progress = parseLifecycleProgress(setup.entries.get(setup.progressKey)!.data);
    expect(progress.phase).toBe("finished");
    expect(progress.final_purge_confirmed).toBe(true);
    expect(parseJobStatus(setup.entries.get(setup.statusKey)!.data).state).toBe("completed");
    expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.lifecycle).toBe("deleted");
    expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.generation).toBe(1);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
    expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(1);
    expect(await readPublicVisibility(setup.env, "daily", "second")).toBe("public");
    expect(setup.entries.has(setup.marker)).toBe(true);
    expect(setup.entries.get("system/service.toml")?.data).toBe("keep service");
    expect(setup.reads.some((key) => key.endsWith(".mp3"))).toBe(false);
    for (const [key, value] of setup.entries) if (key.startsWith("system/jobs/")) {
      for (const content of ["Private", "owner@example.com"]) expect(value.data).not.toContain(content);
    }
  });

  test("the last active Episode leaves a valid empty feed; stopped parents do not rewrite feeds", async () => {
    const last = await fixture({ secondState: "unpublished" });
    await complete(last);
    const feed = last.entries.get("public/podcasts/daily/feed.xml")!.data;
    expect(feed).toContain("<channel>");
    expect(feed).not.toContain("<item>");
    const stopped = await fixture({ parent: "unpublished" });
    await complete(stopped);
    expect(stopped.entries.get("public/podcasts/daily/feed.xml")?.data).toBe("original feed");
    expect((await readShowControl(stopped.env, "daily"))?.value.feed_generation).toBe(0);
  });

  test("unpublished and draft targets can be deleted without implicitly publishing them", async () => {
    for (const targetState of ["draft", "unpublished"] as const) {
      const setup = await fixture({ targetState });
      await complete(setup);
      expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.lifecycle).toBe("deleted");
      expect(setup.entries.has(setup.marker)).toBe(true);
    }
  });

  test("Show deletion finalizes child tombstones in pages, preserves earlier tombstones and never rewrites its feed", async () => {
    const setup = await fixture({ kind: "show" });
    const previous = setup.entries.get("system/episode-lifecycle/daily/retired.toml");
    await setup.bucket.put("system/episode-lifecycle/daily/stopped.toml", stringifyLifecycleToml(episodeLifecycleSchema.parse({
      schema_version: 1, show_id: "daily", episode_id: "stopped", lifecycle: "unpublished", generation: Number.MAX_SAFE_INTEGER,
    })));
    await complete(setup);
    expect(setup.events).toEqual(["purge", "purge"]);
    expect((await readShowControl(setup.env, "daily"))?.value.lifecycle).toBe("deleted");
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
    for (const episodeId of ["first", "second", "stopped", "draft"]) {
      const episode = (await readEpisodeLifecycle(setup.env, "daily", episodeId))!;
      expect(episode.lifecycle).toBe("deleted");
      expect(episode.last_job_id).toBe(setup.jobId);
    }
    expect((await readEpisodeLifecycle(setup.env, "daily", "stopped"))?.generation).toBe(Number.MAX_SAFE_INTEGER);
    expect(setup.entries.get("system/episode-lifecycle/daily/retired.toml")).toEqual(previous);
    expect(parseLifecycleProgress(setup.entries.get(setup.progressKey)!.data).tombstones_complete).toBe(true);
    expect([...setup.entries.keys()].some((key) => classifyLifecycleDeletionKey(setup.target, key) === "payload")).toBe(false);
    expect(setup.entries.has(setup.marker)).toBe(true);
    expect(setup.entries.has("system/show-reservations/daily.json")).toBe(true);
    expect(setup.entries.get("public/podcasts/daily-two/feed.xml")?.data).toBe("keep other Show");
  });

  test("initial and final purge failures keep the target closed, owner held and diagnostics private", async () => {
    for (const failureCall of [1, 2]) {
      const setup = await fixture();
      let purges = 0;
      let failed = false;
      const secret = "Private title owner@example.com Bearer confidential-token";
      const effects = { ...setup.effects, async purge(target: DeletionTarget) {
        if (++purges === failureCall) throw new Error(secret);
        await setup.effects.purge(target);
      } };
      for (let step = 0; step < 200; step += 1) {
        try {
          const result = await stepLifecycleDelete(setup.env, setup.execution, effects, { maximumObjects: 2 });
          if (result.state === "completed") break;
        } catch (error) {
          expect(error instanceof Error ? error.message : "").toBe(secret);
          failed = true;
          expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("gone");
          expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBe(setup.execution.executionId);
          const status = parseJobStatus(setup.entries.get(setup.statusKey)!.data);
          expect(status.state).toBe("retrying");
          if (status.schema_version === 2) expect(status.reason_code).toBe("cache_purge_failed");
          expect(setup.entries.get(setup.statusKey)!.data).not.toContain(secret);
        }
      }
      expect(failed).toBe(true);
      expect(purges).toBe(3);
      expect(setup.events.filter((event) => event === "feed")).toHaveLength(1);
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
    }
  });

  test("feed and delivery-gate failures do not begin physical deletion or reopen the target", async () => {
    for (const fault of ["feed", "gate"] as const) {
      const setup = await fixture();
      const effects = { ...setup.effects, ...(fault === "feed" ? {
        async writeFeed() { throw new Error("Feed unavailable"); },
      } : { async checkDelivery() { throw new Error("Gateway not ready"); } }) };
      await expect(stepLifecycleDelete(setup.env, setup.execution, effects)).rejects.toThrow();
      expect(setup.deleted).toEqual([]);
      expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.lifecycle).toBe("deleting");
      await complete(setup);
      expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.generation).toBe(1);
      expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(1);
    }
  });

  test("lost state, progress, tombstone, terminal status and release responses converge without duplicate generations", async () => {
    for (const fault of ["state", "feed-generation", "final-purge", "child", "deleted", "finished", "status", "release"] as const) {
      const setup = await fixture({ kind: fault === "child" ? "show" : "episode" });
      let lose = true;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        const written = await setup.bucket.put(...args);
        const [key, text] = args;
        const match = fault === "state" ? key === "system/episode-lifecycle/daily/first.toml" && text.includes('lifecycle = "deleting"') :
          fault === "feed-generation" ? key === "system/show-publications/daily.json" && text.includes('"last_feed_job_id"') :
          fault === "final-purge" ? key === setup.progressKey && text.includes("final_purge_confirmed = true") :
          fault === "child" ? key === "system/episode-lifecycle/daily/second.toml" && text.includes('lifecycle = "deleted"') :
          fault === "deleted" ? key === "system/episode-lifecycle/daily/first.toml" && text.includes('lifecycle = "deleted"') :
          fault === "finished" ? key === setup.progressKey && text.includes('phase = "finished"') :
          fault === "status" ? key === setup.statusKey && text.includes('state = "completed"') :
          key === "system/show-publications/daily.json" && text.includes('"last_finished_operation"');
        if (lose && written && match) { lose = false; throw new Error("Injected response loss"); }
        return written;
      } } } as never;
      let losses = 0;
      for (let step = 0; step < 200; step += 1) {
        try {
          if ((await stepLifecycleDelete(env, setup.execution, setup.effects, { maximumObjects: 2 })).state === "completed") break;
        } catch (error) {
          expect(error instanceof Error ? error.message : "").toBe("Injected response loss");
          losses += 1;
        }
      }
      expect(losses).toBe(1);
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
      expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(fault === "child" ? 0 : 1);
      if (fault !== "child") expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.generation).toBe(1);
      expect(parseJobStatus(setup.entries.get(setup.statusKey)!.data).state).toBe("completed");
    }
  });

  test("partial DELETE failure resumes from remote progress while holding the same owner", async () => {
    const setup = await fixture();
    let fail = true;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async delete(input: string | string[]) {
      if (fail) {
        fail = false;
        await setup.bucket.delete(typeof input === "string" ? input : input.slice(0, 1));
        throw new Error("Partial deletion");
      }
      await setup.bucket.delete(input);
    } } } as never;
    await stepLifecycleDelete(env, setup.execution, setup.effects);
    await expect(stepLifecycleDelete(env, setup.execution, setup.effects)).rejects.toThrow("Partial deletion");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.jobId);
    await complete(setup, env);
    expect(setup.entries.has(setup.marker)).toBe(true);
  });

  test("completed deletion replays do not touch a later owner or accept implicit resurrection", async () => {
    const setup = await fixture();
    await complete(setup);
    await expect(claimShowOperation(setup.env, { schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily", kind: "episode",
      episode_id: "first", action: "publish", expected_show_generation: 1, expected_episode_generation: 1,
      created_at: "2026-10-01T12:00:00Z" })).rejects.toThrow("does not permit");
    const nextJob = crypto.randomUUID();
    await claimShowOperation(setup.env, { schema_version: 1, job_id: nextJob, show_id: "daily", kind: "show", action: "unpublish",
      expected_show_generation: 1, created_at: "2026-10-01T12:00:00Z" });
    const count = setup.events.length;
    expect((await stepLifecycleDelete(setup.env, setup.execution, setup.effects)).state).toBe("completed");
    expect(setup.events).toHaveLength(count);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(nextJob);
  });

  test("malformed child controls block Show completion without reopening it or leaking input into job records", async () => {
    const setup = await fixture({ kind: "show" });
    let corrupted = false;
    for (let step = 0; step < 200; step += 1) {
      const result = await stepLifecycleDelete(setup.env, setup.execution, setup.effects, { maximumObjects: 2 });
      const progress = parseLifecycleProgress(setup.entries.get(setup.progressKey)!.data);
      if (result.phase === "finalizing" && !progress.final_purge_confirmed) {
        await setup.bucket.put("system/episode-lifecycle/daily/first.toml", 'title = "Secret title owner@example.com"\n');
        corrupted = true;
        break;
      }
    }
    expect(corrupted).toBe(true);
    await expect(stepLifecycleDelete(setup.env, setup.execution, setup.effects, { maximumObjects: 100 })).rejects.toThrow();
    expect((await readShowControl(setup.env, "daily"))?.value.lifecycle).toBe("deleting");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.jobId);
    expect(parseJobStatus(setup.entries.get(setup.statusKey)!.data).state).toBe("retrying");
    expect(setup.entries.get(setup.statusKey)!.data).not.toContain("Secret title");
    expect(setup.entries.get(setup.statusKey)!.data).not.toContain("owner@example.com");
  });
});
