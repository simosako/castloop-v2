import { describe, expect, test } from "bun:test";
import { parseLifecycleProgress } from "../packages/shared/src/index";
import { commitOwnedLifecycleOperation } from "./lifecycle-commit";
import { consumeLifecycleCommit, LifecycleExecutionBusy, requeueLifecycleOperation } from "./lifecycle-consumer";
import type { LifecycleConsumerEffects } from "./lifecycle-consumer";
import { abandonReservedShowOperation, acquireShowExecution, claimShowOperation, readPublicVisibility, readShowControl } from "./lifecycle-control";
import { lifecycleFixture } from "./test-support/lifecycle";

async function fixture(action: "unpublish" | "delete" = "unpublish") {
  const setup = await lifecycleFixture({ action });
  const { key, marker } = await commitOwnedLifecycleOperation(setup.env, setup.operation);
  const sent: string[] = [];
  const effects: LifecycleConsumerEffects = {
    unpublish: { async writeFeed() { throw new Error("Show unpublish must not rewrite feed"); }, async purge() {} },
    restore: { async writeFeed() { throw new Error("Unexpected restore"); }, async purge() {}, async checkDeliveryGate() {} },
    delete: { async writeFeed() { throw new Error("Show deletion must not rewrite feed"); }, async purge() {}, async checkDelivery() {
      expect(await readPublicVisibility(setup.env, "daily")).toBe("gone");
    } },
    async sendContinuation(value) {
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
      sent.push(value);
    },
  };
  return { ...setup, key, marker, effects, sent };
}

describe("M6 lifecycle consumer invocation and continuation", () => {
  test("unpublish completes under an invocation token and duplicate delivery has no side effects", async () => {
    const setup = await fixture();
    let purges = 0;
    const effects = { ...setup.effects, unpublish: { ...setup.effects.unpublish, async purge() {
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeString();
      purges += 1;
    } } };
    expect((await consumeLifecycleCommit(setup.env, setup.key, effects)).state).toBe("completed");
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
    const before = new Map(setup.entries);
    expect(await consumeLifecycleCommit(setup.env, setup.key, effects)).toEqual({ state: "ignored", reason: "stale_operation" });
    expect(setup.entries).toEqual(before);
    expect(purges).toBe(1);
    expect(setup.sent).toEqual([]);
  });

  test("deletion crosses multiple invocations using durable progress and new execution tokens", async () => {
    const setup = await fixture("delete");
    await setup.bucket.put("public/podcasts/daily/feed.xml", "delete this feed");
    await setup.bucket.put("public/podcasts/daily/cover.jpg", "delete this cover");
    const tokens = new Set<string>();
    const effects = { ...setup.effects, delete: { ...setup.effects.delete, async checkDelivery(target: Parameters<typeof setup.effects.delete.checkDelivery>[0]) {
      tokens.add((await readShowControl(setup.env, "daily"))!.value.owner!.execution_id!);
      await setup.effects.delete.checkDelivery(target);
    } } };
    let completed = false;
    for (let step = 0; step < 100; step += 1) {
      const result = await consumeLifecycleCommit(setup.env, setup.key, effects, { maximumObjects: 1 });
      if (result.state === "completed") { completed = true; break; }
      expect(result.state).toBe("continued");
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("processing");
    }
    expect(completed).toBe(true);
    expect(tokens.size).toBeGreaterThan(5);
    expect(setup.sent.length).toBeGreaterThan(5);
    expect(setup.sent.every((key) => key === setup.key)).toBe(true);
    expect((await readShowControl(setup.env, "daily"))?.value.lifecycle).toBe("deleted");
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
    expect(setup.entries.has(setup.key)).toBe(true);
    expect(parseLifecycleProgress(setup.entries.get(`system/jobs/${setup.jobId}/progress.toml`)!.data).phase).toBe("finished");
  });

  test("a delayed purge keeps the token until its promise settles; duplicate invocation cannot run", async () => {
    const setup = await fixture();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const running = consumeLifecycleCommit(setup.env, setup.key, { ...setup.effects, unpublish: { ...setup.effects.unpublish,
      async purge() { entered.resolve(); await released.promise; throw new Error("Purge failed after settling"); } } });
    const outcome = (async () => {
      try { await running; return null; }
      catch (error) { return error; }
    })();
    await entered.promise;
    const owner = (await readShowControl(setup.env, "daily"))!.value.owner!;
    expect(owner.execution_id).toBeString();
    await expect(consumeLifecycleCommit(setup.env, setup.key, setup.effects)).rejects.toBeInstanceOf(LifecycleExecutionBusy);
    expect((await readShowControl(setup.env, "daily"))!.value.owner).toEqual(owner);
    released.resolve();
    const failure = await outcome;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Purge failed after settling");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBeUndefined();
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.jobId);
    expect((await consumeLifecycleCommit(setup.env, setup.key, setup.effects)).state).toBe("completed");
  });

  test("failed continuation sends leave processing durable and retryable without releasing admission", async () => {
    const setup = await fixture("delete");
    const effects = { ...setup.effects, async sendContinuation() { throw new Error("Queue send failed"); } };
    await expect(consumeLifecycleCommit(setup.env, setup.key, effects)).rejects.toThrow("Queue send failed");
    const current = (await readShowControl(setup.env, "daily"))!.value;
    expect(current.owner?.job_id).toBe(setup.jobId);
    expect(current.owner?.execution_id).toBeUndefined();
    expect(parseLifecycleProgress(setup.entries.get(`system/jobs/${setup.jobId}/progress.toml`)!.data).phase).toBe("deleting");
    await requeueLifecycleOperation(setup.env, setup.marker, setup.effects.sendContinuation);
    expect(setup.sent).toEqual([setup.key]);
    expect((await consumeLifecycleCommit(setup.env, setup.key, setup.effects)).state).toBe("continued");
  });

  test("lost continuation success can produce duplicates but they converge to one deletion", async () => {
    const setup = await fixture("delete");
    const pending: string[] = [];
    let lose = true;
    const effects = { ...setup.effects, async sendContinuation(key: string) {
      pending.push(key);
      if (lose) { lose = false; throw new Error("Queue success response lost"); }
    } };
    await expect(consumeLifecycleCommit(setup.env, setup.key, effects)).rejects.toThrow("response lost");
    pending.push(setup.key);
    let completed = 0;
    let ignored = 0;
    for (let step = 0; pending.length && step < 100; step += 1) {
      const result = await consumeLifecycleCommit(setup.env, pending.shift()!, effects);
      if (result.state === "completed") completed += 1;
      if (result.state === "ignored") ignored += 1;
    }
    expect(pending).toEqual([]);
    expect(completed).toBe(1);
    expect(ignored).toBe(1);
    expect((await readShowControl(setup.env, "daily"))?.value.lifecycle).toBe("deleted");
  });

  test("lost execution acquisition retains its unknown token and rejects remote retry", async () => {
    const setup = await fixture();
    let lose = true;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      const written = await setup.bucket.put(...args);
      if (lose && written && args[0] === "system/show-publications/daily.json" && args[1].includes('"execution_id"')) {
        lose = false;
        throw new Error("Execution acquisition response lost");
      }
      return written;
    } } } as never;
    await expect(consumeLifecycleCommit(env, setup.key, setup.effects)).rejects.toThrow("acquisition response lost");
    const control = (await readShowControl(setup.env, "daily"))!.value;
    expect(control.owner?.execution_id).toBeString();
    expect(control.lifecycle).toBe("active");
    await expect(consumeLifecycleCommit(setup.env, setup.key, setup.effects)).rejects.toBeInstanceOf(LifecycleExecutionBusy);
    await expect(requeueLifecycleOperation(setup.env, setup.marker, setup.effects.sendContinuation)).rejects.toBeInstanceOf(LifecycleExecutionBusy);
    expect((await readShowControl(setup.env, "daily"))!.value).toEqual(control);
  });

  test("release response loss is read back while release failure retains the execution token", async () => {
    for (const persisted of [true, false]) {
      const setup = await fixture();
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
        if (args[0] === "system/show-publications/daily.json" && args[1].includes('"state":"processing"') &&
          !args[1].includes('"execution_id"')) {
          if (persisted) await setup.bucket.put(...args);
          throw new Error("Execution release unavailable");
        }
        return setup.bucket.put(...args);
      } } } as never;
      await expect(consumeLifecycleCommit(env, setup.key, { ...setup.effects, unpublish: { ...setup.effects.unpublish,
        async purge() { throw new Error("Purge unavailable"); } } })).rejects.toThrow(persisted ? "Purge unavailable" : "release unavailable");
      expect(Boolean((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id)).toBe(!persisted);
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.jobId);
    }
  });

  test("a completed release response loss succeeds via the owner-checked receipt", async () => {
    const setup = await fixture();
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      const written = await setup.bucket.put(...args);
      if (written && args[0] === "system/show-publications/daily.json" && args[1].includes('"last_finished_operation"')) {
        throw new Error("Completion release response lost");
      }
      return written;
    } } } as never;
    expect((await consumeLifecycleCommit(env, setup.key, setup.effects)).state).toBe("completed");
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });

  test("bad paths and corrupt markers do not execute or persist input text", async () => {
    const setup = await fixture();
    const count = setup.writes.length;
    expect(await consumeLifecycleCommit(setup.env, "staging/lifecycle/shows/private@example.com/invalid/commit.json", setup.effects))
      .toEqual({ state: "ignored", reason: "unmatched_path" });
    expect(setup.writes).toHaveLength(count);
    await setup.bucket.put(setup.key, JSON.stringify({ ...setup.marker, title: "Private title" }));
    const before = new Map(setup.entries);
    expect(await consumeLifecycleCommit(setup.env, setup.key, setup.effects)).toEqual({ state: "invalid", reason: "invalid_lifecycle_commit" });
    expect(setup.entries).toEqual(before);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.state).toBe("reserved");
  });

  test("abandoned and older job deliveries never mutate a later owner", async () => {
    const setup = await fixture();
    await abandonReservedShowOperation(setup.env, "daily", setup.jobId, 1);
    const nextJob = crypto.randomUUID();
    await claimShowOperation(setup.env, { ...setup.request, job_id: nextJob, expected_show_generation: 2 });
    const before = new Map(setup.entries);
    expect(await consumeLifecycleCommit(setup.env, setup.key, setup.effects)).toEqual({ state: "ignored", reason: "stale_operation" });
    expect(setup.entries).toEqual(before);
    await expect(requeueLifecycleOperation(setup.env, setup.marker, setup.effects.sendContinuation)).rejects.toThrow("owns");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(nextJob);
  });

  test("manually acquired tokens are never cleared merely to permit a retry", async () => {
    const setup = await fixture();
    const execution = await acquireShowExecution(setup.env, "daily", setup.jobId, 1);
    await expect(requeueLifecycleOperation(setup.env, setup.marker, setup.effects.sendContinuation)).rejects.toBeInstanceOf(LifecycleExecutionBusy);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBe(execution.executionId);
    expect(setup.entries.has(`system/jobs/${setup.jobId}/status.toml`)).toBe(false);
  });

  test("Show restoration is dispatched through prepared snapshot validation and purge", async () => {
    const setup = await lifecycleFixture({ action: "restore" });
    const committed = await commitOwnedLifecycleOperation(setup.env, setup.operation);
    await setup.bucket.put("system/shows/daily/show.toml", "schema_version = 1\nshow_id = 'daily'\ntitle = 'Saved title'\ndescription = 'Saved description'\nlanguage = 'en'\nauthor = 'Author'\nowner_name = 'Owner'\nowner_email = 'owner@example.com'\ncategories = ['Arts']\nexplicit = false\nsite_url = 'https://example.com'\nimage_path = 'cover.jpg'\n");
    await setup.bucket.put("system/service.toml", "schema_version = 1\nservice_id = 'service'\naccount_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\nbucket_name = 'test-bucket'\nworker_name = 'test-worker'\nqueue_name = 'test-queue'\ndlq_name = 'test-dlq'\npublic_base_url = 'https://current.example'\n");
    await setup.bucket.put("public/podcasts/daily/cover.jpg", "cover");
    const unused = await fixture();
    const calls: string[] = [];
    const effects = { ...unused.effects, restore: {
      async checkDeliveryGate() {},
      async writeFeed(snapshot: Parameters<LifecycleConsumerEffects["restore"]["writeFeed"]>[0]) {
        calls.push("feed");
        expect(snapshot.episodes).toEqual([]);
        expect(snapshot.service.public_base_url).toBe("https://current.example");
      },
      async purge() { calls.push("purge"); expect(await readPublicVisibility(setup.env, "daily")).toBe("not_found"); },
    } };
    expect((await consumeLifecycleCommit(setup.env, committed.key, effects)).state).toBe("completed");
    expect(calls).toEqual(["feed", "purge"]);
    expect(await readPublicVisibility(setup.env, "daily")).toBe("public");
    expect((await readShowControl(setup.env, "daily"))?.value.owner).toBeUndefined();
  });
});
