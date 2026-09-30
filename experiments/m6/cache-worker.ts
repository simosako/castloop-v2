import { WorkerEntrypoint } from "cloudflare:workers";
import { parseShowControl, stringifyLifecycleToml } from "../../packages/shared/src/index";
import { readPublicVisibility } from "../../src/lifecycle-control";

type ProbeEnv = { CASTLOOP_BUCKET: R2Bucket; M6_SECRET: string };
type ProbeProps = { generation: number };

declare global {
  namespace Cloudflare {
    interface GlobalProps { mainModule: typeof import("./cache-worker"); }
  }
}

const ROOT = "/podcasts/probe/";
const SHOW_KEY = "system/show-publications/probe.json";
const EPISODE_KEY = "system/episode-lifecycle/probe/first.toml";
const PUBLIC_PATHS = new Set([`${ROOT}feed.xml`, `${ROOT}cover.png`,
  `${ROOT}episodes/first/r1.mp3`, `${ROOT}episodes/first/r2.mp3`]);

function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function authorized(request: Request, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const hashes = await Promise.all([request.headers.get("X-M6-Key") ?? "", secret]
    .map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(hashes[0], hashes[1]);
}

export class CachedMedia extends WorkerEntrypoint<ProbeEnv, ProbeProps> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!PUBLIC_PATHS.has(path)) return reply({ error: "Not found" }, 404);
    const object = await this.env.CASTLOOP_BUCKET.get(`public${path}`);
    if (!object) return reply({ error: "Not found" }, 404);
    const callId = crypto.randomUUID();
    if (path.endsWith("/r2.mp3")) {
      const pause = await this.env.CASTLOOP_BUCKET.get("probe/pause");
      if (pause) {
        const token = await pause.text();
        await this.env.CASTLOOP_BUCKET.put(`probe/started/${token}`, callId);
        const deadline = Date.now() + 20000;
        while (!(await this.env.CASTLOOP_BUCKET.head(`probe/release/${token}`))) {
          if (Date.now() >= deadline) return reply({ error: "Pause timed out" }, 503);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
    return new Response(request.method === "HEAD" ? null : object.body, { headers: {
      "Content-Type": path.endsWith(".mp3") ? "audio/mpeg" : path.endsWith(".png") ? "image/png" : "application/rss+xml",
      "Content-Length": String(object.size), "ETag": object.httpEtag, "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=300, must-revalidate",
      ...(path.endsWith("/r1.mp3") ? {} : { "Cache-Tag": "m6-probe" }), "X-Inner-ID": callId,
      "X-Inner-Range": request.headers.get("Range") ?? "absent",
      "X-Inner-Generation": String(this.ctx.props.generation),
    } });
  }

  async invalidate(mode: "tag" | "path" = "tag"): Promise<CachePurgeResult> {
    if (!this.ctx.cache) throw new Error("Cached entrypoint has no purge API");
    return this.ctx.cache.purge(mode === "tag" ? { tags: ["m6-probe"] } : { pathPrefixes: [`${ROOT}episodes/first/`] });
  }
}

async function admin(request: Request, env: ProbeEnv, ctx: ExecutionContext): Promise<Response> {
  if (!(await authorized(request, env.M6_SECRET))) return reply({ error: "Unauthorized" }, 401);
  const input = await request.json<Record<string, unknown>>();
  switch (input.action) {
    case "seed": {
      const data = Uint8Array.from({ length: 65536 }, (_, index) => index % 251);
      for (const path of PUBLIC_PATHS) await env.CASTLOOP_BUCKET.put(`public${path}`, data);
      await env.CASTLOOP_BUCKET.put("system/show-reservations/probe.json", "{}");
      await env.CASTLOOP_BUCKET.put(SHOW_KEY, JSON.stringify(parseShowControl({
        schema_version: 2, show_id: "probe", lifecycle: "active", generation: 0, feed_generation: 0,
      })));
      await env.CASTLOOP_BUCKET.put(EPISODE_KEY, stringifyLifecycleToml({
        schema_version: 1, show_id: "probe", episode_id: "first", lifecycle: "active", generation: 0,
      }));
      return reply({ seeded: true });
    }
    case "show": {
      const object = await env.CASTLOOP_BUCKET.get(SHOW_KEY);
      if (!object) return reply({ error: "Missing Show" }, 409);
      const current = parseShowControl(await object.json());
      const next = parseShowControl({ ...current, lifecycle: input.lifecycle,
        generation: input.bump === true ? current.generation + 1 : current.generation });
      await env.CASTLOOP_BUCKET.put(SHOW_KEY, JSON.stringify(next));
      return reply(next);
    }
    case "episode": {
      if (input.lifecycle !== "active" && input.lifecycle !== "unpublished" && input.lifecycle !== "deleted") {
        return reply({ error: "Bad state" }, 400);
      }
      await env.CASTLOOP_BUCKET.put(EPISODE_KEY, stringifyLifecycleToml({ schema_version: 1,
        show_id: "probe", episode_id: "first", lifecycle: input.lifecycle, generation: 0 }));
      return reply({ changed: true });
    }
    case "payload": {
      if (typeof input.byte !== "number" || !Number.isInteger(input.byte) || input.byte < 0 || input.byte > 255) {
        return reply({ error: "Bad byte" }, 400);
      }
      await env.CASTLOOP_BUCKET.put(`public${ROOT}feed.xml`, new Uint8Array(65536).fill(input.byte));
      return reply({ changed: true });
    }
    case "purge-outer": return reply(ctx.cache ? await ctx.cache.purge({ tags: ["m6-probe"] }) : { available: false });
    case "purge-inner": return reply(await ctx.exports.CachedMedia.invalidate());
    case "purge-prefix": return reply(await ctx.exports.CachedMedia.invalidate("path"));
    case "corrupt":
      await env.CASTLOOP_BUCKET.put(SHOW_KEY, "invalid json");
      return reply({ changed: true });
    case "pause": {
      const token = crypto.randomUUID();
      await env.CASTLOOP_BUCKET.put("probe/pause", token);
      return reply({ token });
    }
    case "started": return reply({ started: Boolean(await env.CASTLOOP_BUCKET.head(`probe/started/${input.token}`)) });
    case "release":
      await env.CASTLOOP_BUCKET.put(`probe/release/${input.token}`, "released");
      await env.CASTLOOP_BUCKET.delete("probe/pause");
      return reply({ released: true });
    case "cleanup": {
      let deleted = 0;
      for (;;) {
        const objects = await env.CASTLOOP_BUCKET.list({ limit: 100 });
        if (!objects.objects.length) break;
        await env.CASTLOOP_BUCKET.delete(objects.objects.map((object) => object.key));
        deleted += objects.objects.length;
      }
      return reply({ deleted });
    }
    default: return reply({ error: "Unknown probe action" }, 400);
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") return reply({ probe: "m6-cache-v1" });
    if (path === "/admin" && request.method === "POST") return admin(request, env, ctx);
    if (!PUBLIC_PATHS.has(path)) return reply({ error: "Not found" }, 404);
    if (request.method !== "GET" && request.method !== "HEAD") return reply({ error: "Method not allowed" }, 405);
    const gatewayId = crypto.randomUUID();
    try {
      const visibility = await readPublicVisibility(env, "probe", path.includes("/episodes/") ? "first" : undefined);
      if (visibility !== "public") return reply({ visibility }, visibility === "gone" ? 410 : 404);
      const object = await env.CASTLOOP_BUCKET.get(SHOW_KEY);
      if (!object) throw new Error("Show record disappeared");
      const control = parseShowControl(await object.json());
      if (control.lifecycle !== "active") return reply({ visibility: "not_found" }, 404);
      const url = new URL(request.url);
      url.search = "";
      const forwarded = new Request(url, { method: request.method, headers: request.headers });
      forwarded.headers.delete("Authorization");
      forwarded.headers.delete("Cookie");
      const response = await ctx.exports.CachedMedia({ props: { generation: control.generation } }).fetch(forwarded);
      const headers = new Headers(response.headers);
      headers.set("X-Gateway-ID", gatewayId);
      headers.set("X-Inner-Cache", response.headers.get("Cf-Cache-Status") ?? "absent");
      headers.set("Cache-Control", "no-store");
      headers.delete("CDN-Cache-Control");
      headers.delete("Cloudflare-CDN-Cache-Control");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      console.error(JSON.stringify({ event: "m6-gateway-failure", message: String(error) }));
      return reply({ error: "Visibility unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
