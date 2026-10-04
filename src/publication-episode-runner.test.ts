import { describe, expect, test } from "bun:test";
import { parseEpisodeLifecycle, parseEpisodeRevision, parseJobStatus, parseLifecycleProgress, parseShowControl, stringifyLifecycleToml,
  stringifyToml } from "../packages/shared/src/index";
import { acquireShowExecution, claimShowOperation, readPublicVisibility, readShowControl } from "./lifecycle-control";
import { createPublicationWorkerEffects } from "./lifecycle-worker-effects";
import { requireOwnedPublication } from "./publication-admission";
import { consumeOwnedPublication } from "./publication-consumer";
import { runOwnedEpisodePublication } from "./publication-episode-runner";
import type { PublicationEffects } from "./publication-inputs";
import { episodePublicationFixture } from "./test-support/episode-publication";

function effects(setup: Awaited<ReturnType<typeof episodePublicationFixture>>) {
  const events: string[] = [];
  const effects: PublicationEffects = {
    async checkDeliveryGate(target) { expect(target).toEqual({ showId: "daily", episodeId: setup.episodeId }); events.push("gate"); },
    async purge(target) {
      expect(target).toEqual({ showId: "daily", episodeId: setup.episodeId });
      expect((await readShowControl(setup.env, "daily"))?.value.last_feed_job_id).toBe(setup.operation.jobId);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeString();
      events.push("purge");
    },
  };
  return { effects, events };
}

describe("M6 owned Episode publication runner", () => {
  test("initial, metadata-only and audio-only publication preserve identity and immutable history", async () => {
    for (const update of [undefined, "metadata", "audio"] as const) {
      const setup = await episodePublicationFixture(update);
      const bound = effects(setup);
      const before = new Map([...setup.entries].filter(([key]) => key.endsWith(".mp3") || key.includes("/revisions/") || key.includes("/stopped/")));
      const feedGeneration = (await readShowControl(setup.env, "daily"))!.value.feed_generation;
      const reads = setup.bodyReads.length;
      expect(await consumeOwnedPublication(setup.env, setup.key, bound.effects)).toEqual({ state: "completed" });
      expect(setup.bodyReads.slice(reads)).not.toContain(setup.mediaKey);
      const revision = parseEpisodeRevision(setup.text(setup.metadataKey));
      expect(revision.guid).toBe(setup.base?.guid ?? setup.draft.guid);
      expect(revision.published_at).toBe(setup.base?.published_at ?? setup.draft.published_at);
      expect(revision.revision_id).toBe(setup.operation.jobId);
      expect(revision.title).toBe(update === "audio" ? setup.base!.title : setup.draft.title);
      expect(parseEpisodeRevision(setup.text(setup.historyKey))).toEqual(revision);
      const state = parseEpisodeLifecycle(setup.text(setup.lifecycleKey));
      expect(state.lifecycle).toBe("active");
      expect(state.generation).toBe(1);
      expect(state.last_job_id).toBe(setup.operation.jobId);
      expect(parseJobStatus(setup.text(setup.statusKey)).state).toBe("published");
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
      expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(feedGeneration + 1);
      expect(setup.text(setup.feedKey).match(/<item>/g)).toHaveLength(update ? 2 : 3);
      expect(setup.text(setup.feedKey)).not.toContain("Saved stopped");
      expect(bound.events.filter((event) => event === "purge")).toHaveLength(1);
      for (const [key, entry] of before) expect(setup.entries.get(key)).toEqual(entry);
      if (update === "metadata") {
        expect(setup.entries.has(setup.mediaKey)).toBe(false);
        expect(new URL(revision.enclosure_url).pathname).toBe(new URL(setup.base!.enclosure_url).pathname);
        expect(revision.length_bytes).toBe(setup.base!.length_bytes);
        expect(revision.sha256).toBe(setup.base!.sha256);
      } else {
        expect(setup.entries.get(setup.mediaKey)?.bytes).toEqual(setup.audio);
        expect(new URL(revision.enclosure_url).pathname).toBe(setup.mediaKey.replace(/^public/, ""));
        expect(setup.entries.get(setup.mediaKey)?.httpMetadata?.contentType).toBe("audio/mpeg");
      }
      for (const key of [setup.statusKey, setup.progressKey]) expect(setup.text(key)).not.toContain("Private Episode description");
    }
  });

  test("new Episode stays private on purge failure and resumes without duplicating audio or history", async () => {
    const setup = await episodePublicationFixture();
    const bound = effects(setup);
    await expect(consumeOwnedPublication(setup.env, setup.key, { ...bound.effects, async purge() { throw new Error("Purge unavailable"); } })).rejects.toThrow("Purge unavailable");
    expect(await readPublicVisibility(setup.env, "daily", setup.episodeId)).toBe("not_found");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    const before = new Map(setup.entries);
    await consumeOwnedPublication(setup.env, setup.key, bound.effects);
    for (const key of [setup.mediaKey, setup.historyKey, setup.metadataKey, setup.feedKey]) expect(setup.entries.get(key)).toEqual(before.get(key));
    expect(await readPublicVisibility(setup.env, "daily", setup.episodeId)).toBe("public");
  });

  test("media/history/current/feed/generation/lifecycle/terminal response losses converge on one immutable revision", async () => {
    for (const fault of ["media", "history", "current", "feed", "generation", "visibility", "finished", "status", "release"] as const) {
      const setup = await episodePublicationFixture(fault === "current" ? "metadata" : undefined);
      const bound = effects(setup);
      const generation = (await readShowControl(setup.env, "daily"))!.value.feed_generation;
      let lost = false;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        const written = await setup.bucket.put(...args);
        const text = typeof args[1] === "string" ? args[1] : "";
        const control = args[0] === "system/show-publications/daily.json" ? parseShowControl(JSON.parse(text)) : null;
        const matches = fault === "media" ? args[0] === setup.mediaKey : fault === "history" ? args[0] === setup.historyKey :
          fault === "current" ? args[0] === setup.metadataKey : fault === "feed" ? args[0] === setup.feedKey :
          fault === "generation" ? control?.last_feed_job_id === setup.operation.jobId : fault === "visibility" ? args[0] === setup.lifecycleKey :
          fault === "finished" ? args[0] === setup.progressKey && parseLifecycleProgress(text).phase === "finished" :
          fault === "status" ? args[0] === setup.statusKey && parseJobStatus(text).state === "published" :
          control?.last_finished_operation?.job_id === setup.operation.jobId;
        if (!lost && written && matches) { lost = true; throw new Error("Episode response lost"); }
        return written;
      } } } as never;
      if (fault === "release") expect(await consumeOwnedPublication(env, setup.key, bound.effects)).toEqual({ state: "completed" });
      else await expect(consumeOwnedPublication(env, setup.key, bound.effects)).rejects.toThrow("response lost");
      await consumeOwnedPublication(env, setup.key, bound.effects);
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
      expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(generation + 1);
      expect(parseEpisodeLifecycle(setup.text(setup.lifecycleKey)).generation).toBe(1);
      expect(parseJobStatus(setup.text(setup.statusKey)).state).toBe("published");
      expect(setup.writes.filter((key) => key === setup.mediaKey)).toHaveLength(fault === "current" ? 0 : 1);
      expect(setup.writes.filter((key) => key === setup.historyKey)).toHaveLength(1);
    }
  });

  test("a live R2 stream PUT holds its execution token and blocks deletion or duplicate publication", async () => {
    const setup = await episodePublicationFixture();
    const bound = effects(setup);
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      if (args[0] === setup.mediaKey) { started.resolve(); await ended.promise; }
      return setup.bucket.put(...args);
    } } } as never;
    const outcome = (async () => {
      try { await consumeOwnedPublication(env, setup.key, bound.effects); return null; } catch (error) { return error; }
    })();
    await started.promise;
    await expect(consumeOwnedPublication(setup.env, setup.key, bound.effects)).rejects.toThrow("still owns");
    await expect(claimShowOperation(setup.env, { schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily", kind: "show", action: "delete",
      expected_show_generation: setup.operation.generation, created_at: "2026-10-01T12:00:00Z" })).rejects.toThrow("unfinished");
    expect(setup.entries.has(setup.historyKey)).toBe(false);
    ended.resolve();
    expect(await outcome).toBeNull();
  });

  test("conflicting immutable media/history are retained and never overwritten", async () => {
    for (const fault of ["media", "history", "checksum", "missing-native", "wrong-native"] as const) {
      const setup = await episodePublicationFixture();
      const bound = effects(setup);
      if (fault === "media") await setup.bucket.put(setup.mediaKey, "foreign audio", { customMetadata: { sha256: "a".repeat(64) } });
      if (fault === "checksum") await setup.bucket.put(setup.mediaKey, new Uint8Array(setup.audio.length), {
        customMetadata: { sha256: setup.frozen.commit.kind === "episode" ? setup.frozen.commit.audio_sha256! : "" },
      });
      if (fault === "missing-native" || fault === "wrong-native") {
        const sha256 = setup.frozen.commit.kind === "episode" ? setup.frozen.commit.audio_sha256! : "";
        await setup.bucket.put(setup.mediaKey, setup.audio, { customMetadata: { sha256 } });
        if (fault === "wrong-native") setup.entries.get(setup.mediaKey)!.checksums.sha256 = new Uint8Array(32).buffer;
      }
      if (fault === "history") {
        const other = parseEpisodeRevision(setup.text("public/episodes/daily/second/metadata.toml"));
        await setup.bucket.put(setup.historyKey, stringifyToml({ ...other, episode_id: setup.episodeId, revision_id: setup.operation.jobId }));
      }
      const key = fault === "history" ? setup.historyKey : setup.mediaKey;
      const before = setup.entries.get(key);
      await expect(consumeOwnedPublication(setup.env, setup.key, bound.effects)).rejects.toThrow();
      expect(setup.entries.get(key)).toEqual(before);
      expect(parseJobStatus(setup.text(setup.statusKey)).state).toBe("retrying");
      expect(parseEpisodeLifecycle(setup.text(setup.lifecycleKey)).lifecycle).toBe("draft");
      expect(bound.events).not.toContain("purge");
    }
  });

  test("GUID collisions with individually stopped Episodes are rejected before creating public media", async () => {
    const setup = await episodePublicationFixture();
    const stoppedKey = "public/episodes/daily/stopped/metadata.toml";
    const stopped = parseEpisodeRevision(setup.text(stoppedKey));
    await setup.bucket.put(stoppedKey, stringifyToml({ ...stopped, guid: setup.draft.guid }));
    await expect(consumeOwnedPublication(setup.env, setup.key, effects(setup).effects)).rejects.toThrow("GUID is already used");
    expect(setup.entries.has(setup.mediaKey)).toBe(false);
    expect(setup.entries.has(setup.historyKey)).toBe(false);
  });

  test("Episode activation replay requires durable purge progress and cannot free a later owner", async () => {
    const setup = await episodePublicationFixture();
    const execution = await acquireShowExecution(setup.env, "daily", setup.operation.jobId, setup.operation.generation);
    await runOwnedEpisodePublication(setup.env, execution, effects(setup).effects);
    const jobId = crypto.randomUUID();
    await claimShowOperation(setup.env, { schema_version: 1, job_id: jobId, show_id: "daily", kind: "show", action: "unpublish",
      expected_show_generation: setup.operation.generation, created_at: "2026-10-01T12:00:00Z" });
    const before = new Map(setup.entries);
    await runOwnedEpisodePublication(setup.env, execution, effects(setup).effects);
    expect(setup.entries).toEqual(before);
    const other = await episodePublicationFixture();
    const state = parseEpisodeLifecycle(other.text(other.lifecycleKey));
    await other.bucket.put(other.lifecycleKey, `schema_version = 1\nshow_id = 'daily'\nepisode_id = '${state.episode_id}'\nlifecycle = 'active'\ngeneration = 1\nlast_job_id = '${other.operation.jobId}'\n`);
    await expect(requireOwnedPublication(other.env, other.operation, { allowPublishedResult: true })).rejects.toThrow("frozen request");
  });

  test("bound Episode purge uses the exact episode target and never purges from a stale token", async () => {
    const setup = await episodePublicationFixture();
    const purged: unknown[] = [];
    expect(await consumeOwnedPublication(setup.env, setup.key, (execution) => createPublicationWorkerEffects(setup.env, execution, {
      async checkDeliveryGate(target) { expect(target).toEqual({ showId: "daily", episodeId: setup.episodeId }); },
      cachedAssets: { async invalidate(target) { purged.push(target); } },
    }))).toEqual({ state: "completed" });
    expect(purged).toEqual([{ showId: "daily", episodeId: setup.episodeId }]);
  });

  test("native checksum HEAD failure retains the job with fixed diagnostics and retry reuses the same media", async () => {
    const setup = await episodePublicationFixture();
    const bound = effects(setup);
    const originalFeed = setup.entries.get(setup.feedKey);
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async head(key: string) {
      if (key === setup.mediaKey && setup.entries.has(key)) throw new Error("Private Episode description owner@example.com Bearer secret");
      return setup.bucket.head(key);
    } } } as never;
    await expect(consumeOwnedPublication(env, setup.key, bound.effects)).rejects.toThrow("Bearer secret");
    expect(setup.entries.get(setup.feedKey)).toEqual(originalFeed);
    expect(setup.entries.has(setup.historyKey)).toBe(false);
    expect(setup.entries.has(setup.metadataKey)).toBe(false);
    expect(setup.text(setup.statusKey)).not.toContain("Bearer secret");
    expect(setup.text(setup.statusKey)).not.toContain("owner@example.com");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    await consumeOwnedPublication(setup.env, setup.key, bound.effects);
    expect(setup.writes.filter((key) => key === setup.mediaKey)).toHaveLength(1);
    expect(await readPublicVisibility(setup.env, "daily", setup.episodeId)).toBe("public");
  });

  test("audio-only current-metadata response loss recovers from the original base without changing the GUID or date", async () => {
    const setup = await episodePublicationFixture("audio");
    const bound = effects(setup);
    let lost = false;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      const written = await setup.bucket.put(...args);
      if (!lost && written && args[0] === setup.metadataKey) { lost = true; throw new Error("Current metadata response lost"); }
      return written;
    } } } as never;
    await expect(consumeOwnedPublication(env, setup.key, bound.effects)).rejects.toThrow("response lost");
    const history = setup.entries.get(setup.historyKey);
    const media = setup.entries.get(setup.mediaKey);
    await consumeOwnedPublication(env, setup.key, bound.effects);
    expect(setup.entries.get(setup.historyKey)).toEqual(history);
    expect(setup.entries.get(setup.mediaKey)).toEqual(media);
    const current = parseEpisodeRevision(setup.text(setup.metadataKey));
    expect(current.guid).toBe(setup.base!.guid);
    expect(current.published_at).toBe(setup.base!.published_at);
    expect(current.title).toBe(setup.base!.title);
  });

  test("stopped parent or Episode never gets revived by a queued publication", async () => {
    for (const parent of [false, true]) {
      const setup = await episodePublicationFixture();
      const before = new Map([...setup.entries].filter(([key]) => key.startsWith("public/")));
      if (parent) {
        const current = (await readShowControl(setup.env, "daily"))!.value;
        await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ ...current, lifecycle: "unpublished" }));
      } else {
        const episode = parseEpisodeLifecycle(setup.text(setup.lifecycleKey));
        await setup.bucket.put(setup.lifecycleKey, stringifyLifecycleToml({ ...episode, lifecycle: "unpublished" }));
      }
      await expect(consumeOwnedPublication(setup.env, setup.key, effects(setup).effects)).rejects.toThrow();
      for (const [key, entry] of before) expect(setup.entries.get(key)).toEqual(entry);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.operation.jobId);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
      expect(await readPublicVisibility(setup.env, "daily", setup.episodeId)).toBe("not_found");
    }
  });
});
