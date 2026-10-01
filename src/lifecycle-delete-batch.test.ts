import { describe, expect, test } from "bun:test";
import { episodeLifecycleSchema, lifecycleProgressSchema, parseLifecycleProgress, stringifyLifecycleProgress,
  stringifyLifecycleToml } from "../packages/shared/src/index";
import { acquireShowExecution, claimShowOperation, readPublicVisibility, readShowControl } from "./lifecycle-control";
import { stepLifecyclePayloadDeletion } from "./lifecycle-delete-batch";
import { classifyLifecycleDeletionKey } from "./lifecycle-deletion";
import type { DeletionTarget } from "./lifecycle-deletion";

async function fixture(kind: "show" | "episode" = "episode") {
  const entries = new Map<string, { data: string; etag: string; size: number }>();
  const deleted: string[][] = [];
  const readBodies: string[] = [];
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
      readBodies.push(key);
      if (key.endsWith(".mp3")) throw new Error("Media must not be read during deletion");
      const value = entries.get(key);
      return value ? { key, ...value, text: async () => value.data, json: async () => JSON.parse(value.data) } : null;
    },
    async head(key: string) { const value = entries.get(key); return value ? { key, ...value } : null; },
    async list(options: { prefix: string; limit: number; cursor?: string }) {
      const objects = [...entries].filter(([key]) => key.startsWith(options.prefix)).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, etag: value.etag, size: value.size }));
      const offset = Number(options.cursor ?? 0);
      return { objects: objects.slice(offset, offset + options.limit), truncated: offset + options.limit < objects.length,
        cursor: String(offset + options.limit) };
    },
    async delete(input: string | string[]) {
      const keys = typeof input === "string" ? [input] : input;
      deleted.push(keys);
      for (const key of keys) entries.delete(key);
    },
  };
  const env = { CASTLOOP_BUCKET: bucket } as never;
  const jobId = crypto.randomUUID();
  const publicationJobId = crypto.randomUUID();
  const revision = crypto.randomUUID();
  const target: DeletionTarget = kind === "show" ? { kind, showId: "daily" } : { kind, showId: "daily", episodeId: "first" };
  await bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
    lifecycle: "active", generation: 0, feed_generation: 0 }));
  await bucket.put("system/show-reservations/daily.json", JSON.stringify({ show_id: "daily", reservation_id: crypto.randomUUID() }));
  await bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml(episodeLifecycleSchema.parse({
    schema_version: 1, show_id: "daily", episode_id: "first", lifecycle: "active", generation: 0,
  })));
  await claimShowOperation(env, { schema_version: 1, job_id: jobId, show_id: "daily", kind, action: "delete",
    expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z",
    ...(kind === "episode" ? { episode_id: "first", expected_episode_generation: 0 } : {}) });
  const execution = await acquireShowExecution(env, "daily", jobId, 1);
  const control = (await readShowControl(env, "daily"))!.value;
  if (kind === "show") await bucket.put("system/show-publications/daily.json", JSON.stringify({ ...control, lifecycle: "deleting" }));
  else await bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml(episodeLifecycleSchema.parse({
    schema_version: 1, show_id: "daily", episode_id: "first", lifecycle: "deleting", generation: 1, last_job_id: jobId,
  })));
  const progress = lifecycleProgressSchema.parse({ schema_version: 1, job_id: jobId, show_id: "daily", kind, action: "delete",
    ...(kind === "episode" ? { episode_id: "first" } : {}), show_generation: 1, request_sha256: control.owner!.request_sha256,
    phase: "deleting", deleted_objects: 0, purge_confirmed: true, deletion_scope_index: 0, updated_at: "2026-10-01T12:00:00Z" });
  const progressKey = `system/jobs/${jobId}/progress.toml`;
  await bucket.put(progressKey, stringifyLifecycleProgress(progress));
  const payload = ["system/shows/daily/show.toml", "public/podcasts/daily/feed.xml", "public/podcasts/daily/cover.jpg",
    `public/podcasts/daily/episodes/first/${revision}.mp3`, "public/episodes/daily/first/metadata.toml",
    `public/episodes/daily/first/revisions/${revision}.toml`, `staging/episodes/daily/first/${publicationJobId}/audio.mp3`,
    `staging/episodes/daily/first/${publicationJobId}/episode.toml`, `staging/shows/daily/${publicationJobId}/show.toml`,
    `staging/shows/daily/${publicationJobId}/cover.jpg`];
  for (const key of payload) await bucket.put(key, "Private title and description to remove");
  const episodeMarker = `staging/episodes/daily/first/${publicationJobId}/commit.json`;
  const showMarker = `staging/shows/daily/${publicationJobId}/commit.json`;
  const episodeCommit = { schema_version: 1, kind: "episode", show_id: "daily", episode_id: "first", job_id: publicationJobId,
    metadata_sha256: "a".repeat(64), audio_sha256: "b".repeat(64), audio_length_bytes: 300_000_000,
    duration_seconds: 42, committed_at: "2026-10-01T12:00:00Z" };
  await bucket.put(episodeMarker, JSON.stringify(episodeCommit));
  await bucket.put(showMarker, JSON.stringify({ schema_version: 1, kind: "show", show_id: "daily", job_id: publicationJobId,
    metadata_sha256: "a".repeat(64), cover_sha256: "b".repeat(64), cover_extension: "jpg" }));
  for (const key of ["public/podcasts/daily-two/feed.xml", `public/podcasts/daily/episodes/first-two/${revision}.mp3`,
    `staging/lifecycle/shows/daily/${jobId}/commit.json`, `system/jobs/${publicationJobId}/status.toml`, "system/service.toml"]) {
    await bucket.put(key, "keep");
  }
  async function checkDelivery(requested: DeletionTarget) {
    expect(requested).toEqual(target);
    expect(await readPublicVisibility(env, "daily", kind === "episode" ? "first" : undefined)).toBe("gone");
  }
  return { env, entries, bucket, deleted, readBodies, target, execution, jobId, publicationJobId, progressKey,
    progress, payload, episodeMarker, showMarker, episodeCommit, checkDelivery };
}

async function finishBatches(setup: Awaited<ReturnType<typeof fixture>>, env = setup.env, maximumObjects = 2) {
  for (let step = 0; step < 150; step += 1) {
    const result = await stepLifecyclePayloadDeletion(env, setup.execution, setup.checkDelivery, { maximumObjects });
    if (result.readyForFinalization) return result;
  }
  throw new Error("Deletion did not converge within the test limit");
}

describe("M6 owner-gated payload deletion batches", () => {
  test("Episode batches remove all revisions/drafts and retain markers, controls, jobs and nearby IDs", async () => {
    const setup = await fixture();
    const before = new Map(setup.entries);
    const result = await finishBatches(setup);
    expect(result.progress.phase).toBe("finalizing");
    expect(result.progress.deletion_scope_index).toBe(3);
    for (const [key, value] of before) {
      if (classifyLifecycleDeletionKey(setup.target, key) === "payload") expect(setup.entries.has(key)).toBe(false);
      else if (key !== setup.progressKey) expect(setup.entries.get(key)).toEqual(value);
    }
    expect(setup.deleted.every((keys) => keys.length <= 2)).toBe(true);
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBe(setup.execution.executionId);
    expect(await readPublicVisibility(setup.env, "daily", "first")).toBe("gone");
    expect(setup.readBodies.some((key) => key.endsWith(".mp3"))).toBe(false);
    expect(setup.entries.get(setup.progressKey)!.data).not.toContain("Private title");
  });

  test("Show batches delete its snapshot and children but retain service settings, tombstones and publication markers", async () => {
    const setup = await fixture("show");
    const result = await finishBatches(setup);
    expect(result.progress.deletion_scope_index).toBe(5);
    for (const key of setup.payload) expect(setup.entries.has(key)).toBe(false);
    for (const key of [setup.episodeMarker, setup.showMarker, "system/service.toml", "system/show-reservations/daily.json",
      "system/show-publications/daily.json", "system/episode-lifecycle/daily/first.toml"]) expect(setup.entries.has(key)).toBe(true);
    expect((await readShowControl(setup.env, "daily"))?.value.lifecycle).toBe("deleting");
    expect(setup.entries.has("public/podcasts/daily-two/feed.xml")).toBe(true);
  });

  test("missing purge proof, stale generation, wrong request and unsafe delivery gate reject all deletes", async () => {
    for (const fault of ["purge", "hash", "generation", "position", "phase", "missing", "delivery", "token", "target"] as const) {
      const setup = await fixture();
      const mutations = { purge: { purge_confirmed: false }, hash: { request_sha256: "c".repeat(64) },
        generation: { show_generation: 2 }, position: { deletion_scope_index: 5 }, phase: { phase: "purge" } } as const;
      if (fault in mutations) await setup.bucket.put(setup.progressKey, stringifyLifecycleProgress({ ...setup.progress,
        ...mutations[fault as keyof typeof mutations] }));
      if (fault === "missing") setup.entries.delete(setup.progressKey);
      if (fault === "target") await setup.bucket.put("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({
        schema_version: 1, show_id: "daily", episode_id: "first", lifecycle: "active", generation: 1, last_job_id: setup.jobId,
      }));
      await expect(stepLifecyclePayloadDeletion(setup.env,
        fault === "token" ? { ...setup.execution, executionId: crypto.randomUUID() } : setup.execution,
        fault === "delivery" ? async () => { throw new Error("Gateway is not ready"); } : setup.checkDelivery)).rejects.toThrow();
      expect(setup.deleted).toEqual([]);
      expect(setup.entries.has(setup.payload[3])).toBe(true);
    }
  });

  test("unknown payload and malformed/private marker contents block deletion without rewriting the marker", async () => {
    for (const fault of ["unknown", "private-marker", "wrong-marker", "oversized-marker"] as const) {
      const setup = await fixture();
      await setup.bucket.put(setup.progressKey, stringifyLifecycleProgress({ ...setup.progress, deletion_scope_index: 2 }));
      if (fault === "unknown") await setup.bucket.put(`staging/episodes/daily/first/${setup.publicationJobId}/unknown.txt`, "keep for review");
      if (fault === "private-marker") await setup.bucket.put(setup.episodeMarker, JSON.stringify({ ...setup.episodeCommit, token: "secret", title: "private" }));
      if (fault === "wrong-marker") await setup.bucket.put(setup.episodeMarker, JSON.stringify({ ...setup.episodeCommit, episode_id: "other" }));
      if (fault === "oversized-marker") await setup.bucket.put(setup.episodeMarker, "x".repeat(16385));
      const marker = setup.entries.get(setup.episodeMarker);
      await expect(stepLifecyclePayloadDeletion(setup.env, setup.execution, setup.checkDelivery)).rejects.toThrow();
      expect(setup.deleted).toEqual([]);
      expect(setup.entries.get(setup.episodeMarker)).toEqual(marker);
    }
  });

  test("payload ETag changes after listing and lost ownership prevent a delete", async () => {
    for (const fault of ["etag", "owner"] as const) {
      const setup = await fixture();
      const env = { CASTLOOP_BUCKET: { ...setup.bucket, async head(key: string) {
        if (key === setup.payload[3]) {
          if (fault === "etag") await setup.bucket.put(key, "changed");
          else {
            const current = (await readShowControl(setup.env, "daily"))!.value;
            await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ ...current,
              owner: { ...current.owner, execution_id: crypto.randomUUID() } }));
          }
        }
        return setup.bucket.head(key);
      } } } as never;
      await expect(stepLifecyclePayloadDeletion(env, setup.execution, setup.checkDelivery)).rejects.toThrow();
      expect(setup.deleted).toEqual([]);
    }
  });

  test("delete/progress response loss keeps the owner and converges without relying on removal counters", async () => {
    for (const fault of ["delete", "progress", "partial-delete"] as const) {
      const setup = await fixture();
      let lose = true;
      const env = { CASTLOOP_BUCKET: { ...setup.bucket,
        async delete(keys: string | string[]) {
          if (fault === "partial-delete" && lose) {
            lose = false;
            await setup.bucket.delete(typeof keys === "string" ? keys : keys.slice(0, 1));
            throw new Error("Delete partially completed");
          }
          await setup.bucket.delete(keys);
          if (fault === "delete" && lose) { lose = false; throw new Error("Delete response lost"); }
        },
        async put(...args: Parameters<typeof setup.bucket.put>) {
          const written = await setup.bucket.put(...args);
          if (fault === "progress" && lose && args[0] === setup.progressKey) { lose = false; throw new Error("Progress response lost"); }
          return written;
        },
      } } as never;
      await expect(stepLifecyclePayloadDeletion(env, setup.execution, setup.checkDelivery)).rejects.toThrow();
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBe(setup.execution.executionId);
      const result = await finishBatches(setup, env);
      expect(result.readyForFinalization).toBe(true);
      expect(setup.entries.has(setup.episodeMarker)).toBe(true);
      for (const key of setup.payload) if (classifyLifecycleDeletionKey(setup.target, key) === "payload") expect(setup.entries.has(key)).toBe(false);
    }
  });

  test("the verification pass restarts from the first prefix and discovers payload omitted before cursor completion", async () => {
    const setup = await fixture();
    let added = false;
    const lateKey = `public/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`;
    for (let step = 0; step < 150; step += 1) {
      const result = await stepLifecyclePayloadDeletion(setup.env, setup.execution, setup.checkDelivery, { maximumObjects: 2 });
      if (!added && result.progress.phase === "verifying" && result.progress.deletion_scope_index === 0) {
        await setup.bucket.put(lateKey, "missed payload");
        added = true;
      }
      if (result.readyForFinalization) break;
    }
    expect(added).toBe(true);
    expect(setup.entries.has(lateKey)).toBe(false);
    expect(parseLifecycleProgress(setup.entries.get(setup.progressKey)!.data).phase).toBe("finalizing");
  });

  test("pages containing only retained markers advance their cursor and do not delete audit records", async () => {
    const setup = await fixture();
    for (const key of setup.payload) if (classifyLifecycleDeletionKey(setup.target, key) === "payload") setup.entries.delete(key);
    for (let index = 0; index < 5; index += 1) {
      const jobId = crypto.randomUUID();
      await setup.bucket.put(`staging/episodes/daily/first/${jobId}/commit.json`, JSON.stringify({ ...setup.episodeCommit, job_id: jobId }));
    }
    const result = await finishBatches(setup);
    expect(result.readyForFinalization).toBe(true);
    expect(setup.deleted).toEqual([]);
    expect([...setup.entries.keys()].filter((key) => key.startsWith("staging/episodes/daily/first/") && key.endsWith("/commit.json"))).toHaveLength(6);
  });

  test("invalid batch sizes, premature finalization and exhausted counters fail before deleting", async () => {
    const setup = await fixture();
    for (const maximumObjects of [0, 101, 0.5]) {
      await expect(stepLifecyclePayloadDeletion(setup.env, setup.execution, setup.checkDelivery, { maximumObjects })).rejects.toThrow("batch limit");
    }
    for (const changes of [{ phase: "finalizing" as const, deletion_scope_index: 0 }, { deleted_objects: Number.MAX_SAFE_INTEGER }]) {
      await setup.bucket.put(setup.progressKey, stringifyLifecycleProgress({ ...setup.progress, ...changes }));
      await expect(stepLifecyclePayloadDeletion(setup.env, setup.execution, setup.checkDelivery)).rejects.toThrow();
    }
    expect(setup.deleted).toEqual([]);
  });

  test("a progress CAS conflict after deletion retains the owner and supports recovery from remote state", async () => {
    const setup = await fixture();
    let conflict = true;
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async put(...args: Parameters<typeof setup.bucket.put>) {
      if (conflict && args[0] === setup.progressKey) { conflict = false; return null; }
      return setup.bucket.put(...args);
    } } } as never;
    await expect(stepLifecyclePayloadDeletion(env, setup.execution, setup.checkDelivery)).rejects.toThrow("progress changed");
    expect((await readShowControl(setup.env, "daily"))?.value.owner?.job_id).toBe(setup.jobId);
    expect((await finishBatches(setup, env)).readyForFinalization).toBe(true);
    expect(setup.entries.has(setup.episodeMarker)).toBe(true);
  });
});
