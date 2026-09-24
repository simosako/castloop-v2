import { episodeCommitSchema, parseEpisodeDraft, parseEpisodeRevision, parseJobStatus,
  parseServiceConfig, parseShowMetadata, showCommitSchema, stringifyToml } from "../packages/shared/src/index";
import type { EpisodeCommit, EpisodeRevision, JobStatus, ShowCommit } from "../packages/shared/src/index";
import { renderFeed } from "./feed";
import { createHash } from "node:crypto";

export type PublicationEnv = { CASTLOOP_BUCKET: R2Bucket };
export type Admission = { job_id: string; state: "reserved" | "processing" | "free" };

class InvalidPublication extends Error {}

export async function readAdmission(env: PublicationEnv, showId: string): Promise<{
  value: Admission; etag: string;
} | null> {
  const object = await env.CASTLOOP_BUCKET.get(`system/show-publications/${showId}.json`);
  if (!object) return null;
  return { value: await object.json<Admission>(), etag: object.etag };
}

async function writeStatus(env: PublicationEnv,
  commit: Pick<ShowCommit, "job_id" | "show_id"> & { kind: "show" | "episode"; episode_id?: string },
  state: JobStatus["state"], reason?: string): Promise<void> {
  const status: JobStatus = {
    schema_version: 1, job_id: commit.job_id, show_id: commit.show_id, kind: commit.kind, state,
    ...(commit.episode_id ? { episode_id: commit.episode_id } : {}),
    ...(reason ? { reason } : {}),
  };
  await env.CASTLOOP_BUCKET.put(`system/jobs/${commit.job_id}/status.toml`, stringifyToml(status));
}

async function sha256(data: BufferSource): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function matchesCover(bytes: Uint8Array, extension: string): boolean {
  return extension === "jpg"
    ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) =>
      byte === [137, 80, 78, 71, 13, 10, 26, 10][index]);
}

async function publishedEpisodes(env: PublicationEnv, showId: string): Promise<EpisodeRevision[]> {
  const prefix = `public/episodes/${showId}/`;
  const results: EpisodeRevision[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.CASTLOOP_BUCKET.list({ prefix, cursor });
    for (const object of listed.objects) {
      if (!object.key.endsWith("/metadata.toml")) continue;
      const metadata = await env.CASTLOOP_BUCKET.get(object.key);
      if (!metadata) throw new Error("Published Episode metadata disappeared");
      results.push(parseEpisodeRevision(await metadata.text()));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return results;
}

async function checkInputs(env: PublicationEnv, commit: ShowCommit): Promise<{
  metadata: string; feed: string; cover: ArrayBuffer;
}> {
  const bucket = env.CASTLOOP_BUCKET;
  const prefix = `staging/shows/${commit.show_id}/${commit.job_id}`;
  const [staged, image, service, existing, episodes] = await Promise.all([
    bucket.get(`${prefix}/show.toml`),
    bucket.get(`${prefix}/cover.${commit.cover_extension}`),
    bucket.get("system/service.toml"),
    bucket.get(`system/shows/${commit.show_id}/show.toml`),
    publishedEpisodes(env, commit.show_id),
  ]);
  if (!staged || !image || !service) throw new InvalidPublication("Staged Show inputs or service settings are missing");
  if (image.size > 5_000_000 || image.size === 0) throw new InvalidPublication("Cover size must be at most 5 MB");
  const metadata = await staged.text();
  const cover = await image.arrayBuffer();
  if (await sha256(new TextEncoder().encode(metadata).buffer as ArrayBuffer) !== commit.metadata_sha256 ||
    await sha256(cover) !== commit.cover_sha256 ||
    !matchesCover(new Uint8Array(cover), commit.cover_extension)) {
    throw new InvalidPublication("Staged Show input differs from committed snapshot");
  }
  let show: ReturnType<typeof parseShowMetadata>;
  let config: ReturnType<typeof parseServiceConfig>;
  const serviceText = await service.text();
  try {
    show = parseShowMetadata(metadata);
    config = parseServiceConfig(serviceText);
  } catch {
    throw new InvalidPublication("Invalid Show or service metadata");
  }
  if (show.show_id !== commit.show_id) throw new InvalidPublication("Show ID does not match committed job");
  const extension = show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
  if (extension !== commit.cover_extension) throw new InvalidPublication("Committed cover extension does not match Show metadata");
  if (existing) {
    let previous: ReturnType<typeof parseShowMetadata>;
    const previousText = await existing.text();
    try {
      previous = parseShowMetadata(previousText);
    } catch {
      throw new InvalidPublication("Invalid published Show metadata");
    }
    const oldExtension = previous.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
    if (oldExtension !== extension) throw new InvalidPublication("Changing the published cover extension is not supported");
  }
  return { metadata, feed: renderFeed(show, episodes, config.public_base_url, extension), cover };
}

export async function publishShow(env: PublicationEnv, ctx: ExecutionContext, key: string): Promise<void> {
  const parts = key.split("/");
  if (parts.length !== 5 || parts[0] !== "staging" || parts[1] !== "shows" ||
    parts[4] !== "commit.json") return;
  const marker = await env.CASTLOOP_BUCKET.get(key);
  if (!marker) return;
  const parsed = showCommitSchema.safeParse(await marker.json());
  if (!parsed.success || parsed.data.show_id !== parts[2] || parsed.data.job_id !== parts[3]) {
    const current = await readAdmission(env, parts[2]);
    if (current?.value.job_id === parts[3] && current.value.state !== "free" &&
      showCommitSchema.shape.job_id.safeParse(parts[3]).success) {
      await writeStatus(env, { job_id: parts[3], show_id: parts[2], kind: "show" }, "failed", "Invalid Show commit marker");
    }
    console.error(JSON.stringify({ event: "invalid_show_commit", key }));
    return;
  }
  const commit = parsed.data;
  const ownerKey = `system/show-publications/${commit.show_id}.json`;
  let current = await readAdmission(env, commit.show_id);
  if (!current || current.value.job_id !== commit.job_id || current.value.state === "free") return;
  const statusObject = await env.CASTLOOP_BUCKET.get(`system/jobs/${commit.job_id}/status.toml`);
  const status = statusObject ? parseJobStatus(await statusObject.text()) : null;
  const published = status?.job_id === commit.job_id && status.state === "published";
  if (!published) {
    let input: Awaited<ReturnType<typeof checkInputs>>;
    try {
      input = await checkInputs(env, commit);
    } catch (error) {
      if (error instanceof InvalidPublication) {
        await writeStatus(env, commit, "failed", error.message);
        return;
      }
      await writeStatus(env, commit, "retrying", error instanceof Error ? error.message : "Input read failed");
      throw error;
    }
    if (current.value.state === "reserved") {
      const begun = await env.CASTLOOP_BUCKET.put(ownerKey,
        JSON.stringify({ job_id: commit.job_id, state: "processing" } satisfies Admission),
        { onlyIf: { etagMatches: current.etag } });
      if (!begun) return;
    }
    try {
      await writeStatus(env, commit, "processing");
      await env.CASTLOOP_BUCKET.put(`system/shows/${commit.show_id}/show.toml`, input.metadata);
      await env.CASTLOOP_BUCKET.put(`public/podcasts/${commit.show_id}/cover.${commit.cover_extension}`,
        input.cover, { httpMetadata: { contentType: commit.cover_extension === "png" ? "image/png" : "image/jpeg" } });
      await env.CASTLOOP_BUCKET.put(`public/podcasts/${commit.show_id}/feed.xml`, input.feed,
        { httpMetadata: { contentType: "application/rss+xml; charset=utf-8" } });
      if (!ctx.cache) throw new Error("Workers Caching is unavailable");
      const purge = await ctx.cache.purge({ tags: [`feed-${commit.show_id}`, `cover-${commit.show_id}`] });
      if (!purge.success) throw new Error("Feed or cover cache purge failed");
      await writeStatus(env, commit, "published");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Transient publication error";
      await writeStatus(env, commit, "retrying", reason);
      throw error;
    }
  }
  current = await readAdmission(env, commit.show_id);
  if (!current || current.value.state !== "processing" || current.value.job_id !== commit.job_id) {
    throw new Error("Show publication ownership changed before release");
  }
  const released = await env.CASTLOOP_BUCKET.put(ownerKey,
    JSON.stringify({ job_id: commit.job_id, state: "free" } satisfies Admission),
    { onlyIf: { etagMatches: current.etag } });
  if (!released) throw new Error("Show publication release conflicted");
}

async function episodeInputs(env: PublicationEnv, commit: EpisodeCommit): Promise<{
  revision: EpisodeRevision;
  show: ReturnType<typeof parseShowMetadata>;
  coverExtension: "jpg" | "png";
  baseUrl: string;
}> {
  const bucket = env.CASTLOOP_BUCKET;
  const prefix = `staging/episodes/${commit.show_id}/${commit.episode_id}/${commit.job_id}`;
  const [metadata, audio, showObject, serviceObject, previous] = await Promise.all([
    bucket.get(`${prefix}/episode.toml`), bucket.head(`${prefix}/audio.mp3`),
    bucket.get(`system/shows/${commit.show_id}/show.toml`), bucket.get("system/service.toml"),
    bucket.get(`public/episodes/${commit.show_id}/${commit.episode_id}/metadata.toml`),
  ]);
  if (!metadata || !audio || !showObject || !serviceObject) {
    throw new InvalidPublication("Episode staging, published Show or service settings are missing");
  }
  if (audio.size !== commit.audio_length_bytes || audio.size > 300_000_000) {
    throw new InvalidPublication("Staged audio size does not match the committed input");
  }
  if (previous) {
    const current = parseEpisodeRevision(await previous.text());
    if (current.revision_id !== commit.job_id) {
      throw new InvalidPublication("Episode ID has already been published");
    }
  }
  const source = await metadata.text();
  if (await sha256(new TextEncoder().encode(source).buffer as ArrayBuffer) !== commit.metadata_sha256) {
    throw new InvalidPublication("Staged Episode metadata differs from committed input");
  }
  let episode: ReturnType<typeof parseEpisodeDraft>;
  let show: ReturnType<typeof parseShowMetadata>;
  let baseUrl: string;
  const showText = await showObject.text();
  const serviceText = await serviceObject.text();
  try {
    episode = parseEpisodeDraft(source);
    show = parseShowMetadata(showText);
    baseUrl = parseServiceConfig(serviceText).public_base_url.replace(/\/$/, "");
  } catch {
    throw new InvalidPublication("Invalid published Show, service or Episode metadata");
  }
  if (show.show_id !== commit.show_id || episode.episode_id !== commit.episode_id) {
    throw new InvalidPublication("Episode identifiers do not match the committed job");
  }
  const coverExtension = show.image_path.toLowerCase().endsWith(".png") ? "png" : "jpg";
  const revision: EpisodeRevision = {
    ...episode, revision_id: commit.job_id,
    enclosure_url: `${baseUrl}/podcasts/${commit.show_id}/episodes/${commit.episode_id}/${commit.job_id}.mp3`,
    content_type: "audio/mpeg", length_bytes: commit.audio_length_bytes,
    duration_seconds: commit.duration_seconds, sha256: commit.audio_sha256,
    updated_at: commit.committed_at,
  };
  return { revision, show, coverExtension, baseUrl };
}

async function publishMedia(env: PublicationEnv, commit: EpisodeCommit): Promise<void> {
  const bucket = env.CASTLOOP_BUCKET;
  const key = `public/podcasts/${commit.show_id}/episodes/${commit.episode_id}/${commit.job_id}.mp3`;
  const existing = await bucket.head(key);
  if (existing) {
    if (existing.size !== commit.audio_length_bytes || existing.customMetadata?.sha256 !== commit.audio_sha256) {
      throw new Error("Published media conflicts with committed audio");
    }
    return;
  }
  const staged = await bucket.get(`staging/episodes/${commit.show_id}/${commit.episode_id}/${commit.job_id}/audio.mp3`);
  if (!staged || staged.size !== commit.audio_length_bytes) throw new Error("Staged audio changed before copying");
  const hash = createHash("sha256");
  const verifying = staged.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (hash.digest("hex") !== commit.audio_sha256) throw new InvalidPublication("Staged audio checksum mismatch");
    },
  }));
  const output = typeof FixedLengthStream === "undefined"
    ? new TransformStream<Uint8Array, Uint8Array>() : new FixedLengthStream(commit.audio_length_bytes);
  const transfer = verifying.pipeTo(output.writable);
  const copying = bucket.put(key, output.readable, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: "audio/mpeg" },
    customMetadata: { sha256: commit.audio_sha256 },
  });
  const [copied] = await Promise.all([copying, transfer]);
  if (!copied) throw new Error("Published media key was claimed concurrently");
  if (copied.size !== commit.audio_length_bytes) throw new Error("Published media size mismatch");
}

export async function publishEpisode(env: PublicationEnv, ctx: ExecutionContext, key: string): Promise<void> {
  const parts = key.split("/");
  if (parts.length !== 6 || parts[0] !== "staging" || parts[1] !== "episodes" ||
    parts[5] !== "commit.json") return;
  const marker = await env.CASTLOOP_BUCKET.get(key);
  if (!marker) return;
  const parsed = episodeCommitSchema.safeParse(await marker.json());
  if (!parsed.success || parsed.data.show_id !== parts[2] || parsed.data.episode_id !== parts[3] ||
    parsed.data.job_id !== parts[4]) {
    const owner = await readAdmission(env, parts[2]);
    if (owner?.value.job_id === parts[4] && owner.value.state !== "free" &&
      episodeCommitSchema.shape.job_id.safeParse(parts[4]).success) {
      await writeStatus(env, { show_id: parts[2], job_id: parts[4], episode_id: parts[3], kind: "episode" },
        "failed", "Invalid Episode commit marker");
    }
    return;
  }
  const commit = parsed.data;
  const ownerKey = `system/show-publications/${commit.show_id}.json`;
  let owner = await readAdmission(env, commit.show_id);
  if (!owner || owner.value.job_id !== commit.job_id || owner.value.state === "free") return;
  const statusObject = await env.CASTLOOP_BUCKET.get(`system/jobs/${commit.job_id}/status.toml`);
  const status = statusObject ? parseJobStatus(await statusObject.text()) : null;
  if (status?.job_id !== commit.job_id || status.state !== "published") {
    let input: Awaited<ReturnType<typeof episodeInputs>>;
    try {
      input = await episodeInputs(env, commit);
    } catch (error) {
      if (error instanceof InvalidPublication) {
        await writeStatus(env, commit, "failed", error.message);
        return;
      }
      await writeStatus(env, commit, "retrying", error instanceof Error ? error.message : "Episode input read failed");
      throw error;
    }
    if (owner.value.state === "reserved") {
      const begun = await env.CASTLOOP_BUCKET.put(ownerKey,
        JSON.stringify({ job_id: commit.job_id, state: "processing" } satisfies Admission),
        { onlyIf: { etagMatches: owner.etag } });
      if (!begun) return;
    }
    try {
      await writeStatus(env, commit, "processing");
      await publishMedia(env, commit);
      const prefix = `public/episodes/${commit.show_id}/${commit.episode_id}`;
      const revisionKey = `${prefix}/revisions/${commit.job_id}.toml`;
      const revisionText = stringifyToml(input.revision);
      const existingRevision = await env.CASTLOOP_BUCKET.get(revisionKey);
      if (existingRevision && await existingRevision.text() !== revisionText) {
        throw new Error("Episode revision changed on retry");
      }
      if (!existingRevision) await env.CASTLOOP_BUCKET.put(revisionKey, revisionText,
        { onlyIf: new Headers({ "If-None-Match": "*" }) });
      await env.CASTLOOP_BUCKET.put(`${prefix}/metadata.toml`, revisionText);
      const episodes = await publishedEpisodes(env, commit.show_id);
      const feed = renderFeed(input.show, episodes, input.baseUrl, input.coverExtension);
      await env.CASTLOOP_BUCKET.put(`public/podcasts/${commit.show_id}/feed.xml`, feed,
        { httpMetadata: { contentType: "application/rss+xml; charset=utf-8" } });
      if (!ctx.cache || !(await ctx.cache.purge({ tags: [`feed-${commit.show_id}`] })).success) {
        throw new Error("Episode feed cache purge failed");
      }
      await writeStatus(env, commit, "published");
    } catch (error) {
      await writeStatus(env, commit, error instanceof InvalidPublication ? "failed" : "retrying",
        error instanceof Error ? error.message : "Episode publication failed");
      if (error instanceof InvalidPublication) return;
      throw error;
    }
  }
  owner = await readAdmission(env, commit.show_id);
  if (!owner || owner.value.job_id !== commit.job_id || owner.value.state !== "processing") {
    throw new Error("Episode publication ownership changed before release");
  }
  const released = await env.CASTLOOP_BUCKET.put(ownerKey,
    JSON.stringify({ job_id: commit.job_id, state: "free" } satisfies Admission),
    { onlyIf: { etagMatches: owner.etag } });
  if (!released) throw new Error("Episode publication release conflicted");
}
