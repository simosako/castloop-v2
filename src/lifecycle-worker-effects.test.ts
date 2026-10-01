import { describe, expect, test } from "bun:test";
import { episodeRevisionSchema, parseJobStatus, stringifyLifecycleToml, stringifyToml } from "../packages/shared/src/index";
import type { EpisodeRevision, LifecycleState } from "../packages/shared/src/index";
import { commitOwnedLifecycleOperation } from "./lifecycle-commit";
import { consumeLifecycleCommit } from "./lifecycle-consumer";
import { acquireShowExecution, readPublicVisibility, readShowControl, releaseShowExecution } from "./lifecycle-control";
import { readLifecycleFeedInputs } from "./lifecycle-feed";
import { closeOwnedLifecycleTarget } from "./lifecycle-mutations";
import { createLifecycleWorkerEffects } from "./lifecycle-worker-effects";
import type { LifecycleWorkerBindings } from "./lifecycle-worker-effects";
import { lifecycleFixture } from "./test-support/lifecycle";

const SHOW_TEXT = "schema_version = 1\nshow_id = 'daily'\ntitle = 'Saved title'\ndescription = 'Saved description'\nlanguage = 'en'\nauthor = 'Author'\nowner_name = 'Owner'\nowner_email = 'owner@example.com'\ncategories = ['Arts']\nexplicit = false\nsite_url = 'https://example.com'\nimage_path = 'cover.jpg'\n";
const SERVICE_TEXT = "schema_version = 1\nservice_id = 'service'\naccount_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\nbucket_name = 'test-bucket'\nworker_name = 'test-worker'\nqueue_name = 'test-queue'\ndlq_name = 'test-dlq'\npublic_base_url = 'https://current.example'\n";
const FEED_KEY = "public/podcasts/daily/feed.xml";

async function fixture(kind: "show" | "episode", action: "unpublish" | "restore" | "delete") {
  const setup = await lifecycleFixture({ kind, action });
  await setup.bucket.put("system/shows/daily/show.toml", SHOW_TEXT);
  await setup.bucket.put("system/service.toml", SERVICE_TEXT);
  await setup.bucket.put("public/podcasts/daily/cover.jpg", "cover");
  await setup.bucket.put(FEED_KEY, "old feed");
  const revisions = new Map<string, EpisodeRevision>();
  const states: Record<string, LifecycleState> = { first: kind === "episode" && action === "restore" ? "unpublished" : "active",
    second: "active", stopped: "unpublished", draft: "draft", deleted: "deleted" };
  for (const [episodeId, lifecycle] of Object.entries(states)) {
    await setup.bucket.put(`system/episode-lifecycle/daily/${episodeId}.toml`, stringifyLifecycleToml({ schema_version: 1,
      show_id: "daily", episode_id: episodeId, lifecycle, generation: 0 }));
    if (lifecycle === "draft" || lifecycle === "deleted") continue;
    const revision = episodeRevisionSchema.parse({ schema_version: 1, episode_id: episodeId, guid: crypto.randomUUID(),
      title: `Saved ${episodeId}`, description: "Saved Episode", published_at: "2026-09-01T12:34:56+09:00",
      revision_id: crypto.randomUUID(), enclosure_url: `https://old.example/podcasts/daily/episodes/${episodeId}/${crypto.randomUUID()}.mp3`,
      content_type: "audio/mpeg", length_bytes: 1, duration_seconds: 1, sha256: "a".repeat(64), updated_at: "2026-09-02T00:00:00Z" });
    revisions.set(episodeId, revision);
    await setup.bucket.put(`public/episodes/daily/${episodeId}/metadata.toml`, stringifyToml(revision));
    await setup.bucket.put(`public/episodes/daily/${episodeId}/revisions/${revision.revision_id}.toml`, stringifyToml(revision));
    await setup.bucket.put(new URL(revision.enclosure_url).pathname.replace(/^\//, "public/"), "x");
  }
  const { key } = await commitOwnedLifecycleOperation(setup.env, setup.operation);
  const target = { showId: "daily", ...(kind === "episode" ? { episodeId: "first" } : {}) };
  const events: string[] = [];
  const sent: unknown[] = [];
  const bindings: LifecycleWorkerBindings = {
    cachedAssets: { async invalidate(input) {
      expect(input).toEqual(target);
      events.push("purge");
      expect(await readPublicVisibility(setup.env, target.showId, target.episodeId)).toBe(action === "delete" ? "gone" : "not_found");
    } },
    queue: { async send(body) {
      events.push("send");
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
      sent.push(body);
      return { metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } };
    } },
    async checkDeliveryGate(input) { expect(input).toEqual(target); events.push("gate"); },
  };
  return { ...setup, key, bindings, target, events, sent, revisions };
}

describe("M6 lifecycle Worker effects and consumer factory", () => {
  test("Show/Episode stop, restore and delete use saved snapshots, internal purge and bound Queue", async () => {
    for (const kind of ["show", "episode"] as const) for (const action of ["unpublish", "restore", "delete"] as const) {
      const setup = await fixture(kind, action);
      const beforePayloads = new Map([...setup.entries].filter(([key]) => !key.startsWith("system/jobs/") && key !== FEED_KEY));
      let consumed = 0;
      for (;;) {
        const result = await consumeLifecycleCommit(setup.env, setup.key, (execution) =>
          createLifecycleWorkerEffects(setup.env, execution, setup.bindings), { maximumObjects: 2 });
        consumed += 1;
        expect(consumed).toBeLessThan(100);
        if (result.state === "completed") break;
        expect(result.state).toBe("continued");
      }
      expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
      expect(await readPublicVisibility(setup.env, setup.target.showId, setup.target.episodeId)).toBe(
        action === "restore" ? "public" : action === "delete" ? "gone" : "not_found");
      expect(parseJobStatus(setup.entries.get(`system/jobs/${setup.jobId}/status.toml`)!.data).state).toBe("completed");
      expect(setup.events.filter((event) => event === "purge").length).toBe(action === "delete" ? 2 : 1);
      expect(setup.sent).toHaveLength(action === "delete" ? consumed - 1 : 0);
      for (const message of setup.sent) expect(message).toEqual({ object: { key: setup.key } });
      if (kind === "show" && action !== "restore") {
        expect(setup.entries.get(FEED_KEY)?.data).toBe(action === "delete" ? undefined : "old feed");
      } else {
        const feed = setup.entries.get(FEED_KEY)!.data;
        expect(feed).toContain("Saved title");
        expect(feed).toContain("https://current.example/podcasts/daily/feed.xml");
        expect(feed.match(/<item>/g)).toHaveLength(action === "restore" ? 2 : 1);
        expect(feed).not.toContain("Saved stopped");
        expect(feed).not.toContain("Private unpublished");
        for (const [episodeId, revision] of setup.revisions) {
          if (episodeId === "stopped" || episodeId === "first" && action !== "restore") continue;
          expect(feed).toContain(revision.guid);
          expect(feed).toContain(`https://current.example${new URL(revision.enclosure_url).pathname}`);
        }
      }
      if (action !== "delete") for (const [key, entry] of beforePayloads) {
        if (key.includes("lifecycle/") || key.includes("show-publications/")) continue;
        expect(setup.entries.get(key)).toEqual(entry);
      }
    }
  });

  test("effect factory failure returns only the settled execution token and changes no public payload", async () => {
    const setup = await fixture("episode", "delete");
    const before = new Map(setup.entries);
    await expect(consumeLifecycleCommit(setup.env, setup.key, (execution) => createLifecycleWorkerEffects(setup.env, execution, {
      ...setup.bindings, async checkDeliveryGate() { throw new Error("Delivery gate is not ready"); },
    }))).rejects.toThrow("not ready");
    const control = (await readShowControl(setup.env, "daily"))!.value;
    expect(control.owner?.job_id).toBe(setup.jobId);
    expect(control.owner?.execution_id).toBeUndefined();
    for (const [key, value] of before) if (key !== "system/show-publications/daily.json") expect(setup.entries.get(key)).toEqual(value);
    expect(setup.sent).toEqual([]);
    expect(setup.events).toEqual([]);
  });

  test("live asynchronous factory never gives up its execution token prematurely", async () => {
    const setup = await fixture("show", "unpublish");
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const outcome = (async () => {
      try {
        await consumeLifecycleCommit(setup.env, setup.key, async (execution) => {
          started.resolve(); await ended.promise;
          return createLifecycleWorkerEffects(setup.env, execution, setup.bindings);
        });
        return null;
      } catch (error) { return error; }
    })();
    await started.promise;
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeString();
    await expect(consumeLifecycleCommit(setup.env, setup.key, (execution) => createLifecycleWorkerEffects(setup.env, execution, setup.bindings)))
      .rejects.toThrow("still owns");
    expect(setup.events).toEqual([]);
    ended.resolve();
    expect(await outcome).toBeNull();
  });

  test("purge failure leaves the target closed with recoverable progress and no payload deletion", async () => {
    const setup = await fixture("episode", "delete");
    const before = new Map([...setup.entries].filter(([key]) => key.startsWith("public/episodes/") || key.endsWith(".mp3")));
    await expect(consumeLifecycleCommit(setup.env, setup.key, (execution) => createLifecycleWorkerEffects(setup.env, execution, {
      ...setup.bindings, cachedAssets: { async invalidate() { throw new Error("Purge failed"); } },
    }))).rejects.toThrow("Purge failed");
    expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("gone");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    for (const [key, value] of before) expect(setup.entries.get(key)).toEqual(value);
    expect(setup.sent).toEqual([]);
    expect(parseJobStatus(setup.entries.get(`system/jobs/${setup.jobId}/status.toml`)!.data).state).toBe("retrying");
    const result = await consumeLifecycleCommit(setup.env, setup.key, (execution) => createLifecycleWorkerEffects(setup.env, execution, setup.bindings));
    expect(result.state).toBe("continued");
  });

  test("feed writes reject forged Episode content, foreign targets and expired execution tokens", async () => {
    const setup = await fixture("episode", "unpublish");
    const execution = await acquireShowExecution(setup.env, "daily", setup.jobId, 1);
    const effects = await createLifecycleWorkerEffects(setup.env, execution, setup.bindings);
    await closeOwnedLifecycleTarget(setup.env, execution);
    const feed = await readLifecycleFeedInputs(setup.env, execution);
    await expect(effects.unpublish.writeFeed(feed.episodes.map((episode) => ({ ...episode, title: "Forged metadata" })))).rejects.toThrow("no longer matches");
    expect(setup.entries.get(FEED_KEY)?.data).toBe("old feed");
    await expect(effects.unpublish.purge({ showId: "other", episodeId: "first" })).rejects.toThrow("another operation");
    await releaseShowExecution(setup.env, execution);
    await expect(effects.unpublish.writeFeed(feed.episodes)).rejects.toThrow();
    await expect(effects.unpublish.purge(setup.target)).rejects.toThrow();
    expect(setup.events).not.toContain("purge");
  });

  test("feed CAS conflict never overwrites a concurrent value or confirms purge", async () => {
    const setup = await fixture("episode", "unpublish");
    let conflict = true;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      if (conflict && args[0] === FEED_KEY) {
        conflict = false;
        await setup.bucket.put(FEED_KEY, "concurrent feed");
      }
      return setup.bucket.put(...args);
    } } } as never;
    await expect(consumeLifecycleCommit(env, setup.key, (execution) => createLifecycleWorkerEffects(env, execution, setup.bindings)))
      .rejects.toThrow("changed before writing");
    expect(setup.entries.get(FEED_KEY)?.data).toBe("concurrent feed");
    expect(setup.events).not.toContain("purge");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
  });

  test("deletion delivery check requires the exact deleting target and continuation requires its frozen marker", async () => {
    const setup = await fixture("episode", "delete");
    const execution = await acquireShowExecution(setup.env, "daily", setup.jobId, 1);
    const effects = await createLifecycleWorkerEffects(setup.env, execution, setup.bindings);
    await expect(effects.delete.checkDelivery({ kind: "episode", ...setup.target, episodeId: "first" })).rejects.toThrow("closed deleting");
    await expect(effects.delete.checkDelivery({ kind: "show", showId: "daily" })).rejects.toThrow("another operation");
    await closeOwnedLifecycleTarget(setup.env, execution);
    await effects.delete.checkDelivery({ kind: "episode", showId: "daily", episodeId: "first" });
    await releaseShowExecution(setup.env, execution);
    await expect(effects.sendContinuation(setup.key.replace(setup.jobId, crypto.randomUUID()))).rejects.toThrow("does not match");
    await setup.bucket.delete(setup.key);
    await expect(effects.sendContinuation(setup.key)).rejects.toThrow("frozen operation");
    expect(setup.sent).toEqual([]);
  });

  test("stopping the last active Episode writes an empty feed instead of removing it", async () => {
    const setup = await fixture("episode", "unpublish");
    await setup.bucket.put("system/episode-lifecycle/daily/second.toml", stringifyLifecycleToml({ schema_version: 1,
      show_id: "daily", episode_id: "second", lifecycle: "unpublished", generation: 0 }));
    expect((await consumeLifecycleCommit(setup.env, setup.key, (execution) => createLifecycleWorkerEffects(setup.env, execution, setup.bindings))).state)
      .toBe("completed");
    expect(setup.entries.get(FEED_KEY)!.data).toContain("<rss");
    expect(setup.entries.get(FEED_KEY)!.data).not.toContain("<item>");
    expect(await readPublicVisibility(setup.env, "daily")).toBe("public");
  });

  test("missing or changed feed snapshots fail closed before writing or purging", async () => {
    for (const fault of ["show", "service", "cover", "changed"] as const) {
      const setup = await fixture("episode", "unpublish");
      const showKey = "system/shows/daily/show.toml";
      if (fault !== "changed") await setup.bucket.delete(fault === "show" ? showKey : fault === "service" ? "system/service.toml" :
        "public/podcasts/daily/cover.jpg");
      let seen = false;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async get(key: string) {
        const object = await setup.bucket.get(key);
        if (key === showKey && fault === "changed" && !seen) {
          seen = true;
          await setup.bucket.put(showKey, SHOW_TEXT.replace("Saved title", "Concurrent title"));
        }
        return object;
      } } } as never;
      await expect(consumeLifecycleCommit(env, setup.key, (execution) => createLifecycleWorkerEffects(env, execution, setup.bindings))).rejects.toThrow();
      expect(setup.entries.get(FEED_KEY)?.data).toBe("old feed");
      expect(setup.events).not.toContain("purge");
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    }
  });

  test("continuation send failure retains deletion progress and permits duplicate recovery", async () => {
    const setup = await fixture("episode", "delete");
    let failed = false;
    const bindings = { ...setup.bindings, queue: { async send(body: unknown) {
      if (!failed) { failed = true; throw new Error("Queue send failed"); }
      return setup.bindings.queue.send(body);
    } } };
    await expect(consumeLifecycleCommit(setup.env, setup.key, (execution) => createLifecycleWorkerEffects(setup.env, execution, bindings)))
      .rejects.toThrow("Queue send failed");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.jobId);
    expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("gone");
    expect(setup.sent).toEqual([]);
    expect((await consumeLifecycleCommit(setup.env, setup.key, (execution) => createLifecycleWorkerEffects(setup.env, execution, bindings))).state)
      .toBe("continued");
    expect(setup.sent).toEqual([{ object: { key: setup.key } }]);
  });
});
