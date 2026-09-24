import { validateId } from "../packages/shared/src/ids";
import { episodeCommitSchema, parseEpisodeRevision, parseJobStatus } from "../packages/shared/src/index";
import { publishEpisode, publishShow, readAdmission } from "./publication";
import type { Admission } from "./publication";

type Env = {
  CASTLOOP_BUCKET: R2Bucket;
  CASTLOOP_ADMIN_KEY: string;
  CASTLOOP_QUEUE: Queue;
  CASTLOOP_DLQ_NAME: string;
};

type ShowReservation = { show_id: string; reservation_id: string };
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function authenticated(request: Request, secret: string): boolean {
  const received = new TextEncoder().encode(request.headers.get("X-Castloop-Key") ?? "");
  const expected = new TextEncoder().encode(secret);
  let difference = received.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ (received[index] ?? 0);
  }
  return expected.length > 0 && difference === 0;
}

function json(data: object, status: number): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

async function publicAsset(request: Request, env: Env, pathname: string): Promise<Response | null> {
  const audio = /^\/podcasts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/episodes\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-f0-9-]{36})\.mp3$/.exec(pathname);
  if (audio && (request.method === "GET" || request.method === "HEAD") &&
    audio[1].length <= 32 && audio[2].length <= 80 && JOB_ID.test(audio[3])) {
    const object = await env.CASTLOOP_BUCKET.get(`public/podcasts/${audio[1]}/episodes/${audio[2]}/${audio[3]}.mp3`);
    if (!object) return json({ error: "not found" }, 404);
    return new Response(request.method === "HEAD" ? null : object.body, { headers: {
      "Content-Type": "audio/mpeg", "Content-Length": String(object.size), "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Cloudflare-CDN-Cache-Control": "public, max-age=31536000",
    } });
  }
  const path = /^\/podcasts\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(feed\.xml|cover\.(?:jpg|png))$/.exec(pathname);
  if (!path || (request.method !== "GET" && request.method !== "HEAD")) return null;
  const [show, name] = [path[1], path[2]];
  if (show.length > 32) return null;
  const object = await env.CASTLOOP_BUCKET.get(`public/podcasts/${show}/${name}`);
  if (!object) return json({ error: "not found" }, 404);
  const feed = name === "feed.xml";
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: {
      "Content-Type": feed ? "application/rss+xml; charset=utf-8" : name.endsWith("png") ? "image/png" : "image/jpeg",
      "Content-Length": String(object.size),
      ...(feed ? {} : { "Accept-Ranges": "bytes" }),
      "Cache-Control": "public, max-age=300",
      "Cloudflare-CDN-Cache-Control": "public, max-age=3600",
      "Cache-Tag": `${feed ? "feed" : "cover"}-${show}`,
    },
  });
}

async function claimPublication(env: Env, showId: string, jobId: string): Promise<Response> {
  if (!await env.CASTLOOP_BUCKET.head(`system/show-reservations/${showId}.json`)) {
    return json({ error: "Show ID is not reserved" }, 404);
  }
  const key = `system/show-publications/${showId}.json`;
  const current = await readAdmission(env, showId);
  if (current && current.value.state !== "free") {
    return current.value.job_id === jobId
      ? json({ result: "already-reserved", job_id: jobId }, 200)
      : json({ error: "Show has an unfinished job", job_id: current.value.job_id }, 409);
  }
  if (current?.value.job_id === jobId) return json({ error: "Completed job ID cannot be reused" }, 409);
  if (await env.CASTLOOP_BUCKET.head(`system/jobs/${jobId}/status.toml`)) {
    return json({ error: "Job ID has already been used" }, 409);
  }
  const value: Admission = { job_id: jobId, state: "reserved" };
  const written = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(value), {
    onlyIf: current ? { etagMatches: current.etag } : new Headers({ "If-None-Match": "*" }),
  });
  if (written) return json({ result: "reserved", job_id: jobId }, 201);
  const updated = await readAdmission(env, showId);
  return updated?.value.job_id === jobId && updated.value.state !== "free"
    ? json({ result: "already-reserved", job_id: jobId }, 200)
    : json({ error: "Show has an unfinished job", job_id: updated?.value.job_id }, 409);
}

export default {
  async fetch(request, env): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const asset = await publicAsset(request, env, pathname);
    if (asset) return asset;
    if (pathname === "/admin/health" && request.method === "GET") {
      return authenticated(request, env.CASTLOOP_ADMIN_KEY)
        ? json({ result: "ready" }, 200) : json({ error: "unauthorized" }, 401);
    }
    if (!pathname.startsWith("/admin/")) {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (!authenticated(request, env.CASTLOOP_ADMIN_KEY)) return json({ error: "unauthorized" }, 401);
    if (request.method === "GET" && pathname.startsWith("/admin/episodes/") &&
      pathname.endsWith("/current")) {
      const parts = pathname.split("/");
      if (parts.length !== 6) return json({ error: "not found" }, 404);
      let showId: string;
      let episodeId: string;
      try {
        showId = validateId(parts[3], "show");
        episodeId = validateId(parts[4], "episode");
      } catch {
        return json({ error: "invalid Episode path" }, 400);
      }
      const current = await env.CASTLOOP_BUCKET.get(`public/episodes/${showId}/${episodeId}/metadata.toml`);
      return json({ revision: current ? parseEpisodeRevision(await current.text()) : null }, 200);
    }
    if (request.method === "GET" && pathname.startsWith("/admin/jobs/")) {
      const jobId = pathname.slice("/admin/jobs/".length);
      const url = new URL(request.url);
      const showId = url.searchParams.get("show");
      const episodeId = url.searchParams.get("episode");
      if (!JOB_ID.test(jobId)) return json({ error: "invalid job ID" }, 400);
      let show: string;
      try {
        show = validateId(showId, "show");
      } catch {
        return json({ error: "invalid Show ID" }, 400);
      }
      let episode: string | null = null;
      if (episodeId !== null) {
        try {
          episode = validateId(episodeId, "episode");
        } catch {
          return json({ error: "invalid Episode ID" }, 400);
        }
      }
      const [admission, marker, status, dlq] = await Promise.all([
        readAdmission(env, show),
        env.CASTLOOP_BUCKET.get(episode
          ? `staging/episodes/${show}/${episode}/${jobId}/commit.json`
          : `staging/shows/${show}/${jobId}/commit.json`),
        env.CASTLOOP_BUCKET.get(`system/jobs/${jobId}/status.toml`),
        env.CASTLOOP_BUCKET.head(`system/jobs/${jobId}/dlq.json`),
      ]);
      return json({ owner: admission?.value ?? null, marker: marker ? await marker.json() : null,
        status: status ? parseJobStatus(await status.text()) : null, dlq: Boolean(dlq) }, 200);
    }
    if (request.method !== "POST" ||
      !["/admin/shows/reserve", "/admin/publications/claim", "/admin/jobs/retry",
        "/admin/jobs/cleanup"].includes(pathname)) {
      return json({ error: "not found" }, 404);
    }
    if (Number(request.headers.get("Content-Length")) > 1024) return json({ error: "too large" }, 413);
    let input: unknown;
    try {
      const body = await request.text();
      if (body.length > 1024) return json({ error: "too large" }, 413);
      input = JSON.parse(body);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "invalid input" }, 400);
    const { show_id, reservation_id, job_id, kind, episode_id } = input as Record<string, unknown>;
    let showId: string;
    try {
      showId = validateId(show_id, "show");
    } catch {
      return json({ error: "invalid show ID" }, 400);
    }
    if (pathname === "/admin/jobs/cleanup") {
      if (typeof job_id !== "string" || !JOB_ID.test(job_id)) return json({ error: "invalid job ID" }, 400);
      let episodeId: string;
      try {
        episodeId = validateId(episode_id, "episode");
      } catch {
        return json({ error: "invalid Episode ID" }, 400);
      }
      const prefix = `staging/episodes/${showId}/${episodeId}/${job_id}`;
      const [statusObject, admission, markerObject, revisionObject] = await Promise.all([
        env.CASTLOOP_BUCKET.get(`system/jobs/${job_id}/status.toml`),
        readAdmission(env, showId),
        env.CASTLOOP_BUCKET.get(`${prefix}/commit.json`),
        env.CASTLOOP_BUCKET.get(`public/episodes/${showId}/${episodeId}/revisions/${job_id}.toml`),
      ]);
      const status = statusObject ? parseJobStatus(await statusObject.text()) : null;
      const marker = markerObject ? episodeCommitSchema.safeParse(await markerObject.json()) : null;
      if (status?.state !== "published" || status.kind !== "episode" || status.job_id !== job_id ||
        status.show_id !== showId || status.episode_id !== episodeId ||
        !admission || admission.value.job_id === job_id && admission.value.state !== "free" ||
        !marker?.success || marker.data.job_id !== job_id || marker.data.show_id !== showId ||
        marker.data.episode_id !== episodeId || !revisionObject) {
        return json({ error: "Only a completed Episode job with intact history can be cleaned" }, 409);
      }
      const revision = parseEpisodeRevision(await revisionObject.text());
      if (revision.revision_id !== job_id || revision.episode_id !== episodeId ||
        revision.sha256 !== (marker.data.audio_sha256 ?? revision.sha256)) {
        return json({ error: "Published revision does not match this job" }, 409);
      }
      if (!marker.data.audio_sha256) return json({ result: "no staged audio" }, 200);
      const media = await env.CASTLOOP_BUCKET.head(
        `public/podcasts/${showId}/episodes/${episodeId}/${job_id}.mp3`);
      if (!media || media.size !== marker.data.audio_length_bytes ||
        media.customMetadata?.sha256 !== marker.data.audio_sha256) {
        return json({ error: "Published media could not be verified" }, 409);
      }
      await env.CASTLOOP_BUCKET.delete(`${prefix}/audio.mp3`);
      return json({ result: "staged audio removed; immutable media and metadata retained" }, 200);
    }
    if (pathname === "/admin/jobs/retry") {
      if (typeof job_id !== "string" || !JOB_ID.test(job_id) ||
        (kind !== "show" && kind !== "episode")) return json({ error: "invalid job" }, 400);
      let episodeId: string | undefined;
      if (kind === "episode") {
        try {
          episodeId = validateId(episode_id, "episode");
        } catch {
          return json({ error: "invalid Episode ID" }, 400);
        }
      }
      const admission = await readAdmission(env, showId);
      const status = await env.CASTLOOP_BUCKET.get(`system/jobs/${job_id}/status.toml`);
      const job = status ? parseJobStatus(await status.text()) : null;
      const markerKey = kind === "show" ? `staging/shows/${showId}/${job_id}/commit.json`
        : `staging/episodes/${showId}/${episodeId}/${job_id}/commit.json`;
      const [marker, dlq] = await Promise.all([
        env.CASTLOOP_BUCKET.head(markerKey), env.CASTLOOP_BUCKET.head(`system/jobs/${job_id}/dlq.json`),
      ]);
      if (admission?.value.job_id !== job_id || admission.value.state === "free" ||
        job?.state !== "retrying" || job.kind !== kind || !marker || !dlq) {
        return json({ error: "Only an unfinished job in the DLQ can be retried" }, 409);
      }
      await env.CASTLOOP_QUEUE.send({ object: { key: markerKey } });
      return json({ result: "requeued", job_id }, 202);
    }
    if (pathname === "/admin/publications/claim") {
      if (typeof job_id !== "string" || !JOB_ID.test(job_id)) return json({ error: "invalid job ID" }, 400);
      return claimPublication(env, showId, job_id);
    }
    if (typeof reservation_id !== "string" || !JOB_ID.test(reservation_id)) {
      return json({ error: "invalid reservation ID" }, 400);
    }
    const key = `system/show-reservations/${showId}.json`;
    const value: ShowReservation = { show_id: showId, reservation_id };
    const current = await env.CASTLOOP_BUCKET.get(key);
    if (current) {
      const record: unknown = await current.json();
      return record && typeof record === "object" && "reservation_id" in record &&
        record.reservation_id === reservation_id
        ? json({ result: "already-reserved" }, 200)
        : json({ error: "show ID already reserved" }, 409);
    }
    const created = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(value), {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (created) return json({ result: "reserved" }, 201);
    const existing = await env.CASTLOOP_BUCKET.get(key);
    if (existing) {
      const record: unknown = await existing.json();
      if (record && typeof record === "object" && "reservation_id" in record &&
        record.reservation_id === reservation_id) return json({ result: "already-reserved" }, 200);
    }
    return json({ error: "show ID already reserved" }, 409);
  },
  async queue(batch, env, ctx): Promise<void> {
    if (batch.queue === env.CASTLOOP_DLQ_NAME) {
      for (const message of batch.messages) {
        const body: unknown = message.body;
        const detail = body && typeof body === "object" && "object" in body ? body.object : null;
        const key = detail && typeof detail === "object" && "key" in detail ? detail.key : null;
        if (typeof key !== "string") {
          await env.CASTLOOP_BUCKET.put(`system/dlq/unmatched/${message.id}.json`, JSON.stringify({ body }));
          continue;
        }
        const parts = key.split("/");
        const jobId = parts.at(-2);
        if (!jobId || !JOB_ID.test(jobId)) {
          await env.CASTLOOP_BUCKET.put(`system/dlq/unmatched/${message.id}.json`, JSON.stringify({ key }));
          continue;
        }
        await env.CASTLOOP_BUCKET.put(`system/jobs/${jobId}/dlq.json`, JSON.stringify({ key }));
      }
      return;
    }
    for (const message of batch.messages) {
      const body: unknown = message.body;
      if (!body || typeof body !== "object" || !("object" in body) ||
        !body.object || typeof body.object !== "object" || !("key" in body.object) ||
        typeof body.object.key !== "string") continue;
      const key = body.object.key;
      if (key.startsWith("staging/shows/") && key.endsWith("/commit.json")) {
        await publishShow(env, ctx, key);
      } else if (key.startsWith("staging/episodes/") && key.endsWith("/commit.json")) {
        await publishEpisode(env, ctx, key);
      }
    }
  },
} satisfies ExportedHandler<Env>;
