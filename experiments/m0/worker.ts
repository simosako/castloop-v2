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

function adminJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
            const parts = detail.key.split("/");
            if (parts.length === 5 && parts[0] === "staging" && parts[1] === "shows" &&
              parts[2].startsWith("m0-gate-") && validShow(parts[2]) && validJob(parts[3]) &&
              parts[4] === "commit.json") {
              await env.M0_BUCKET.put(`m0/gate/${parts[2]}/${parts[3]}/dlq`, "delivered");
            }
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
