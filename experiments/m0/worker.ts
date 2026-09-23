type Reservation = {
  jobId: string;
  state: "held" | "processing" | "free";
};

function authorized(request: Request, secret: string): boolean {
  const encoder = new TextEncoder();
  const received = encoder.encode(request.headers.get("X-M0-Key") ?? "");
  const expected = encoder.encode(secret);
  let difference = received.length ^ expected.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ (received[index] ?? 0);
  }
  return difference === 0 && expected.length > 0;
}

function validShow(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 32;
}

function validJob(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]{1,80}$/.test(value);
}

function validEpisode(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

type FlowMarker = {
  show: string;
  jobId: string;
  kind: "show" | "episode";
  episodeId?: string;
  prefix: string;
};

function parseFlowMarker(key: string): FlowMarker | null {
  const parts = key.split("/");
  if (parts[0] !== "staging" || parts.at(-1) !== "commit.json") return null;
  if (parts[1] === "shows" && parts.length === 5 && validShow(parts[2]) &&
    parts[2].startsWith("m0-flow-") && validJob(parts[3])) {
    return { show: parts[2], jobId: parts[3], kind: "show", prefix: parts.slice(0, -1).join("/") };
  }
  if (parts[1] === "episodes" && parts.length === 6 && validShow(parts[2]) &&
    parts[2].startsWith("m0-flow-") && validEpisode(parts[3]) && validJob(parts[4])) {
    return {
      show: parts[2], episodeId: parts[3], jobId: parts[4], kind: "episode",
      prefix: parts.slice(0, -1).join("/"),
    };
  }
  return null;
}

async function readReservation(env: Env, key: string): Promise<{ value: Reservation; etag: string } | null> {
  const object = await env.M0_BUCKET.get(key);
  if (!object) return null;
  const value = await object.json<Reservation>();
  return { value, etag: object.etag };
}

async function readText(env: Env, key: string): Promise<string | null> {
  const object = await env.M0_BUCKET.get(key);
  return object ? object.text() : null;
}

async function processGateMarker(env: Env, key: string, attempt: number): Promise<void> {
  const parts = key.split("/");
  if (parts.length !== 5 || parts[0] !== "staging" || parts[1] !== "shows" ||
    !parts[2].startsWith("m0-gate-") || !validShow(parts[2]) || !validJob(parts[3]) ||
    parts[4] !== "commit.json") return;

  const show = parts[2];
  const jobId = parts[3];
  const prefix = `m0/gate/${show}/${jobId}`;
  const reservationKey = `m0/reservations/${show}`;
  const current = await readReservation(env, reservationKey);
  if (!current || current.value.jobId !== jobId || current.value.state === "free") {
    await env.M0_BUCKET.put(`${prefix}/rejected`, "not-owner");
    return;
  }
  if (current.value.state === "held") {
    const begun = await env.M0_BUCKET.put(reservationKey, JSON.stringify({ state: "processing", jobId }), {
      onlyIf: { etagMatches: current.etag },
    });
    if (!begun) {
      const updated = await readReservation(env, reservationKey);
      if (updated?.value.jobId !== jobId || updated.value.state !== "processing") {
        await env.M0_BUCKET.put(`${prefix}/rejected`, "lost-begin-race");
        return;
      }
    }
  }

  await env.M0_BUCKET.put(`${prefix}/attempt-${attempt}`, "started");
  const status = await readText(env, `${prefix}/status`);
  if (status !== "published") {
    await env.M0_BUCKET.put(`${prefix}/immutable`, "snapshot-" + jobId);
    if (jobId.startsWith("fail-always-")) {
      await env.M0_BUCKET.put(`${prefix}/status`, "blocked: injected failure");
      throw new Error("M0 injected permanent processing failure");
    }
    if (jobId.startsWith("retry-once-") && attempt === 1) {
      throw new Error("M0 injected failure after partial write");
    }
    await env.M0_BUCKET.put(`m0/gate/${show}/visible`, jobId);
    await env.M0_BUCKET.put(`${prefix}/status`, "published");
    if (jobId.startsWith("after-status-once-") && attempt === 1) {
      throw new Error("M0 injected failure after status, before release");
    }
  }

  const final = await readReservation(env, reservationKey);
  if (!final || final.value.state !== "processing" || final.value.jobId !== jobId) {
    throw new Error("M0 reservation changed before completion");
  }
  const released = await env.M0_BUCKET.put(reservationKey, JSON.stringify({ state: "free", jobId }), {
    onlyIf: { etagMatches: final.etag },
  });
  if (!released) throw new Error("M0 reservation release conflicted");
}

async function processFlowMarker(env: Env, key: string): Promise<void> {
  const marker = parseFlowMarker(key);
  if (!marker) return;
  const { show, jobId, kind, prefix } = marker;
  const reservationKey = `m0/reservations/${show}`;
  const statusKey = `m0/flow/${show}/${jobId}/status`;
  const current = await readReservation(env, reservationKey);
  if (!current || current.value.jobId !== jobId || current.value.state === "free") {
    await env.M0_BUCKET.put(`m0/flow/${show}/${jobId}/rejected`, "not-owner");
    return;
  }

  const commit = await env.M0_BUCKET.get(key);
  const metadata = await env.M0_BUCKET.get(`${prefix}/${kind === "show" ? "show.toml" : "episode.toml"}`);
  if (!commit || !metadata) throw new Error("M0 flow staged input missing");
  const data: unknown = await commit.json();
  if (!data || typeof data !== "object" || !("show" in data) || data.show !== show ||
    !("jobId" in data) || data.jobId !== jobId || !("kind" in data) || data.kind !== kind ||
    (kind === "episode" && (!("episodeId" in data) || data.episodeId !== marker.episodeId))) {
    throw new Error("M0 flow marker does not match staged job");
  }
  if (current.value.state === "held") {
    const begun = await env.M0_BUCKET.put(reservationKey, JSON.stringify({ state: "processing", jobId }), {
      onlyIf: { etagMatches: current.etag },
    });
    if (!begun) {
      const updated = await readReservation(env, reservationKey);
      if (updated?.value.jobId !== jobId || updated.value.state !== "processing") {
        await env.M0_BUCKET.put(`m0/flow/${show}/${jobId}/rejected`, "lost-begin-race");
        return;
      }
    }
  }

  await env.M0_BUCKET.put(`m0/flow/${show}/${jobId}/kind`, kind);
  await env.M0_BUCKET.put(`m0/flow/${show}/visible`, jobId);
  await env.M0_BUCKET.put(statusKey, "published");
  const final = await readReservation(env, reservationKey);
  if (!final || final.value.state !== "processing" || final.value.jobId !== jobId) {
    throw new Error("M0 flow reservation changed before release");
  }
  const released = await env.M0_BUCKET.put(reservationKey, JSON.stringify({ state: "free", jobId }), {
    onlyIf: { etagMatches: final.etag },
  });
  if (!released) throw new Error("M0 flow reservation release conflicted");
}

async function processReleaseMarker(env: Env, ctx: ExecutionContext, key: string, attempt: number): Promise<void> {
  const parts = key.split("/");
  const kind = parts[1] === "shows" ? "show" : "episode";
  const show = parts[2];
  const jobId = kind === "show" ? parts[3] : parts[4];
  const episodeId = kind === "episode" ? parts[3] : undefined;
  if (parts[0] !== "staging" || (parts[1] !== "shows" && parts[1] !== "episodes") ||
    parts.at(-1) !== "commit.json" || parts.length !== (kind === "show" ? 5 : 6) ||
    !validShow(show) || !show.startsWith("m0-release-") || !validJob(jobId) ||
    (kind === "episode" && !validEpisode(episodeId))) return;

  const reservationKey = `m0/reservations/${show}`;
  const prefix = `m0/release/${show}/${jobId}`;
  const statusKey = `${prefix}/status`;
  const current = await readReservation(env, reservationKey);
  if (!current || current.value.jobId !== jobId || current.value.state === "free") {
    await env.M0_BUCKET.put(`${prefix}/rejected`, "not-owner");
    return;
  }

  const stagedPrefix = parts.slice(0, -1).join("/");
  const commit = await env.M0_BUCKET.get(key);
  const metadata = await env.M0_BUCKET.get(`${stagedPrefix}/${kind === "show" ? "show.toml" : "episode.toml"}`);
  const feed = await env.M0_BUCKET.get(`${stagedPrefix}/feed.xml`);
  const cover = kind === "show" ? await env.M0_BUCKET.get(`${stagedPrefix}/cover.jpg`) : null;
  if (!commit || !metadata || !feed || (kind === "show" && !cover)) {
    throw new Error("M0 release staged input missing");
  }
  const data: unknown = await commit.json();
  if (!data || typeof data !== "object" || !("show" in data) || data.show !== show ||
    !("jobId" in data) || data.jobId !== jobId || !("kind" in data) || data.kind !== kind ||
    (kind === "episode" && (!("episodeId" in data) || data.episodeId !== episodeId))) {
    throw new Error("M0 release commit marker mismatch");
  }
  if (current.value.state === "held") {
    const begun = await env.M0_BUCKET.put(reservationKey, JSON.stringify({ state: "processing", jobId }), {
      onlyIf: { etagMatches: current.etag },
    });
    if (!begun) throw new Error("M0 release admission changed before processing");
  }

  if (await readText(env, statusKey) !== "published") {
    await env.M0_BUCKET.put(statusKey, "processing");
    if (kind === "show") {
      await env.M0_BUCKET.put(`m0/system/shows/${show}/show.toml`, await metadata.arrayBuffer());
      await env.M0_BUCKET.put(`m0/public/podcasts/${show}/feed.xml`, await feed.arrayBuffer());
      if (!cover) throw new Error("M0 release cover missing");
      await env.M0_BUCKET.put(`m0/public/podcasts/${show}/cover.jpg`, await cover.arrayBuffer());
    } else {
      await env.M0_BUCKET.put(`m0/public/episodes/${show}/${episodeId}/metadata.toml`, await metadata.arrayBuffer());
      if (jobId.startsWith("partial-once-") && attempt === 1) {
        await env.M0_BUCKET.put(`${prefix}/attempt-${attempt}.json`,
          JSON.stringify({ phase: "after-metadata", owner: "processing", status: "processing" }));
        throw new Error("M0 injected failure after episode metadata");
      }
      await env.M0_BUCKET.put(`m0/public/podcasts/${show}/feed.xml`, await feed.arrayBuffer());
    }

    if (!ctx.cache) throw new Error("M0 Workers Caching unavailable");
    if (kind === "show" && jobId.startsWith("purge-once-") && attempt === 1) {
      await env.M0_BUCKET.put(`${prefix}/attempt-${attempt}.json`,
        JSON.stringify({ phase: "before-purge", owner: "processing", status: "processing" }));
      throw new Error("M0 injected purge failure");
    }
    const tags = kind === "show" ? [`m0-feed-${show}`, `m0-cover-${show}`] : [`m0-feed-${show}`];
    const purge = await ctx.cache.purge({ tags });
    if (!purge.success) throw new Error("M0 release cache purge failed");
    await env.M0_BUCKET.put(`${prefix}/attempt-${attempt}.json`,
      JSON.stringify({ phase: "purged", owner: "processing", status: "processing" }));
    await env.M0_BUCKET.put(statusKey, "published");
  }

  const final = await readReservation(env, reservationKey);
  if (!final || final.value.state !== "processing" || final.value.jobId !== jobId) {
    throw new Error("M0 release reservation changed before completion");
  }
  const released = await env.M0_BUCKET.put(reservationKey, JSON.stringify({ state: "free", jobId }), {
    onlyIf: { etagMatches: final.etag },
  });
  if (!released) throw new Error("M0 release completion conflicted");
}

function parseDiagMarker(key: string): { show: string; jobId: string } | null {
  const parts = key.split("/");
  if (parts.length !== 5 || parts[0] !== "staging" || parts[1] !== "shows" ||
    !validShow(parts[2]) || !parts[2].startsWith("m0-diag-") ||
    !validJob(parts[3]) || parts[4] !== "commit.json") return null;
  return { show: parts[2], jobId: parts[3] };
}

async function processDiagMarker(env: Env, key: string, attempt: number): Promise<void> {
  const marker = parseDiagMarker(key);
  if (!marker) return;
  const { show, jobId } = marker;
  const reservationKey = `m0/reservations/${show}`;
  const statusKey = `system/jobs/${jobId}/status.toml`;
  const current = await readReservation(env, reservationKey);
  if (!current || current.value.jobId !== jobId || current.value.state === "free") {
    await env.M0_BUCKET.put(`m0/diag/${show}/${jobId}/rejected`, "not-owner");
    return;
  }
  if (jobId.startsWith("invalid-")) {
    await env.M0_BUCKET.put(statusKey,
      `job_id = "${jobId}"\nstate = "failed"\nreason = "invalid staged input"\n`);
    return;
  }
  if (current.value.state === "held") {
    const begun = await env.M0_BUCKET.put(reservationKey, JSON.stringify({ state: "processing", jobId }), {
      onlyIf: { etagMatches: current.etag },
    });
    if (!begun) throw new Error("M0 diagnostic admission changed before processing");
  }
  await env.M0_BUCKET.put(`m0/diag/${show}/${jobId}/attempt-${attempt}`, "started");
  if (jobId.startsWith("fail-with-status-")) {
    await env.M0_BUCKET.put(statusKey,
      `job_id = "${jobId}"\nstate = "retrying"\nreason = "injected R2 failure"\n`);
    throw new Error("M0 diagnostic injected transient failure");
  }
  if (jobId.startsWith("fail-no-status-")) {
    throw new Error("M0 diagnostic injected failure before status write");
  }
  await env.M0_BUCKET.put(statusKey, `job_id = "${jobId}"\nstate = "published"\n`);
  const final = await readReservation(env, reservationKey);
  if (!final || final.value.jobId !== jobId || final.value.state !== "processing") {
    throw new Error("M0 diagnostic reservation changed before completion");
  }
  const released = await env.M0_BUCKET.put(reservationKey, JSON.stringify({ state: "free", jobId }), {
    onlyIf: { etagMatches: final.etag },
  });
  if (!released) throw new Error("M0 diagnostic release conflicted");
}

function adminJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const publicPath = /^\/m0\/podcasts\/(m0-release-[a-z0-9-]+)\/(feed\.xml|cover\.jpg)$/.exec(url.pathname);
    if (publicPath && validShow(publicPath[1]) && (request.method === "GET" || request.method === "HEAD")) {
      const show = publicPath[1];
      const name = publicPath[2];
      const object = await env.M0_BUCKET.get(`m0/public/podcasts/${show}/${name}`);
      if (!object) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      return new Response(request.method === "HEAD" ? null : object.body, {
        headers: {
          "Content-Type": name === "feed.xml" ? "application/rss+xml" : "image/jpeg",
          "Cache-Control": "public, max-age=300",
          "Cloudflare-CDN-Cache-Control": "public, max-age=3600",
          "Cache-Tag": name === "feed.xml" ? `m0-feed-${show}` : `m0-cover-${show}`,
        },
      });
    }
    const media = {
      "/m0/feed.xml": { key: "m0/public/feed.xml", contentType: "application/rss+xml", tag: "m0-feed" },
      "/m0/cover.jpg": { key: "m0/public/cover.jpg", contentType: "image/jpeg", tag: "m0-cover" },
      "/m0/audio.mp3": { key: "m0/public/audio.mp3", contentType: "audio/mpeg", tag: "m0-audio" },
    }[url.pathname];
    if (media && (request.method === "GET" || request.method === "HEAD")) {
      const object = await env.M0_BUCKET.get(media.key);
      if (!object) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      return new Response(request.method === "HEAD" ? null : object.body, {
        headers: {
          "Content-Type": media.contentType,
          "Content-Length": String(object.size),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=300",
          "Cloudflare-CDN-Cache-Control": "public, max-age=3600",
          "Cache-Tag": media.tag,
        },
      });
    }
    if (!authorized(request, env.M0_SECRET)) {
      return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/owner") {
      const show = url.searchParams.get("show");
      if (!validShow(show)) return new Response("Invalid show", { status: 400, headers: { "Cache-Control": "no-store" } });
      const current = await readReservation(env, `m0/reservations/${show}`);
      return adminJson(current?.value ?? null);
    }
    if (request.method === "GET" && url.pathname === "/events") {
      const listed = await env.M0_BUCKET.list({ prefix: "m0/events/" });
      const keys = await Promise.all(listed.objects.map(async (object) => {
        const stored = await env.M0_BUCKET.get(object.key);
        return stored?.text();
      }));
      return adminJson({ keys: keys.filter((key) => key !== undefined), truncated: listed.truncated });
    }
    if (request.method === "GET" && url.pathname === "/diagnostics") {
      const prefixes = ["m0/attempts/", "m0/dlq/", "m0/status/", "m0/rejected/", "m0/cache-attempts/"];
      const records = await Promise.all(prefixes.map(async (prefix) => {
        const listed = await env.M0_BUCKET.list({ prefix });
        const values = await Promise.all(listed.objects.map(async (object) => {
          const stored = await env.M0_BUCKET.get(object.key);
          return { key: object.key, value: await stored?.text() };
        }));
        return { prefix, values, truncated: listed.truncated };
      }));
      return adminJson(records);
    }
    if (request.method === "GET" && url.pathname === "/simulation") {
      const show = url.searchParams.get("show");
      if (!validShow(show)) return new Response("Invalid show", { status: 400, headers: { "Cache-Control": "no-store" } });
      const started = await env.M0_BUCKET.head(`m0/simulation-start/${show}`);
      const current = await env.M0_BUCKET.get(`m0/unsafe-current/${show}`);
      return adminJson({ started: Boolean(started), current: current ? await current.text() : null });
    }
    if (request.method === "GET" && url.pathname === "/gate") {
      const show = url.searchParams.get("show");
      const jobId = url.searchParams.get("job");
      if (!validShow(show) || !validJob(jobId) || !show.startsWith("m0-gate-")) {
        return adminJson({ error: "invalid gate identifiers" }, 400);
      }
      const prefix = `m0/gate/${show}/${jobId}`;
      const attempts = await env.M0_BUCKET.list({ prefix: `${prefix}/attempt-` });
      return adminJson({
        owner: (await readReservation(env, `m0/reservations/${show}`))?.value ?? null,
        visible: await readText(env, `m0/gate/${show}/visible`),
        status: await readText(env, `${prefix}/status`),
        immutable: await readText(env, `${prefix}/immutable`),
        rejected: await readText(env, `${prefix}/rejected`),
        dlq: await readText(env, `${prefix}/dlq`),
        attempts: attempts.objects.map((object) => object.key),
      });
    }
    if (request.method === "GET" && url.pathname === "/flow") {
      const show = url.searchParams.get("show");
      const jobId = url.searchParams.get("job");
      const kind = url.searchParams.get("kind");
      const episodeId = url.searchParams.get("episode");
      if (!validShow(show) || !show.startsWith("m0-flow-") || !validJob(jobId) ||
        (kind !== "show" && kind !== "episode") || (kind === "episode" && !validEpisode(episodeId))) {
        return adminJson({ error: "invalid flow identifiers" }, 400);
      }
      const prefix = kind === "show"
        ? `staging/shows/${show}/${jobId}`
        : `staging/episodes/${show}/${episodeId}/${jobId}`;
      return adminJson({
        owner: (await readReservation(env, `m0/reservations/${show}`))?.value ?? null,
        markerExists: Boolean(await env.M0_BUCKET.head(`${prefix}/commit.json`)),
        metadataExists: Boolean(await env.M0_BUCKET.head(`${prefix}/${kind === "show" ? "show.toml" : "episode.toml"}`)),
        status: await readText(env, `m0/flow/${show}/${jobId}/status`),
        visible: await readText(env, `m0/flow/${show}/visible`),
        processedKind: await readText(env, `m0/flow/${show}/${jobId}/kind`),
      });
    }
    if (request.method === "GET" && url.pathname === "/release") {
      const show = url.searchParams.get("show");
      const jobId = url.searchParams.get("job");
      const episodeId = url.searchParams.get("episode");
      if (!validShow(show) || !show.startsWith("m0-release-") || !validJob(jobId) ||
        (episodeId !== null && !validEpisode(episodeId))) {
        return adminJson({ error: "invalid release identifiers" }, 400);
      }
      const prefix = `m0/release/${show}/${jobId}`;
      const attempts = await env.M0_BUCKET.list({ prefix: `${prefix}/attempt-` });
      const records = await Promise.all(attempts.objects.map(async (object) => {
        const stored = await env.M0_BUCKET.get(object.key);
        return stored?.json();
      }));
      return adminJson({
        owner: (await readReservation(env, `m0/reservations/${show}`))?.value ?? null,
        status: await readText(env, `${prefix}/status`),
        rejected: await readText(env, `${prefix}/rejected`),
        showMetadata: await readText(env, `m0/system/shows/${show}/show.toml`),
        episodeMetadata: episodeId ? await readText(env, `m0/public/episodes/${show}/${episodeId}/metadata.toml`) : null,
        feed: await readText(env, `m0/public/podcasts/${show}/feed.xml`),
        attempts: records,
      });
    }
    if (request.method === "GET" && url.pathname === "/diagnose") {
      const show = url.searchParams.get("show");
      const jobId = url.searchParams.get("job");
      if (!validShow(show) || !show.startsWith("m0-diag-") || !validJob(jobId)) {
        return adminJson({ error: "invalid diagnostic identifiers" }, 400);
      }
      const prefix = `m0/diag/${show}/${jobId}`;
      const [owner, marker, status, dlq, attempts] = await Promise.all([
        readReservation(env, `m0/reservations/${show}`),
        env.M0_BUCKET.head(`staging/shows/${show}/${jobId}/commit.json`),
        readText(env, `system/jobs/${jobId}/status.toml`),
        readText(env, `${prefix}/dlq`),
        env.M0_BUCKET.list({ prefix: `${prefix}/attempt-` }),
      ]);
      const state = /^state = "([a-z]+)"$/m.exec(status ?? "")?.[1] ?? null;
      let diagnosis = "unknown";
      if (owner?.value.jobId === jobId && owner.value.state === "free" && state === "published") {
        diagnosis = "published";
      } else if (owner?.value.jobId === jobId && owner.value.state === "held" && !marker) {
        diagnosis = "reserved-no-commit";
      } else if (owner?.value.jobId === jobId && owner.value.state === "held" && state === "failed") {
        diagnosis = "failed-before-processing";
      } else if (owner?.value.jobId === jobId && owner.value.state === "processing" && dlq) {
        diagnosis = status ? "blocked-dlq" : "blocked-dlq-status-missing";
      } else if (owner?.value.jobId === jobId && owner.value.state === "processing") {
        diagnosis = "processing-or-retrying";
      } else if (owner?.value.jobId === jobId && owner.value.state === "held" && marker) {
        diagnosis = "queued-or-unknown";
      } else if (owner && owner.value.jobId !== jobId) {
        diagnosis = "not-current-job";
      }
      return adminJson({
        owner: owner?.value ?? null, commitExists: Boolean(marker), status,
        dlq, attempts: attempts.objects.length, diagnosis,
      });
    }
    if (request.method !== "POST" || !["/claim", "/begin", "/finish", "/simulate-write"].includes(url.pathname)) {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (Number(request.headers.get("Content-Length")) > 1024) {
      return new Response("Too large", { status: 413 });
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!payload || typeof payload !== "object") return new Response("Invalid input", { status: 400 });
    const { show, jobId } = payload as Record<string, unknown>;
    if (!validShow(show) || !validJob(jobId)) return new Response("Invalid input", { status: 400 });

    const key = `m0/reservations/${show}`;
    const current = await readReservation(env, key);
    if (url.pathname === "/begin") {
      if (!current || current.value.jobId !== jobId) return adminJson({ result: "not-owner" }, 409);
      if (current.value.state === "processing") return adminJson({ result: "same-job" });
      if (current.value.state !== "held") return adminJson({ result: "conflict" }, 409);
      const written = await env.M0_BUCKET.put(key, JSON.stringify({ state: "processing", jobId }), {
        onlyIf: { etagMatches: current.etag },
      });
      return adminJson({ result: written ? "processing" : "conflict" }, written ? 200 : 409);
    }
    if (url.pathname === "/simulate-write") {
      const delayMs = (payload as Record<string, unknown>).delayMs;
      if (!Number.isInteger(delayMs) || typeof delayMs !== "number" || delayMs < 0 || delayMs > 8000) {
        return new Response("Invalid delay", { status: 400 });
      }
      if (current?.value.state !== "processing" || current.value.jobId !== jobId) {
        return adminJson({ result: "not-owner" }, 409);
      }
      await env.M0_BUCKET.put(`m0/simulation-start/${show}`, jobId);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await env.M0_BUCKET.put(`m0/unsafe-current/${show}`, jobId);
      return adminJson({ result: "written" });
    }
    if (url.pathname === "/finish") {
      if (!current || current.value.state !== "held" || current.value.jobId !== jobId) {
        return adminJson({ result: "not-owner" }, 409);
      }
      const written = await env.M0_BUCKET.put(key, JSON.stringify({ state: "free", jobId }), {
        onlyIf: { etagMatches: current.etag },
      });
      return adminJson({ result: written ? "released" : "conflict" }, written ? 200 : 409);
    }

    if (current && current.value.state !== "free") {
      return adminJson({ result: current.value.jobId === jobId ? "same-job" : "conflict" },
        current.value.jobId === jobId ? 200 : 409);
    }
    const condition = current
      ? { etagMatches: current.etag }
      : new Headers({ "If-None-Match": "*" });
    const written = await env.M0_BUCKET.put(key, JSON.stringify({ state: "held", jobId }), {
      onlyIf: condition,
    });
    return adminJson({ result: written ? "claimed" : "conflict" }, written ? 201 : 409);
  },

  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body;
      if (body && typeof body === "object" && "object" in body) {
        const detail = body.object;
        if (detail && typeof detail === "object" && "key" in detail && typeof detail.key === "string") {
          if (batch.queue === env.M0_DLQ) {
            await env.M0_BUCKET.put(`m0/dlq/${message.id}`, detail.key);
            const diag = parseDiagMarker(detail.key);
            if (diag) {
              await env.M0_BUCKET.put(`m0/diag/${diag.show}/${diag.jobId}/dlq`, detail.key);
            }
            const parts = detail.key.split("/");
            if (parts.length === 5 && parts[0] === "staging" && parts[1] === "shows" &&
              parts[2].startsWith("m0-gate-") && validShow(parts[2]) && validJob(parts[3]) &&
              parts[4] === "commit.json") {
              await env.M0_BUCKET.put(`m0/gate/${parts[2]}/${parts[3]}/dlq`, "delivered");
            }
            continue;
          }
          if (detail.key.startsWith("staging/shows/m0-diag-")) {
            await processDiagMarker(env, detail.key, message.attempts);
            continue;
          }
          if (detail.key.startsWith("staging/shows/m0-release-") ||
            detail.key.startsWith("staging/episodes/m0-release-")) {
            await processReleaseMarker(env, ctx, detail.key, message.attempts);
            continue;
          }
          if (detail.key.startsWith("staging/shows/m0-flow-") ||
            detail.key.startsWith("staging/episodes/m0-flow-")) {
            await processFlowMarker(env, detail.key);
            continue;
          }
          if (detail.key.startsWith("staging/shows/m0-gate-")) {
            await processGateMarker(env, detail.key, message.attempts);
            continue;
          }
          if (detail.key.startsWith("staging/shows/m0-retry-")) {
            await env.M0_BUCKET.put(`m0/attempts/${message.id}-${message.attempts}`, detail.key);
            if (detail.key.includes("m0-retry-always-") || message.attempts === 1) {
              throw new Error("M0 injected transient failure");
            }
          }
          if (detail.key.startsWith("staging/shows/m0-permanent-")) {
            await env.M0_BUCKET.put(`m0/status/${message.id}`, "invalid staged input");
            continue;
          }
          if (detail.key.startsWith("staging/shows/m0-recovery-")) {
            const [, , show, jobId] = detail.key.split("/");
            const reservation = await readReservation(env, `m0/reservations/${show}`);
            if (!reservation || reservation.value.state === "free" || reservation.value.jobId !== jobId) {
              await env.M0_BUCKET.put(`m0/rejected/${message.id}`, detail.key);
              continue;
            }
          }
          await env.M0_BUCKET.put(`m0/events/${message.id}`, detail.key);
          if (detail.key.startsWith("staging/shows/m0-cache-") && detail.key.endsWith("/commit.json")) {
            if (!ctx.cache) throw new Error("Workers Caching is unavailable in this handler");
            const purge = detail.key.startsWith("staging/shows/m0-cache-retry-") && message.attempts === 1
              ? { success: false, errors: [{ code: 9001, message: "M0 injected purge failure" }] }
              : await ctx.cache.purge({ tags: ["m0-feed", "m0-cover"] });
            await env.M0_BUCKET.put(`m0/cache-attempts/${message.id}-${message.attempts}.json`,
              JSON.stringify({ key: detail.key, success: purge.success }));
            await env.M0_BUCKET.put("m0/cache-purge-result.json", JSON.stringify({ success: purge.success, errors: purge.errors }));
            if (!purge.success) throw new Error("M0 cache purge failed");
          }
        }
      }
    }
  },
} satisfies ExportedHandler<Env>;
