import { describe, expect, test } from "bun:test";
import { episodeLifecycleSchema, episodeRevisionSchema, parseJobStatus, parseLifecycleProgress,
  stringifyLifecycleToml, stringifyToml } from "../packages/shared/src/index";
import { acquireShowExecution, claimShowOperation, readEpisodeLifecycle, readPublicVisibility,
  readShowControl } from "./lifecycle-control";
import { runLifecycleUnpublish } from "./lifecycle-unpublish";

async function fixture(options: { episode?: boolean; parentStopped?: boolean } = {}) {
  const entries = new Map<string, { data: string; etag: string; size: number }>();
  let version = 0;
  const bucket = {
    async put(key: string, data: string, options?: { onlyIf?: Headers | { etagMatches: string } }) {
      const old = entries.get(key);
      if (options?.onlyIf instanceof Headers && old) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) && options.onlyIf.etagMatches !== old?.etag) return null;
      const etag = String(++version);
      entries.set(key, { data, etag, size: new TextEncoder().encode(data).length });
      return { key, etag };
    },
    async get(key: string) {
      const value = entries.get(key);
      return value ? { key, ...value, text: async () => value.data, json: async () => JSON.parse(value.data) } : null;
    },
    async head(key: string) { const value = entries.get(key); return value ? { key, ...value } : null; },
    async list(options: { prefix: string }) {
      return { objects: [...entries].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => ({ key, ...value })), truncated: false };
    },
  };
  await bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
    lifecycle: options.parentStopped ? "unpublished" : "active", generation: 0, feed_generation: 0 }));
  for (const episodeId of ["first", "second", "stopped"]) {
    await bucket.put(`system/episode-lifecycle/daily/${episodeId}.toml`, stringifyLifecycleToml(episodeLifecycleSchema.parse({
      schema_version: 1, show_id: "daily", episode_id: episodeId,
      lifecycle: episodeId === "stopped" ? "unpublished" : "active", generation: 0,
    })));
    const revisionId = crypto.randomUUID();
    const revision = episodeRevisionSchema.parse({ schema_version: 1, episode_id: episodeId, guid: crypto.randomUUID(),
      title: episodeId, description: episodeId, published_at: "2026-10-01T12:00:00Z", revision_id: revisionId,
      enclosure_url: `https://public.example/podcasts/daily/episodes/${episodeId}/${revisionId}.mp3`,
      content_type: "audio/mpeg", length_bytes: 1, duration_seconds: 1, sha256: "a".repeat(64), updated_at: "2026-10-01T12:00:00Z" });
    await bucket.put(`public/episodes/daily/${episodeId}/metadata.toml`, stringifyToml(revision));
    await bucket.put(`public/podcasts/daily/episodes/${episodeId}/${revisionId}.mp3`, "x");
  }
  const env = { CASTLOOP_BUCKET: bucket } as never;
  const request = { schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily", kind: options.episode ? "episode" : "show",
    action: "unpublish", expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z",
    ...(options.episode ? { episode_id: "first", expected_episode_generation: 0 } : {}) };
  await claimShowOperation(env, request);
  const execution = await acquireShowExecution(env, "daily", request.job_id, 1);
  return { env, entries, bucket, execution, request };
}

describe("M6 unpublish state machine", () => {
  test("Show stop closes every asset, preserves all content and child state, and releases after purge", async () => {
    const setup = await fixture();
    const content = [...setup.entries].filter(([key]) => key.startsWith("public/"));
    const calls: string[] = [];
    await runLifecycleUnpublish(setup.env, setup.execution, {
      async writeFeed() { throw new Error("Show unpublish must not write its feed"); },
      async purge(target) {
        calls.push("purge");
        expect(target).toEqual({ showId: "daily" });
        expect(await readPublicVisibility(setup.env, "daily")).toBe("not_found");
        expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("not_found");
        expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBe(setup.execution.executionId);
      },
    });
    expect(calls).toEqual(["purge"]);
    expect([...setup.entries].filter(([key]) => key.startsWith("public/"))).toEqual(content);
    expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.lifecycle).toBe("active");
    const control = (await readShowControl(setup.env, "daily"))!.value;
    expect(control.lifecycle).toBe("unpublished");
    expect(control.owner).toBeUndefined();
    expect(control.feed_generation).toBe(0);
    const status = parseJobStatus(setup.entries.get(`system/jobs/${setup.request.job_id}/status.toml`)!.data);
    expect(status.state).toBe("completed");
    expect(status.schema_version).toBe(2);
    await runLifecycleUnpublish(setup.env, setup.execution, {
      async writeFeed() { throw new Error("Completed work must not repeat"); },
      async purge() { throw new Error("Completed work must not repeat"); },
    });
  });

  test("Episode stop precedes feed update/purge, excludes other stopped children, and advances feed once", async () => {
    const setup = await fixture({ episode: true });
    const calls: string[] = [];
    await runLifecycleUnpublish(setup.env, setup.execution, {
      async writeFeed(episodes) {
        calls.push("feed");
        expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("not_found");
        expect(await readPublicVisibility(setup.env, "daily", "second")).toBe("public");
        expect(episodes.map((episode) => episode.episode_id)).toEqual(["second"]);
      },
      async purge(target) { calls.push("purge"); expect(target).toEqual({ showId: "daily", episodeId: "first" }); },
    });
    expect(calls).toEqual(["feed", "purge"]);
    const episode = (await readEpisodeLifecycle(setup.env, "daily", "first"))!;
    expect(episode.generation).toBe(1);
    expect(episode.last_job_id).toBe(setup.request.job_id);
    expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(1);
    expect((await readShowControl(setup.env, "daily"))?.value.last_feed_job_id).toBe(setup.request.job_id);
  });

  test("a stopped parent skips feed mutation without skipping child stop or purge", async () => {
    const setup = await fixture({ episode: true, parentStopped: true });
    let purges = 0;
    await runLifecycleUnpublish(setup.env, setup.execution, {
      async writeFeed() { throw new Error("Stopped parent feed must not be written"); },
      async purge() { purges += 1; },
    });
    expect(purges).toBe(1);
    expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.lifecycle).toBe("unpublished");
    expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(0);
  });

  test("purge failure retains the stopped target and owner; retry does not rewrite a completed feed", async () => {
    const setup = await fixture({ episode: true });
    let feeds = 0;
    let purges = 0;
    const effects = {
      async writeFeed() { feeds += 1; },
      async purge() { if (++purges === 1) throw new Error("Cache purge failed"); },
    };
    await expect(runLifecycleUnpublish(setup.env, setup.execution, effects)).rejects.toThrow("Cache purge failed");
    expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("not_found");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBe(setup.execution.executionId);
    expect(parseJobStatus(setup.entries.get(`system/jobs/${setup.request.job_id}/status.toml`)!.data).state).toBe("retrying");
    await runLifecycleUnpublish(setup.env, setup.execution, effects);
    expect(feeds).toBe(1);
    expect(purges).toBe(2);
    expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.generation).toBe(1);
    expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(1);
  });

  test("feed failure retries idempotent state transition while preserving immutable audio", async () => {
    const setup = await fixture({ episode: true });
    const media = [...setup.entries].filter(([key]) => key.endsWith(".mp3"));
    let feeds = 0;
    const effects = { async writeFeed() { if (++feeds === 1) throw new Error("Feed unavailable"); }, async purge() {} };
    await expect(runLifecycleUnpublish(setup.env, setup.execution, effects)).rejects.toThrow("Feed unavailable");
    await runLifecycleUnpublish(setup.env, setup.execution, effects);
    expect(feeds).toBe(2);
    expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.generation).toBe(1);
    expect([...setup.entries].filter(([key]) => key.endsWith(".mp3"))).toEqual(media);
  });

  test("a lost terminal status response resumes only finalization and never repeats purging", async () => {
    const setup = await fixture();
    let lose = true;
    let purges = 0;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      const written = await setup.bucket.put(...args);
      if (lose && args[0].endsWith("/status.toml") && args[1].includes('state = "completed"')) {
        lose = false;
        throw new Error("Terminal status response lost");
      }
      return written;
    } } } as never;
    const effects = { async writeFeed() {}, async purge() { purges += 1; } };
    await expect(runLifecycleUnpublish(env, setup.execution, effects)).rejects.toThrow("response lost");
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeDefined();
    expect(parseLifecycleProgress(setup.entries.get(`system/jobs/${setup.request.job_id}/progress.toml`)!.data).purge_confirmed).toBe(true);
    await runLifecycleUnpublish(env, setup.execution, effects);
    expect(purges).toBe(1);
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("corrupt progress and wrong invocation tokens fail before effects", async () => {
    const setup = await fixture();
    const effects = { async writeFeed() { throw new Error("Unexpected feed effect"); }, async purge() { throw new Error("Unexpected purge effect"); } };
    await expect(runLifecycleUnpublish(setup.env, { ...setup.execution, executionId: crypto.randomUUID() }, effects)).rejects.toThrow("execution token");
    await setup.bucket.put(`system/jobs/${setup.request.job_id}/progress.toml`, "broken");
    await expect(runLifecycleUnpublish(setup.env, setup.execution, effects)).rejects.toThrow();
    expect(await readPublicVisibility(setup.env, "daily")).toBe("public");
  });

  test("retained failure records contain no injected title, description, email or token", async () => {
    const setup = await fixture({ episode: true });
    const privateMessage = "Private title; confidential description; owner@example.com; Bearer super-secret-token";
    await expect(runLifecycleUnpublish(setup.env, setup.execution, {
      async writeFeed() {}, async purge() { throw new Error(privateMessage); },
    })).rejects.toThrow(privateMessage);
    const statusText = setup.entries.get(`system/jobs/${setup.request.job_id}/status.toml`)!.data;
    const status = parseJobStatus(statusText);
    expect(status.schema_version).toBe(2);
    if (status.schema_version === 2) {
      expect(status.reason_code).toBe("cache_purge_failed");
      expect(status.reason).toBe("Cache purge failed.");
    }
    for (const [key, object] of setup.entries) {
      if (key.startsWith("system/jobs/")) {
        for (const value of ["Private title", "confidential description", "owner@example.com", "super-secret-token"]) {
          expect(object.data).not.toContain(value);
        }
      }
    }
  });

  test("lost state, feed-generation, progress and release responses converge without double generations", async () => {
    for (const fault of ["show", "episode", "feed-generation", "progress", "release"] as const) {
      const setup = await fixture({ episode: fault !== "show" });
      let lose = true;
      let purges = 0;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        const written = await setup.bucket.put(...args);
        const key = args[0];
        const text = args[1];
        const matches = fault === "show" ? key === "system/show-publications/daily.json" && text.includes('"lifecycle":"unpublished"') :
          fault === "episode" ? key === "system/episode-lifecycle/daily/first.toml" :
          fault === "feed-generation" ? key === "system/show-publications/daily.json" && text.includes('"last_feed_job_id"') :
          fault === "progress" ? key.endsWith("/progress.toml") && text.includes('phase = "finished"') :
          key === "system/show-publications/daily.json" && text.includes('"last_finished_operation"');
        if (lose && written && matches) { lose = false; throw new Error("Injected response loss"); }
        return written;
      } } } as never;
      const effects = { async writeFeed() {}, async purge() { purges += 1; } };
      await expect(runLifecycleUnpublish(env, setup.execution, effects)).rejects.toThrow("response loss");
      await runLifecycleUnpublish(env, setup.execution, effects);
      const control = (await readShowControl(setup.env, "daily"))!.value;
      expect(control.owner).toBeUndefined();
      expect(control.feed_generation).toBe(fault === "show" ? 0 : 1);
      if (fault !== "show") expect((await readEpisodeLifecycle(setup.env, "daily", "first"))?.generation).toBe(1);
      expect(purges).toBe(1);
    }
  });
});
