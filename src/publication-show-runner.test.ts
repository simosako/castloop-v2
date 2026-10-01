import { describe, expect, test } from "bun:test";
import { parseJobStatus, parseLifecycleProgress, parseShowControl } from "../packages/shared/src/index";
import { acquireShowExecution, claimShowOperation, readPublicVisibility, readShowControl } from "./lifecycle-control";
import { consumeOwnedPublication } from "./publication-consumer";
import { createShowPublicationWorkerEffects } from "./lifecycle-worker-effects";
import { runOwnedShowPublication } from "./publication-show-runner";
import type { ShowPublicationEffects } from "./publication-show-runner";
import { publicationFixture } from "./test-support/publication";

function effects(setup: Awaited<ReturnType<typeof publicationFixture>>): { effects: ShowPublicationEffects; events: string[] } {
  const events: string[] = [];
  return { events, effects: {
    async checkDeliveryGate(target) { expect(target).toEqual({ showId: "daily" }); events.push("gate"); },
    async purge(target) {
      expect(target).toEqual({ showId: "daily" });
      const control = (await readShowControl(setup.env, "daily"))!.value;
      expect(control.owner?.execution_id).toBeString();
      expect(control.last_feed_job_id).toBe(setup.operation.jobId);
      expect(setup.text(setup.feedKey)).toContain("New Show title");
      events.push("purge");
    },
  } };
}

describe("M6 owned Show publication runner", () => {
  test("initial and existing Show publication preserves media/history and keeps stopped Episodes out", async () => {
    for (const active of [false, true]) {
      const setup = await publicationFixture({ active, episodes: active });
      const bound = effects(setup);
      const before = new Map([...setup.entries].filter(([key]) => key.includes("/episodes/") || key.includes("/episode-lifecycle/")));
      await consumeOwnedPublication(setup.env, setup.key, bound.effects);
      const control = (await readShowControl(setup.env, "daily"))!.value;
      expect(control.lifecycle).toBe("active");
      expect(control.owner).toBeUndefined();
      expect(control.feed_generation).toBe(1);
      expect(control.last_finished_operation?.job_id).toBe(setup.operation.jobId);
      expect(parseJobStatus(setup.text(setup.statusKey)).state).toBe("published");
      expect(parseLifecycleProgress(setup.text(setup.progressKey)).purge_confirmed).toBe(true);
      expect(bound.events.filter((event) => event === "purge")).toHaveLength(1);
      const feed = setup.text(setup.feedKey);
      expect(feed).toContain("https://current.example/podcasts/daily/feed.xml");
      expect(feed.match(/<item>/g)?.length ?? 0).toBe(active ? 2 : 0);
      expect(feed).not.toContain("Saved stopped");
      expect(setup.entries.get("public/podcasts/daily/cover.jpg")?.httpMetadata?.contentType).toBe("image/jpeg");
      for (const [key, entry] of before) expect(setup.entries.get(key)).toEqual(entry);
      for (const key of [setup.statusKey, setup.progressKey]) {
        expect(setup.text(key)).not.toContain("Private description");
        expect(setup.text(key)).not.toContain("owner@example.com");
      }
      const count = setup.writes.length;
      expect(await consumeOwnedPublication(setup.env, setup.key, bound.effects)).toEqual({ state: "ignored", reason: "stale_operation" });
      expect(setup.writes).toHaveLength(count);
    }
  });

  test("initial Show remains private after purge failure; retry does not rewrite published payloads", async () => {
    const setup = await publicationFixture();
    const bound = effects(setup);
    await expect(consumeOwnedPublication(setup.env, setup.key, { ...bound.effects, async purge() { throw new Error("Bearer secret private title"); } }))
      .rejects.toThrow("secret");
    expect(await readPublicVisibility(setup.env, "daily")).toBe("not_found");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    expect(parseJobStatus(setup.text(setup.statusKey)).state).toBe("retrying");
    expect(setup.text(setup.statusKey)).not.toContain("Bearer secret");
    const payloads = new Map([...setup.entries].filter(([key]) => key.startsWith("public/") || key.startsWith("system/shows/")));
    await consumeOwnedPublication(setup.env, setup.key, bound.effects);
    for (const [key, entry] of payloads) expect(setup.entries.get(key)).toEqual(entry);
    expect((await readShowControl(setup.env, "daily"))?.value.feed_generation).toBe(1);
    expect(await readPublicVisibility(setup.env, "daily")).toBe("public");
  });

  test("factory and delivery gate failures make no publication payload writes", async () => {
    for (const factory of [false, true]) {
      const setup = await publicationFixture();
      const bound = effects(setup);
      const before = new Map(setup.entries);
      const failing = { ...bound.effects, async checkDeliveryGate() { throw new Error("Delivery gate unavailable"); } };
      await expect(consumeOwnedPublication(setup.env, setup.key, factory ? async () => { throw new Error("Factory unavailable"); } : failing)).rejects.toThrow("unavailable");
      for (const [key, entry] of before) if (!key.includes("show-publications/")) expect(setup.entries.get(key)).toEqual(entry);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
      expect(await readPublicVisibility(setup.env, "daily")).toBe("not_found");
      expect(bound.events).toEqual([]);
    }
  });

  test("metadata/cover/feed/generation/progress/status/release response loss resumes the same frozen job", async () => {
    for (const fault of ["metadata", "cover", "feed", "generation", "purge-progress", "visibility", "finished", "status", "release"] as const) {
      const setup = await publicationFixture();
      const bound = effects(setup);
      let lost = false;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        const written = await setup.bucket.put(...args);
        const text = typeof args[1] === "string" ? args[1] : "";
        const control = args[0] === "system/show-publications/daily.json" ? parseShowControl(JSON.parse(text)) : null;
        const progress = args[0] === setup.progressKey ? parseLifecycleProgress(text) : null;
        const matches = fault === "metadata" ? args[0] === "system/shows/daily/show.toml" : fault === "cover" ? args[0] === "public/podcasts/daily/cover.jpg" :
          fault === "feed" ? args[0] === setup.feedKey : fault === "generation" ? control?.last_feed_job_id === setup.operation.jobId :
          fault === "purge-progress" ? progress?.phase === "visibility" : fault === "visibility" ? control?.lifecycle === "active" :
          fault === "finished" ? progress?.phase === "finished" : fault === "status" ? args[0] === setup.statusKey && parseJobStatus(text).state === "published" :
          control?.last_finished_operation?.job_id === setup.operation.jobId;
        if (!lost && written && matches) { lost = true; throw new Error("Show publication response lost"); }
        return written;
      } } } as never;
      if (fault === "release") expect(await consumeOwnedPublication(env, setup.key, bound.effects)).toEqual({ state: "completed" });
      else await expect(consumeOwnedPublication(env, setup.key, bound.effects)).rejects.toThrow("response lost");
      const result = await consumeOwnedPublication(env, setup.key, bound.effects);
      expect(["completed", "ignored"]).toContain(result.state);
      const control = (await readShowControl(setup.env, "daily"))!.value;
      expect(control.owner).toBeUndefined();
      expect(control.feed_generation).toBe(1);
      expect(control.lifecycle).toBe("active");
      expect(parseJobStatus(setup.text(setup.statusKey)).state).toBe("published");
    }
  });

  test("live purge and token-acquisition response loss cannot be preempted", async () => {
    const setup = await publicationFixture();
    const bound = effects(setup);
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const outcome = (async () => {
      try { await consumeOwnedPublication(setup.env, setup.key, { ...bound.effects, async purge() { started.resolve(); await ended.promise; } }); return null; }
      catch (error) { return error; }
    })();
    await started.promise;
    await expect(consumeOwnedPublication(setup.env, setup.key, bound.effects)).rejects.toThrow("still owns");
    await expect(claimShowOperation(setup.env, { schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily", kind: "show", action: "delete",
      expected_show_generation: setup.operation.generation, created_at: "2026-10-01T12:00:00Z" })).rejects.toThrow("unfinished");
    ended.resolve();
    expect(await outcome).toBeNull();
    const other = await publicationFixture();
    let lost = false;
    const env = { CASTLOOP_BUCKET: { ...other.bucket, async put(...args: Parameters<typeof other.bucket.put>) {
      const written = await other.bucket.put(...args);
      if (!lost && written && args[0] === "system/show-publications/daily.json" && typeof args[1] === "string" && args[1].includes('"execution_id"')) {
        lost = true; throw new Error("Execution acquisition response lost");
      }
      return written;
    } } } as never;
    await expect(consumeOwnedPublication(env, other.key, effects(other).effects)).rejects.toThrow("acquisition response lost");
    expect((await readShowControl(other.env, "daily"))?.value.owner?.execution_id).toBeString();
    await expect(consumeOwnedPublication(other.env, other.key, effects(other).effects)).rejects.toThrow("still owns");
    expect(other.entries.has(other.feedKey)).toBe(false);
  });

  test("replaced staging, malformed lifecycle and output CAS conflicts never overwrite unrelated data", async () => {
    for (const fault of ["staging", "missing-lifecycle", "feed-cas"] as const) {
      const setup = await publicationFixture({ active: true, episodes: true });
      const bound = effects(setup);
      if (fault === "staging") await setup.bucket.put(`staging/shows/daily/${setup.operation.jobId}/show.toml`, "changed metadata");
      if (fault === "missing-lifecycle") await setup.bucket.delete("system/episode-lifecycle/daily/first.toml");
      let conflict = false;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        if (fault === "feed-cas" && args[0] === setup.feedKey && !conflict) { conflict = true; await setup.bucket.put(setup.feedKey, "other feed"); }
        return setup.bucket.put(...args);
      } } } as never;
      await expect(consumeOwnedPublication(env, setup.key, bound.effects)).rejects.toThrow();
      expect(setup.text(setup.feedKey)).toBe(fault === "feed-cas" ? "other feed" : "old feed");
      expect(bound.events).not.toContain("purge");
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.operation.jobId);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    }
  });

  test("published receipt replay cannot release a newer lifecycle owner", async () => {
    const setup = await publicationFixture();
    const execution = await acquireShowExecution(setup.env, "daily", setup.operation.jobId, setup.operation.generation);
    await runOwnedShowPublication(setup.env, execution, effects(setup).effects);
    const jobId = crypto.randomUUID();
    await claimShowOperation(setup.env, { schema_version: 1, job_id: jobId, show_id: "daily", kind: "show", action: "unpublish",
      expected_show_generation: setup.operation.generation, created_at: "2026-10-01T12:00:00Z" });
    const before = new Map(setup.entries);
    await runOwnedShowPublication(setup.env, execution, effects(setup).effects);
    expect(setup.entries).toEqual(before);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(jobId);
  });

  test("bound publication purge calls the cache owner only for the current Show execution", async () => {
    const setup = await publicationFixture();
    const purged: unknown[] = [];
    expect(await consumeOwnedPublication(setup.env, setup.key, (execution) => createShowPublicationWorkerEffects(setup.env, execution, {
      async checkDeliveryGate(target) { expect(target).toEqual({ showId: "daily" }); },
      cachedAssets: { async invalidate(target) { purged.push(target); } },
    }))).toEqual({ state: "completed" });
    expect(purged).toEqual([{ showId: "daily" }]);
  });

  test("consumer rejects mismatched frozen markers and ignores paths without touching payloads", async () => {
    const setup = await publicationFixture();
    expect(await consumeOwnedPublication(setup.env, "system/service.toml", effects(setup).effects)).toEqual({ state: "ignored", reason: "unmatched_path" });
    await setup.bucket.put(setup.key, JSON.stringify({ ...setup.frozen.commit, metadata_sha256: "a".repeat(64) }));
    expect(await consumeOwnedPublication(setup.env, setup.key, effects(setup).effects)).toEqual({ state: "invalid", reason: "invalid_frozen_publication" });
    expect(setup.entries.has(setup.feedKey)).toBe(false);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
  });
});
