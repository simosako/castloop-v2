import { describe, expect, test } from "bun:test";
import { stringifyLifecycleToml, stringifyToml } from "../packages/shared/src/index";
import type { EpisodeRevision, ServiceConfig, ShowMetadata } from "../packages/shared/src/index";
import { planLifecycleMigration } from "./lifecycle-migration";

const service: ServiceConfig = { schema_version: 1, service_id: "probe", account_id: "a".repeat(32),
  bucket_name: "probe-bucket", worker_name: "probe-worker", queue_name: "probe-queue", dlq_name: "probe-dlq",
  public_base_url: "https://probe.example.workers.dev" };
const show: ShowMetadata = { schema_version: 1, show_id: "daily", title: "Daily", description: "Podcast",
  language: "ja", author: "Author", owner_name: "Owner", owner_email: "owner@example.com", categories: ["Technology"],
  explicit: false, site_url: "https://example.com", image_path: "cover.png" };

function fixture(pageSize = 1000) {
  const revision: EpisodeRevision = { schema_version: 1, episode_id: "first", guid: crypto.randomUUID(),
    revision_id: crypto.randomUUID(), title: "First", description: "Episode", published_at: "2026-09-30T12:00:00Z",
    enclosure_url: `${service.public_base_url}/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`,
    content_type: "audio/mpeg", length_bytes: 5, duration_seconds: 1, sha256: "a".repeat(64),
    updated_at: "2026-09-30T12:00:00Z" };
  const completedJobId = crypto.randomUUID();
  const entries = new Map<string, string>([
    ["system/service.toml", stringifyToml(service)],
    ["system/show-reservations/daily.json", JSON.stringify({ show_id: "daily", reservation_id: crypto.randomUUID() })],
    ["system/show-publications/daily.json", JSON.stringify({ job_id: completedJobId, state: "free" })],
    [`system/jobs/${completedJobId}/status.toml`, stringifyToml({ schema_version: 1, job_id: completedJobId,
      show_id: "daily", kind: "show", state: "published" })],
    ["system/shows/daily/show.toml", stringifyToml(show)],
    ["public/podcasts/daily/feed.xml", "feed"], ["public/podcasts/daily/cover.png", "cover"],
    [`public${new URL(revision.enclosure_url).pathname}`, "audio"],
    ["public/episodes/daily/first/metadata.toml", stringifyToml(revision)],
    [`public/episodes/daily/first/revisions/${revision.revision_id}.toml`, stringifyToml(revision)],
  ]);
  let lists = 0;
  const bucket = {
    async list(options?: { cursor?: string; limit?: number }) {
      lists += 1;
      const keys = [...entries.keys()].sort();
      const offset = Number(options?.cursor ?? 0);
      const length = Math.min(pageSize, options?.limit ?? 1000);
      const end = offset + length;
      const truncated = end < keys.length;
      return { objects: keys.slice(offset, end).map((key) => ({ key, etag: entries.get(key),
        size: new TextEncoder().encode(entries.get(key)!).length })), truncated,
        ...(truncated ? { cursor: String(end) } : {}), delimitedPrefixes: [] };
    },
    async get(key: string) {
      const data = entries.get(key);
      return data === undefined ? null : { etag: data, size: new TextEncoder().encode(data).length, text: async () => data };
    },
  };
  return { entries, revision, bucket, env: { CASTLOOP_BUCKET: bucket } as never, lists: () => lists };
}

describe("read-only M6 migration inventory", () => {
  test("retains new registration identity and blocks a control/reservation identity mismatch", async () => {
    const { env, entries } = fixture();
    const reservationId = JSON.parse(entries.get("system/show-reservations/daily.json")!).reservation_id as string;
    const control = { schema_version: 2 as const, show_id: "daily", reservation_id: reservationId,
      lifecycle: "unpublished" as const, generation: 12, feed_generation: 9 };
    entries.set("system/show-publications/daily.json", JSON.stringify(control));
    entries.set("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({ schema_version: 1,
      show_id: "daily", episode_id: "first", lifecycle: "unpublished", generation: 4 }));
    const valid = await planLifecycleMigration(env);
    expect(valid.inventory_compatible).toBe(true);
    expect(valid.shows[0]!.value).toEqual(control);
    entries.set("system/show-publications/daily.json", JSON.stringify({ ...control, reservation_id: crypto.randomUUID() }));
    const invalid = await planLifecycleMigration(env);
    expect(invalid.inventory_compatible).toBe(false);
    expect(invalid.blockers.some((blocker) => blocker.code === "target_mismatch" && blocker.key === "system/show-publications/daily.json")).toBe(true);
  });

  test("legacy published snapshots become active; local/remote drafts do not become published", async () => {
    const { env, entries } = fixture(2);
    entries.set("system/show-reservations/draft-show.json", JSON.stringify({ show_id: "draft-show", reservation_id: crypto.randomUUID() }));
    entries.set(`staging/episodes/daily/unfinished/${crypto.randomUUID()}/audio.mp3`, "draft audio");
    const before = [...entries];
    const result = await planLifecycleMigration(env);
    expect(result.inventory_compatible).toBe(true);
    expect(result.requires_quiescence).toBe(true);
    expect(result.shows.map((plan) => [plan.show_id, plan.value.lifecycle])).toEqual([["daily", "active"], ["draft-show", "draft"]]);
    expect(result.shows[0].episodes.map((episode) => [episode.episode_id, episode.value.lifecycle]))
      .toEqual([["first", "active"], ["unfinished", "draft"]]);
    expect([...entries]).toEqual(before);
  });

  test("pagination uses truncated/cursor even when each page is shorter than the requested limit", async () => {
    const { env, entries, lists } = fixture(1);
    const result = await planLifecycleMigration(env);
    expect(lists()).toBe(entries.size);
    expect(result.sources).toHaveLength(entries.size);
    expect(result.inventory_compatible).toBe(true);
  });

  test("inventories spanning more than 1000 objects retain every source", async () => {
    const { env, entries, lists } = fixture();
    for (let index = 0; index < 1005; index += 1) entries.set(`probe/retained-${index}`, "retained");
    const result = await planLifecycleMigration(env);
    expect(result.inventory_compatible).toBe(true);
    expect(result.sources).toHaveLength(entries.size);
    expect(lists()).toBe(2);
  });

  test("reserved and processing legacy owners block initialization", async () => {
    for (const state of ["reserved", "processing"] as const) {
      const { env, entries } = fixture();
      entries.set("system/show-publications/daily.json", JSON.stringify({ job_id: crypto.randomUUID(), state }));
      const result = await planLifecycleMigration(env);
      expect(result.inventory_compatible).toBe(false);
      expect(result.blockers.some((issue) => issue.code === "unfinished_owner")).toBe(true);
    }
  });

  test("existing v2 stopped state and generation are preserved rather than inferred active", async () => {
    const { env, entries } = fixture();
    entries.set("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
      lifecycle: "unpublished", generation: 12, feed_generation: 9 }));
    entries.set("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({ schema_version: 1,
      show_id: "daily", episode_id: "first", lifecycle: "unpublished", generation: 4 }));
    const result = await planLifecycleMigration(env);
    expect(result.inventory_compatible).toBe(true);
    expect(result.shows[0].mode).toBe("preserve");
    expect(result.shows[0].value.lifecycle).toBe("unpublished");
    expect(result.shows[0].value.generation).toBe(12);
    expect(result.shows[0].episodes[0].value.generation).toBe(4);
    expect(result.shows[0].episodes[0].mode).toBe("preserve");
  });

  test("partially initialized v2 controls fail closed instead of creating missing active state", async () => {
    const { env, entries } = fixture();
    entries.set("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
      lifecycle: "active", generation: 1, feed_generation: 0 }));
    const result = await planLifecycleMigration(env);
    expect(result.inventory_compatible).toBe(false);
    expect(result.blockers.some((issue) => issue.code === "partial_lifecycle_state")).toBe(true);
  });

  test("missing media/history/feed/cover/reservation/service and malformed controls all block migration", async () => {
    for (const kind of ["audio", "history", "feed", "cover", "reservation", "service", "control"] as const) {
      const { env, entries, revision } = fixture();
      const keys = { audio: `public${new URL(revision.enclosure_url).pathname}`,
        history: `public/episodes/daily/first/revisions/${revision.revision_id}.toml`, feed: "public/podcasts/daily/feed.xml",
        cover: "public/podcasts/daily/cover.png", reservation: "system/show-reservations/daily.json",
        service: "system/service.toml", control: "system/show-publications/daily.json" };
      if (kind === "control") entries.set(keys[kind], "{}");
      else entries.delete(keys[kind]);
      expect((await planLifecycleMigration(env)).inventory_compatible).toBe(false);
    }
  });

  test("committed legacy drafts must have matching terminal job status", async () => {
    const { env, entries } = fixture();
    const jobId = crypto.randomUUID();
    const commitKey = `staging/shows/daily/${jobId}/commit.json`;
    entries.set(commitKey, JSON.stringify({ schema_version: 1, kind: "show", show_id: "daily", job_id: jobId,
      metadata_sha256: "a".repeat(64), cover_sha256: "b".repeat(64), cover_extension: "png" }));
    expect((await planLifecycleMigration(env)).blockers.some((issue) => issue.code === "unfinished_commit")).toBe(true);
    entries.set(`system/jobs/${jobId}/status.toml`, stringifyToml({ schema_version: 1, job_id: jobId,
      show_id: "daily", kind: "show", state: "published" }));
    expect((await planLifecycleMigration(env)).inventory_compatible).toBe(true);
    entries.set(`system/jobs/${jobId}/status.toml`, stringifyToml({ schema_version: 1, job_id: crypto.randomUUID(),
      show_id: "daily", kind: "show", state: "published" }));
    expect((await planLifecycleMigration(env)).blockers.some((issue) => issue.code === "target_mismatch")).toBe(true);
  });

  test("missing published admission and missing free-owner history do not lose old job ID protection", async () => {
    const { env, entries } = fixture();
    const controlKey = "system/show-publications/daily.json";
    const previous = entries.get(controlKey)!;
    entries.delete(controlKey);
    expect((await planLifecycleMigration(env)).blockers.some((issue) => issue.code === "missing_publication_record")).toBe(true);
    entries.set(controlKey, previous);
    const job = JSON.parse(previous) as { job_id: string };
    entries.delete(`system/jobs/${job.job_id}/status.toml`);
    expect((await planLifecycleMigration(env)).blockers.some((issue) => issue.code === "invalid_completed_owner")).toBe(true);
  });

  test("metadata, reservation, control and revision IDs must match their object keys", async () => {
    for (const kind of ["metadata", "reservation", "control", "history"] as const) {
      const { env, entries, revision } = fixture();
      if (kind === "metadata") entries.set("system/shows/daily/show.toml", stringifyToml({ ...show, show_id: "other" }));
      if (kind === "reservation") entries.set("system/show-reservations/daily.json",
        JSON.stringify({ show_id: "other", reservation_id: crypto.randomUUID() }));
      if (kind === "control") entries.set("system/show-publications/daily.json", JSON.stringify({ schema_version: 2,
        show_id: "other", lifecycle: "active", generation: 0, feed_generation: 0 }));
      if (kind === "history") entries.set(`public/episodes/daily/first/revisions/${revision.revision_id}.toml`,
        stringifyToml({ ...revision, guid: crypto.randomUUID() }));
      expect((await planLifecycleMigration(env)).inventory_compatible).toBe(false);
    }
  });

  test("orphan media and malformed target keys are not silently treated as drafts", async () => {
    const { env, entries } = fixture();
    entries.set(`public/podcasts/daily/orphan/not-a-path.mp3`, "audio");
    entries.set(`public/podcasts/daily/episodes/orphan/${crypto.randomUUID()}.mp3`, "audio");
    entries.set("system/episode-lifecycle/daily/.toml", "invalid");
    const result = await planLifecycleMigration(env);
    expect(result.inventory_compatible).toBe(false);
    expect(result.blockers.some((issue) => issue.code === "invalid_target_key")).toBe(true);
    expect(result.blockers.some((issue) => issue.code === "orphan_episode")).toBe(true);
  });

  test("deleted/deleting controls with leftover payload and active controls with missing metadata are blocked", async () => {
    for (const state of ["deleted", "deleting", "active"] as const) {
      const { env, entries } = fixture();
      entries.set("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
        lifecycle: state, generation: 3, feed_generation: 2 }));
      entries.set("system/episode-lifecycle/daily/first.toml", stringifyLifecycleToml({ schema_version: 1,
        show_id: "daily", episode_id: "first", lifecycle: state, generation: 1 }));
      if (state === "active") entries.delete("public/episodes/daily/first/metadata.toml");
      const result = await planLifecycleMigration(env);
      const expected = state === "deleted" ? "deleted_payload" : state === "deleting" ? "unfinished_lifecycle" : "missing_active_metadata";
      expect(result.blockers.some((issue) => issue.code === expected)).toBe(true);
      expect(result.inventory_compatible).toBe(false);
    }
  });

  test("lifecycle markers and oversized stored metadata require inspection, never silent initialization", async () => {
    const { env, entries } = fixture();
    entries.set("staging/lifecycle/shows/daily/pending/commit.json", "{}");
    entries.set("system/shows/daily/show.toml", "x".repeat(1000001));
    const result = await planLifecycleMigration(env);
    expect(result.inventory_compatible).toBe(false);
    expect(result.blockers.some((issue) => issue.code === "unsupported_lifecycle_stage")).toBe(true);
    expect(result.blockers.some((issue) => issue.code === "record_too_large")).toBe(true);
  });

  test("changed source ETags and R2 failures abort the inventory rather than produce a compatible plan", async () => {
    const { bucket } = fixture();
    const changed = { CASTLOOP_BUCKET: { ...bucket, async get(key: string) {
      const object = await bucket.get(key);
      return object ? { ...object, etag: "changed" } : null;
    } } } as never;
    await expect(planLifecycleMigration(changed)).rejects.toThrow("source changed");
    const failed = { CASTLOOP_BUCKET: { ...bucket, async get() { throw new Error("R2 unavailable"); } } } as never;
    await expect(planLifecycleMigration(failed)).rejects.toThrow("R2 unavailable");
  });

  test("inventory size limits and repeated/missing pagination cursors fail explicitly", async () => {
    const { env, bucket } = fixture();
    await expect(planLifecycleMigration(env, { maximumObjects: 2 })).rejects.toThrow("object limit");
    await expect(planLifecycleMigration(env, { maximumObjects: 0 })).rejects.toThrow("Invalid migration object limit");
    for (const cursor of [undefined, "same"]) {
      const broken = { CASTLOOP_BUCKET: { ...bucket, async list() {
        return { objects: [], truncated: true, cursor };
      } } } as never;
      await expect(planLifecycleMigration(broken)).rejects.toThrow("pagination cursor");
    }
  });
});
