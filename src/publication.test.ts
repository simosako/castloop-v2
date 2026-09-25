import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseEpisodeRevision, parseJobStatus, stringifyToml } from "../packages/shared/src/index";
import worker from "./index";
import { publishEpisode, publishShow } from "./publication";

function memoryBucket() {
  const entries = new Map<string, { data: Uint8Array; etag: string; customMetadata?: Record<string, string> }>();
  let revision = 0;
  return {
    entries,
    async put(key: string, value: string | ArrayBuffer | ReadableStream,
      options?: { onlyIf?: Headers | { etagMatches: string }; customMetadata?: Record<string, string>;
        sha256?: string }) {
      const previous = entries.get(key);
      if (options?.onlyIf instanceof Headers && previous) return null;
      if (options?.onlyIf && !(options.onlyIf instanceof Headers) &&
        options.onlyIf.etagMatches !== previous?.etag) return null;
      const data = typeof value === "string" ? new TextEncoder().encode(value)
        : value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer())
          : new Uint8Array(value);
      if (options?.sha256 && createHash("sha256").update(data).digest("hex") !== options.sha256) {
        throw new Error("R2 checksum mismatch");
      }
      entries.set(key, { data, etag: String(++revision), customMetadata: options?.customMetadata });
      return { key, size: data.byteLength,
        checksums: { sha256: options?.sha256 ? Uint8Array.from(Buffer.from(options.sha256, "hex")).buffer : undefined } };
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
    async delete(key: string) { entries.delete(key); },
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

test("multiple Episodes, metadata-only and audio-only revisions preserve GUID and immutable media", async () => {
  const bucket = memoryBucket();
  const showId = "daily";
  const service = stringifyToml({ schema_version: 1, service_id: "castloop", account_id: "a".repeat(32),
    bucket_name: "castloop-test-bucket", worker_name: "castloop-test-worker",
    queue_name: "castloop-test-queue", dlq_name: "castloop-test-dlq",
    public_base_url: "https://example.workers.dev" });
  const show = stringifyToml({ schema_version: 1, show_id: showId, title: "Daily", description: "Details",
    language: "ja", author: "Author", owner_name: "Owner", owner_email: "owner@example.com",
    categories: ["Technology"], explicit: false, site_url: "https://example.org/show", image_path: "cover.jpg" });
  await bucket.put("system/service.toml", service);
  await bucket.put(`system/shows/${showId}/show.toml`, show);
  const env = { CASTLOOP_BUCKET: bucket } as never;
  const ctx = { cache: { purge: async () => ({ success: true }) } } as never;
  const guid = crypto.randomUUID();
  const metadata = (episodeId: string, title: string, episodeGuid: string) =>
    stringifyToml({ schema_version: 1, episode_id: episodeId, guid: episodeGuid, title,
      description: "Description", published_at: "2026-09-24T10:00:00+09:00" });
  const submit = async (episodeId: string, jobId: string, baseRevisionId?: string,
    text?: string, audio?: Uint8Array) => {
    const prefix = `staging/episodes/${showId}/${episodeId}/${jobId}`;
    await bucket.put(`system/show-publications/${showId}.json`, JSON.stringify({ job_id: jobId, state: "reserved" }));
    if (text) await bucket.put(`${prefix}/episode.toml`, text);
    if (audio) await bucket.put(`${prefix}/audio.mp3`, audio.buffer as ArrayBuffer);
    await bucket.put(`${prefix}/commit.json`, JSON.stringify({ schema_version: 1, kind: "episode",
      show_id: showId, episode_id: episodeId, job_id: jobId,
      ...(baseRevisionId ? { base_revision_id: baseRevisionId } : {}),
      ...(text ? { metadata_sha256: digest(text) } : {}),
      ...(audio ? { audio_sha256: digest(audio), audio_length_bytes: audio.length, duration_seconds: 10 } : {}),
      committed_at: "2026-09-24T01:05:00Z" }));
    await publishEpisode(env, ctx, `${prefix}/commit.json`);
    return prefix;
  };
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const audio1 = Uint8Array.from([0x49, 0x44, 0x33, 1]);
  const audio2 = Uint8Array.from([0x49, 0x44, 0x33, 2]);
  await submit("first", first, undefined, metadata("first", "Original", guid), audio1);
  await submit("second", second, undefined, metadata("second", "Other", crypto.randomUUID()), audio2);
  const duplicate = crypto.randomUUID();
  await submit("duplicate", duplicate, undefined, metadata("duplicate", "Duplicate", guid), audio2);
  expect(parseJobStatus(await (await bucket.get(`system/jobs/${duplicate}/status.toml`))!.text()).reason)
    .toContain("GUID is already used");
  expect(bucket.entries.has(`public/episodes/${showId}/duplicate/metadata.toml`)).toBe(false);
  const metadataJob = crypto.randomUUID();
  const metadataPrefix = await submit("first", metadataJob, first, metadata("first", "Revised", guid));
  const metadataRevision = parseEpisodeRevision(await (await bucket.get(
    `public/episodes/${showId}/first/metadata.toml`))!.text());
  expect(metadataRevision.enclosure_url).toEndWith(`/${first}.mp3`);
  expect(metadataRevision.guid).toBe(guid);
  expect(bucket.entries.has(`${metadataPrefix}/audio.mp3`)).toBe(false);
  expect(bucket.entries.has(`public/podcasts/${showId}/episodes/first/${metadataJob}.mp3`)).toBe(false);
  const secondMetadataJob = crypto.randomUUID();
  await submit("first", secondMetadataJob, metadataJob, metadata("first", "Final title", guid));
  expect(parseEpisodeRevision(await (await bucket.get(
    `public/episodes/${showId}/first/metadata.toml`))!.text()).enclosure_url).toEndWith(`/${first}.mp3`);
  const audioJob = crypto.randomUUID();
  const audio3 = Uint8Array.from([0x49, 0x44, 0x33, 3]);
  await submit("first", audioJob, secondMetadataJob, undefined, audio3);
  const current = parseEpisodeRevision(await (await bucket.get(
    `public/episodes/${showId}/first/metadata.toml`))!.text());
  expect(current.title).toBe("Final title");
  expect(current.guid).toBe(guid);
  expect(current.enclosure_url).toEndWith(`/${audioJob}.mp3`);
  expect(bucket.entries.get(`public/podcasts/${showId}/episodes/first/${first}.mp3`)?.data).toEqual(audio1);
  expect(bucket.entries.get(`public/podcasts/${showId}/episodes/first/${audioJob}.mp3`)?.data).toEqual(audio3);
  const feed = await (await bucket.get(`public/podcasts/${showId}/feed.xml`))!.text();
  expect(feed.match(/<item>/g)).toHaveLength(2);
  expect(feed).toContain("Final title");
  expect(feed).toContain("Other");
  await publishEpisode(env, ctx, `${metadataPrefix}/commit.json`);
  expect(parseEpisodeRevision(await (await bucket.get(
    `public/episodes/${showId}/first/metadata.toml`))!.text()).revision_id).toBe(audioJob);
  const cleanup = () => worker.fetch(new Request("https://example.workers.dev/admin/jobs/cleanup", {
    method: "POST", headers: { "X-Castloop-Key": "test-secret" },
    body: JSON.stringify({ show_id: showId, episode_id: "first", job_id: audioJob }),
  }), { CASTLOOP_BUCKET: bucket, CASTLOOP_ADMIN_KEY: "test-secret" } as never);
  await bucket.put(`system/show-publications/${showId}.json`,
    JSON.stringify({ job_id: audioJob, state: "processing" }));
  expect((await cleanup()).status).toBe(409);
  await bucket.put(`system/show-publications/${showId}.json`, JSON.stringify({ job_id: audioJob, state: "free" }));
  expect((await cleanup()).status).toBe(200);
  expect(bucket.entries.has(`staging/episodes/${showId}/first/${audioJob}/audio.mp3`)).toBe(false);
  expect(bucket.entries.get(`public/podcasts/${showId}/episodes/first/${audioJob}.mp3`)?.data).toEqual(audio3);
});

test("stale Episode base and GUID change are rejected before current metadata is replaced", async () => {
  const bucket = memoryBucket();
  const showId = "daily";
  const episodeId = "first";
  const oldId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const guid = crypto.randomUUID();
  const old = stringifyToml({ schema_version: 1, episode_id: episodeId, guid, title: "Original",
    description: "Details", published_at: "2026-09-24T01:00:00Z", revision_id: oldId,
    enclosure_url: `https://example.workers.dev/podcasts/${showId}/episodes/${episodeId}/${oldId}.mp3`,
    content_type: "audio/mpeg", length_bytes: 4, duration_seconds: 10,
    sha256: digest(Uint8Array.from([1, 2, 3, 4])), updated_at: "2026-09-24T01:05:00Z" });
  const revision = `public/episodes/${showId}/${episodeId}`;
  await bucket.put("system/service.toml", stringifyToml({ schema_version: 1, service_id: "castloop",
    account_id: "a".repeat(32), bucket_name: "castloop-test-bucket", worker_name: "castloop-test-worker",
    queue_name: "castloop-test-queue", dlq_name: "castloop-test-dlq",
    public_base_url: "https://example.workers.dev" }));
  await bucket.put(`system/shows/${showId}/show.toml`, stringifyToml({ schema_version: 1,
    show_id: showId, title: "Daily", description: "Details", language: "ja", author: "Author",
    owner_name: "Owner", owner_email: "owner@example.com", categories: ["Technology"],
    explicit: false, site_url: "https://example.org/show", image_path: "cover.jpg" }));
  await bucket.put(`${revision}/metadata.toml`, old);
  await bucket.put(`${revision}/revisions/${oldId}.toml`, old);
  await bucket.put(`system/show-publications/${showId}.json`, JSON.stringify({ job_id: jobId, state: "reserved" }));
  const prefix = `staging/episodes/${showId}/${episodeId}/${jobId}`;
  const changed = stringifyToml({ schema_version: 1, episode_id: episodeId, guid: crypto.randomUUID(),
    title: "Invalid", description: "Details", published_at: "2026-09-24T01:00:00Z" });
  await bucket.put(`${prefix}/episode.toml`, changed);
  await bucket.put(`${prefix}/commit.json`, JSON.stringify({ schema_version: 1, kind: "episode",
    show_id: showId, episode_id: episodeId, job_id: jobId, base_revision_id: oldId,
    metadata_sha256: digest(changed), committed_at: "2026-09-24T02:00:00Z" }));
  await publishEpisode({ CASTLOOP_BUCKET: bucket } as never, {} as never, `${prefix}/commit.json`);
  expect((await (await bucket.get(`${revision}/metadata.toml`))!.text())).toBe(old);
  expect(parseJobStatus(await (await bucket.get(`system/jobs/${jobId}/status.toml`))!.text()).state).toBe("failed");
  expect(JSON.parse(await (await bucket.get(`system/show-publications/${showId}.json`))!.text()).state).toBe("reserved");
  const newerId = crypto.randomUUID();
  const newer = old.replaceAll(oldId, newerId);
  await bucket.put(`${revision}/metadata.toml`, newer);
  const staleJob = crypto.randomUUID();
  await bucket.put(`system/show-publications/${showId}.json`,
    JSON.stringify({ job_id: staleJob, state: "reserved" }));
  const stalePrefix = `staging/episodes/${showId}/${episodeId}/${staleJob}`;
  const validUpdate = stringifyToml({ schema_version: 1, episode_id: episodeId, guid,
    title: "Stale title", description: "Details", published_at: "2026-09-24T01:00:00Z" });
  await bucket.put(`${stalePrefix}/episode.toml`, validUpdate);
  await bucket.put(`${stalePrefix}/commit.json`, JSON.stringify({ schema_version: 1, kind: "episode",
    show_id: showId, episode_id: episodeId, job_id: staleJob, base_revision_id: oldId,
    metadata_sha256: digest(validUpdate), committed_at: "2026-09-24T02:00:00Z" }));
  await publishEpisode({ CASTLOOP_BUCKET: bucket } as never, {} as never, `${stalePrefix}/commit.json`);
  expect(await (await bucket.get(`${revision}/metadata.toml`))!.text()).toBe(newer);
  expect(parseJobStatus(await (await bucket.get(`system/jobs/${staleJob}/status.toml`))!.text()).reason)
    .toContain("changed after this draft");
});
