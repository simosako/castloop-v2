import { describe, expect, test } from "bun:test";
import { episodeLifecycleSchema, episodeRevisionSchema, parseShowMetadata, stringifyLifecycleToml, stringifyToml } from "../packages/shared/src/index";
import type { ControlAction, EpisodeRevision, LifecycleState } from "../packages/shared/src/index";
import { acquireShowExecution, claimShowOperation, readShowControl } from "./lifecycle-control";
import { readLifecycleFeedInputs } from "./lifecycle-feed";
import { renderFeed } from "./feed";

function revision(episodeId: string): EpisodeRevision {
  const revisionId = crypto.randomUUID();
  return episodeRevisionSchema.parse({ schema_version: 1, episode_id: episodeId, guid: crypto.randomUUID(),
    title: episodeId, description: `${episodeId} description`, published_at: "2026-10-01T12:00:00Z",
    revision_id: revisionId, enclosure_url: `https://old.example/podcasts/daily/episodes/${episodeId}/${revisionId}.mp3`,
    content_type: "audio/mpeg", length_bytes: 300_000_000, duration_seconds: 42, sha256: "a".repeat(64),
    updated_at: "2026-10-01T12:00:00Z" });
}

async function fixture(options: { showState?: LifecycleState; action?: ControlAction; episodeId?: string;
  states?: Record<string, LifecycleState> } = {}) {
  const entries = new Map<string, { data: string; etag: string; size: number }>();
  const reads: string[] = [];
  let version = 0;
  const bucket = {
    async get(key: string) {
      reads.push(key);
      if (key.endsWith(".mp3")) throw new Error("Audio body must not be read");
      const value = entries.get(key);
      return value ? { ...value, key, text: async () => value.data, json: async () => JSON.parse(value.data) } : null;
    },
    async head(key: string) {
      reads.push(`head:${key}`);
      const value = entries.get(key);
      return value ? { key, size: value.size, etag: value.etag } : null;
    },
    async put(key: string, data: string, conditional?: { onlyIf?: Headers | { etagMatches: string } }) {
      const previous = entries.get(key);
      if (conditional?.onlyIf instanceof Headers && previous) return null;
      if (conditional?.onlyIf && !(conditional.onlyIf instanceof Headers) && conditional.onlyIf.etagMatches !== previous?.etag) return null;
      const etag = String(++version);
      entries.set(key, { data, etag, size: new TextEncoder().encode(data).length });
      return { etag, key };
    },
    async list(options: { prefix: string; cursor?: string }) {
      reads.push(`list:${options.prefix}`);
      const matching = [...entries].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => ({ key, ...value }));
      const offset = Number(options.cursor ?? 0);
      return { objects: matching.slice(offset, offset + 2), truncated: offset + 2 < matching.length, cursor: String(offset + 2) };
    },
  };
  const revisions = new Map<string, EpisodeRevision>();
  const states = options.states ?? { first: "active", stopped: "unpublished", removed: "deleted", draft: "draft" };
  await bucket.put("system/show-publications/daily.json", JSON.stringify({ schema_version: 2, show_id: "daily",
    lifecycle: options.showState ?? "active", generation: 0, feed_generation: 0 }));
  for (const [episodeId, state] of Object.entries(states)) {
    await bucket.put(`system/episode-lifecycle/daily/${episodeId}.toml`, stringifyLifecycleToml(episodeLifecycleSchema.parse({
      schema_version: 1, show_id: "daily", episode_id: episodeId, lifecycle: state, generation: 0,
    })));
    const item = revision(episodeId);
    revisions.set(episodeId, item);
    if (state === "deleted" || state === "draft") continue;
    await bucket.put(`public/episodes/daily/${episodeId}/metadata.toml`, stringifyToml(item));
    const audioKey = `public${new URL(item.enclosure_url).pathname}`;
    entries.set(audioKey, { data: "not buffered", size: item.length_bytes, etag: "audio-etag" });
  }
  const env = { CASTLOOP_BUCKET: bucket } as never;
  const input = { schema_version: 1, job_id: crypto.randomUUID(), show_id: "daily", kind: options.episodeId ? "episode" : "show",
    action: options.action ?? "publish", expected_show_generation: 0, created_at: "2026-10-01T12:00:00Z",
    ...(options.episodeId ? { episode_id: options.episodeId, expected_episode_generation: 0 } : {}) };
  await claimShowOperation(env, input);
  const execution = await acquireShowExecution(env, "daily", input.job_id, 1);
  reads.length = 0;
  return { env, bucket, entries, reads, execution, revisions };
}

describe("M6 lifecycle-aware feed inputs", () => {
  test("normal Show publication includes only active Episodes and never buffers 300MB media", async () => {
    const { env, execution, reads } = await fixture();
    const result = await readLifecycleFeedInputs(env, execution);
    expect(result.writeFeed).toBe(true);
    expect(result.episodes.map((episode) => episode.episode_id)).toEqual(["first"]);
    expect(reads.some((key) => key === "public/episodes/daily/stopped/metadata.toml")).toBe(false);
    expect(reads.filter((key) => key.startsWith("head:public/podcasts/")).length).toBe(1);
    expect(reads.some((key) => key.endsWith(".mp3") && !key.startsWith("head:"))).toBe(false);
  });

  test("Episode unpublish/delete exclude the last Episode before writing its state", async () => {
    for (const action of ["unpublish", "delete"] as const) {
      const { env, execution } = await fixture({ episodeId: "first", action, states: { first: "active" } });
      const result = await readLifecycleFeedInputs(env, execution);
      expect(result).toEqual({ writeFeed: true, episodes: [] });
      const show = parseShowMetadata("schema_version = 1\nshow_id = 'daily'\ntitle = 'Daily'\ndescription = 'Daily'\nlanguage = 'en'\nauthor = 'Author'\nowner_name = 'Owner'\nowner_email = 'owner@example.com'\ncategories = ['Arts']\nexplicit = false\nsite_url = 'https://example.com'\nimage_path = 'cover.jpg'\n");
      const feed = renderFeed(show, result.episodes, "https://public.example", "jpg");
      expect(feed).toContain("<channel>");
      expect(feed).not.toContain("<item>");
    }
  });

  test("Show restore preserves stopped/deleted/draft child state; Episode restore adds only its target", async () => {
    const show = await fixture({ showState: "unpublished", action: "restore" });
    expect((await readLifecycleFeedInputs(show.env, show.execution)).episodes.map((item) => item.episode_id)).toEqual(["first"]);
    const episode = await fixture({ episodeId: "stopped", action: "restore" });
    expect((await readLifecycleFeedInputs(episode.env, episode.execution)).episodes.map((item) => item.episode_id)).toEqual(["first", "stopped"]);
    expect(episode.entries.get("system/episode-lifecycle/daily/stopped.toml")?.data).toContain('lifecycle = "unpublished"');
  });

  test("stopped parents and whole-Show unpublish/delete do not write a feed", async () => {
    for (const action of ["unpublish", "delete"] as const) {
      for (const showState of ["active", "unpublished"] as const) {
        const setup = await fixture({ ...(showState === "unpublished" ? { episodeId: "first" } : {}), showState, action });
        expect(await readLifecycleFeedInputs(setup.env, setup.execution)).toEqual({ writeFeed: false, episodes: [] });
        expect(setup.reads.some((key) => key.startsWith("list:"))).toBe(false);
      }
    }
  });

  test("metadata-only publication candidates retain immutable old audio references", async () => {
    const setup = await fixture({ episodeId: "first", action: "publish", states: { first: "active", stopped: "unpublished" } });
    const original = setup.revisions.get("first")!;
    const candidate = { ...original, revision_id: crypto.randomUUID(), title: "Updated title" };
    const result = await readLifecycleFeedInputs(setup.env, setup.execution, { candidate });
    expect(result.episodes).toEqual([candidate]);
    await expect(readLifecycleFeedInputs(setup.env, setup.execution)).rejects.toThrow("validated feed candidate");
    await expect(readLifecycleFeedInputs(setup.env, setup.execution, { candidate: { ...candidate, episode_id: "other" } })).rejects.toThrow("publication owner");
  });

  test("known active metadata/lifecycle/audio gaps and malformed references fail closed", async () => {
    for (const fault of ["metadata", "lifecycle", "audio", "size", "reference", "target"] as const) {
      const setup = await fixture();
      const original = setup.revisions.get("first")!;
      const key = "public/episodes/daily/first/metadata.toml";
      const audioKey = `public${new URL(original.enclosure_url).pathname}`;
      if (fault === "metadata") setup.entries.delete(key);
      if (fault === "lifecycle") setup.entries.delete("system/episode-lifecycle/daily/first.toml");
      if (fault === "audio") setup.entries.delete(audioKey);
      if (fault === "size") setup.entries.get(audioKey)!.size -= 1;
      if (fault === "reference") await setup.bucket.put(key, stringifyToml({ ...original, enclosure_url: "https://old.example/system/private.mp3" }));
      if (fault === "target") await setup.bucket.put(key, stringifyToml({ ...original, episode_id: "wrong" }));
      await expect(readLifecycleFeedInputs(setup.env, setup.execution)).rejects.toThrow();
      expect((await readShowControl(setup.env, "daily"))?.value.owner?.execution_id).toBe(setup.execution.executionId);
    }
  });

  test("bounded inventory and restored target validation reject incomplete feeds", async () => {
    const setup = await fixture({ action: "restore", episodeId: "stopped" });
    setup.entries.delete("public/episodes/daily/stopped/metadata.toml");
    await expect(readLifecycleFeedInputs(setup.env, setup.execution)).rejects.toThrow("no current metadata");
    const full = await fixture();
    await expect(readLifecycleFeedInputs(full.env, full.execution, { maximumObjects: 1 })).rejects.toThrow("object limit");
    await expect(readLifecycleFeedInputs(full.env, full.execution, { maximumMetadataBytes: 1 })).rejects.toThrow("metadata budget");
    await expect(readLifecycleFeedInputs(full.env, full.execution, { maximumObjects: 0 })).rejects.toThrow("Invalid");
  });

  test("lost execution ownership during audio validation prevents use of the feed snapshot", async () => {
    const setup = await fixture();
    const env = { CASTLOOP_BUCKET: { ...setup.bucket, async head(key: string) {
      const result = await setup.bucket.head(key);
      if (key.endsWith(".mp3")) {
        const control = (await readShowControl(setup.env, "daily"))!.value;
        await setup.bucket.put("system/show-publications/daily.json", JSON.stringify({ ...control,
          owner: { ...control.owner, execution_id: crypto.randomUUID() } }));
      }
      return result;
    } } } as never;
    await expect(readLifecycleFeedInputs(env, setup.execution)).rejects.toThrow("execution token");
  });
});
