import { abandonReservedShowOperation, beginShowOperation, claimShowOperation, readShowControl } from "../../src/lifecycle-control";
import { parseShowControl, stringifyLifecycleToml, validateId } from "../../packages/shared/src/index";

type ProbeEnv = { CASTLOOP_BUCKET: R2Bucket; M6_SECRET: string };

function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function authenticated(request: Request, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const hashes = await Promise.all([secret, request.headers.get("X-M6-Key") ?? ""]
    .map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(hashes[0], hashes[1]);
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") return reply({ probe: "m6-admission-v1" });
    if (path !== "/admin" || request.method !== "POST") return reply({ error: "Not found" }, 404);
    if (!(await authenticated(request, env.M6_SECRET))) return reply({ error: "Unauthorized" }, 401);
    const input = await request.json<Record<string, unknown>>();
    if (input.action === "cleanup") {
      for (;;) {
        const page = await env.CASTLOOP_BUCKET.list({ limit: 100 });
        if (!page.objects.length) return reply({ cleaned: true });
        await env.CASTLOOP_BUCKET.delete(page.objects.map((object) => object.key));
      }
    }
    if (input.action === "object") {
      if (typeof input.key !== "string" || !/^probe\/[a-z0-9-]+$/.test(input.key)) return reply({ error: "Bad key" }, 400);
      const object = await env.CASTLOOP_BUCKET.get(input.key);
      return reply(object ? { etag: object.etag, size: object.size,
        text: object.size <= 1024 ? await object.text() : null } : { missing: true });
    }
    if (input.action === "fence") {
      if (typeof input.key !== "string" || !/^probe\/[a-z0-9-]+$/.test(input.key) || typeof input.etag !== "string") {
        return reply({ error: "Bad fence" }, 400);
      }
      const written = await env.CASTLOOP_BUCKET.put(input.key, "fenced", { onlyIf: { etagMatches: input.etag } });
      return reply(written ? { fenced: true, etag: written.etag } : { fenced: false });
    }
    const showId = validateId(String(input.show_id), "show");
    if (!showId.startsWith("probe-")) return reply({ error: "Only probe Shows are allowed" }, 400);
    try {
      switch (input.action) {
        case "seed":
          await env.CASTLOOP_BUCKET.put(`system/show-publications/${showId}.json`, JSON.stringify(parseShowControl({
            schema_version: 2, show_id: showId, lifecycle: "active", generation: 0, feed_generation: 0,
          })));
          await env.CASTLOOP_BUCKET.put(`system/episode-lifecycle/${showId}/first.toml`, stringifyLifecycleToml({
            schema_version: 1, show_id: showId, episode_id: "first", lifecycle: "active", generation: 0,
          }));
          return reply({ seeded: true });
        case "claim": return reply(await claimShowOperation(env, input.request));
        case "owner": return reply(await readShowControl(env, showId));
        case "begin":
        case "abandon":
        case "abandon-lost": {
          if (typeof input.job_id !== "string" || typeof input.generation !== "number") return reply({ error: "Bad owner" }, 400);
          const result = input.action === "begin"
            ? await beginShowOperation(env, showId, input.job_id, input.generation)
            : await abandonReservedShowOperation(env, showId, input.job_id, input.generation);
          return input.action === "abandon-lost" ? reply({ error: "Injected lost response" }, 503) : reply(result);
        }
        default: return reply({ error: "Unknown probe action" }, 400);
      }
    } catch (error) {
      return reply({ error: String(error) }, 409);
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
