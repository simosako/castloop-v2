import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseJobStatus, stringifyToml } from "../packages/shared/src/index";
import { publishEpisode, publishShow } from "./publication";

function memoryBucket() {
  const entries = new Map<string, { data: Uint8Array; etag: string; customMetadata?: Record<string, string> }>();
  let revision = 0;
  return {
    entries,
    async put(key: string, value: string | ArrayBuffer | ReadableStream,
      options?: { onlyIf?: Headers | { etagMatches: string }; customMetadata?: Record<string, string> }) {
      const previous = entries.get(key);
      if (options?.onlyIf instanceof Headers && previous) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) &&
        options.onlyIf.etagMatches !== previous?.etag) return null;
      const data = typeof value === "string" ? new TextEncoder().encode(value)
        : value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer())
          : new Uint8Array(value);
      entries.set(key, { data, etag: String(++revision), customMetadata: options?.customMetadata });
      return { key, size: data.byteLength };
    },
    async get(key: string) {
      const stored = entries.get(key);
      if (!stored) return null;
      const data = stored.data;
      return {
        etag: stored.etag, size: data.byteLength, customMetadata: stored.customMetadata,
        body: new Blob([data]).stream(),
        text: async () => new TextDecoder().decode(data),
        json: async () => JSON.parse(new TextDecoder().decode(data)),
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      };
    },
    async head(key: string) {
      const stored = entries.get(key);
      return stored ? { size: stored.data.byteLength, customMetadata: stored.customMetadata } : null;
    },
    async list(options: { prefix: string }) {
      return { objects: [...entries.keys()].filter((key) => key.startsWith(options.prefix)).map((key) => ({ key })) };
    },
  };
}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("Show publication recovery", () => {
  test("retains ownership on purge failure and releases only after successful retry", async () => {
    const bucket = memoryBucket();
    const showId = "daily";
    const jobId = crypto.randomUUID();
    const prefix = `staging/shows/${showId}/${jobId}`;
    const show = stringifyToml({ schema_version: 1, show_id: showId, title: "News & More",
      description: "Details", language: "ja", author: "Author", owner_name: "Owner",
      owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
      site_url: "https://example.org/show", image_path: "cover.jpg" });
    const service = stringifyToml({ schema_version: 1, service_id: "castloop", account_id: "a".repeat(32),
      bucket_name: "castloop-test-bucket", worker_name: "castloop-test-worker",
      queue_name: "castloop-test-queue", dlq_name: "castloop-test-dlq",
      public_base_url: "https://example.workers.dev" });
    const cover = Uint8Array.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
    await bucket.put("system/service.toml", service);
    await bucket.put(`system/show-publications/${showId}.json`, JSON.stringify({ job_id: jobId, state: "reserved" }));
    await bucket.put(`${prefix}/show.toml`, show);
    await bucket.put(`${prefix}/cover.jpg`, cover.buffer as ArrayBuffer);
    await bucket.put(`${prefix}/commit.json`, JSON.stringify({ schema_version: 1, kind: "show",
      show_id: showId, job_id: jobId, metadata_sha256: digest(show), cover_sha256: digest(cover),
      cover_extension: "jpg" }));
    const tags: string[][] = [];
    const ctx = { cache: { purge: async (options: { tags: string[] }) => {
      tags.push(options.tags);
      return { success: tags.length > 1 };
    } } } as ExecutionContext;
    const env = { CASTLOOP_BUCKET: bucket } as never;
    await expect(publishShow(env, ctx, `${prefix}/commit.json`)).rejects.toThrow("purge failed");
    const processingOwner = await bucket.get(`system/show-publications/${showId}.json`);
    expect(JSON.parse(await processingOwner!.text()).state).toBe("processing");
    const firstStatus = await bucket.get(`system/jobs/${jobId}/status.toml`);
    expect(parseJobStatus(await firstStatus!.text()).state).toBe("retrying");
    await publishShow(env, ctx, `${prefix}/commit.json`);
    const finalOwner = await bucket.get(`system/show-publications/${showId}.json`);
    expect(JSON.parse(await finalOwner!.text()).state).toBe("free");
    const finalStatus = await bucket.get(`system/jobs/${jobId}/status.toml`);
    expect(parseJobStatus(await finalStatus!.text()).state).toBe("published");
    const feed = await bucket.get(`public/podcasts/${showId}/feed.xml`);
    expect(await feed!.text()).toContain("News &amp; More");
    expect(tags).toEqual([[`feed-${showId}`, `cover-${showId}`], [`feed-${showId}`, `cover-${showId}`]]);
    await publishShow(env, ctx, `${prefix}/commit.json`);
    expect(tags).toHaveLength(2);
  });
});

test("Episode publication streams immutable media and retries a failed feed purge", async () => {
  const bucket = memoryBucket();
  const showId = "daily";
  const episodeId = "first";
  const jobId = crypto.randomUUID();
  const prefix = `staging/episodes/${showId}/${episodeId}/${jobId}`;
  const metadata = stringifyToml({ schema_version: 1, episode_id: episodeId, guid: crypto.randomUUID(),
    title: "First <episode>", description: "Description", published_at: "2026-09-24T10:00:00+09:00" });
  const show = stringifyToml({ schema_version: 1, show_id: showId, title: "Daily", description: "Details",
    language: "ja", author: "Author", owner_name: "Owner", owner_email: "owner@example.com",
    categories: ["Technology"], explicit: false, site_url: "https://example.org/show", image_path: "cover.jpg" });
  const service = stringifyToml({ schema_version: 1, service_id: "castloop", account_id: "a".repeat(32),
    bucket_name: "castloop-test-bucket", worker_name: "castloop-test-worker",
    queue_name: "castloop-test-queue", dlq_name: "castloop-test-dlq",
    public_base_url: "https://example.workers.dev" });
  const audio = Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3, 4]);
  await bucket.put("system/service.toml", service);
  await bucket.put(`system/shows/${showId}/show.toml`, show);
  await bucket.put(`system/show-publications/${showId}.json`, JSON.stringify({ job_id: jobId, state: "reserved" }));
  await bucket.put(`${prefix}/episode.toml`, metadata);
  await bucket.put(`${prefix}/audio.mp3`, audio.buffer as ArrayBuffer);
  await bucket.put(`${prefix}/commit.json`, JSON.stringify({ schema_version: 1, kind: "episode",
    show_id: showId, episode_id: episodeId, job_id: jobId, metadata_sha256: digest(metadata),
    audio_sha256: digest(audio), audio_length_bytes: audio.byteLength, duration_seconds: 42,
    committed_at: "2026-09-24T01:05:00Z" }));
  let purges = 0;
  const ctx = { cache: { purge: async () => ({ success: ++purges > 1 }) } } as never;
  const env = { CASTLOOP_BUCKET: bucket } as never;
  await expect(publishEpisode(env, ctx, `${prefix}/commit.json`)).rejects.toThrow("purge failed");
  expect(JSON.parse(await (await bucket.get(`system/show-publications/${showId}.json`))!.text()).state).toBe("processing");
  await publishEpisode(env, ctx, `${prefix}/commit.json`);
  expect(JSON.parse(await (await bucket.get(`system/show-publications/${showId}.json`))!.text()).state).toBe("free");
  const mediaKey = `public/podcasts/${showId}/episodes/${episodeId}/${jobId}.mp3`;
  expect(bucket.entries.get(mediaKey)?.data).toEqual(audio);
  expect(bucket.entries.get(mediaKey)?.customMetadata?.sha256).toBe(digest(audio));
  const current = await bucket.get(`public/episodes/${showId}/${episodeId}/metadata.toml`);
  expect((await current!.text())).toContain(`revision_id = "${jobId}"`);
  const feed = await bucket.get(`public/podcasts/${showId}/feed.xml`);
  expect(await feed!.text()).toContain("First &lt;episode&gt;");
  expect(purges).toBe(2);
});
