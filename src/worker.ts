import { fetchM6ManagementIntegration, queueM6Candidate } from "./m6-routes";
import type { M6CandidateEnv } from "./m6-routes";
import { consumeM6SetupProbe } from "./m6-setup-queue";
import { authenticated } from "./admin-auth";
import { parseQueueDelivery } from "./queue-delivery";
import { finishLocalTiming, localTimingEnvironment, localTimingSpan, LOCAL_TIMING_RUN } from "./local-timing";

export { CachedPublicAssets } from "./lifecycle-cached-entrypoint";

declare global {
  namespace Cloudflare {
    interface GlobalProps { mainModule: typeof import("./worker"); }
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const enabled = request.headers.get("X-Castloop-Local-Timing") === "1" && new URL(request.url).pathname.startsWith("/admin/") && authenticated(request, env.CASTLOOP_ADMIN_KEY);
    const timing = enabled ? localTimingEnvironment(env, new URL(request.url).pathname) : undefined;
    const measuredEnv = timing?.env ?? env;
    const response = await fetchM6ManagementIntegration(request, measuredEnv, ctx.exports.CachedPublicAssets, { setupRuntime: {
      defaultFetch: (input) => ctx.exports.default.fetch(input),
      cachedRuntime: () => ctx.exports.CachedPublicAssets.describeRuntime(),
      invalidate: (showId) => ctx.exports.CachedPublicAssets.invalidate({ showId }),
    } });
    if (!timing) return response;
    const report = finishLocalTiming(timing.trace);
    const headers = new Headers(response.headers);
    headers.set("X-Castloop-Local-Timing", btoa(report));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async queue(batch, env, ctx): Promise<void> {
    const timing = localTimingEnvironment(env, "queue", { queue: batch.queue,
      messages: batch.messages.map((message) => ({ id: message.id, timestamp_ms: message.timestamp.getTime(), attempts: message.attempts,
        key: parseQueueDelivery(message.body)?.key })) });
    let ok = false;
    try {
      if (await localTimingSpan(timing.env, "queue.setup_probe", () => consumeM6SetupProbe(batch, timing.env))) { ok = true; return; }
      await localTimingSpan(timing.env, "queue.candidate", () => queueM6Candidate(batch, timing.env, ctx.exports.CachedPublicAssets));
      ok = true;
    } finally {
      timing.trace.context.ok = ok;
      const report = finishLocalTiming(timing.trace);
      ctx.waitUntil(env.CASTLOOP_BUCKET.put(`system/diagnostics/local-timing/${LOCAL_TIMING_RUN}/${timing.trace.id}.json`, report,
        { httpMetadata: { contentType: "application/json" } }).then(() => undefined).catch(() => {
          console.error(JSON.stringify({ event: "local_timing_save_failed", id: timing.trace.id }));
        }));
    }
  },
} satisfies ExportedHandler<M6CandidateEnv, unknown>;
