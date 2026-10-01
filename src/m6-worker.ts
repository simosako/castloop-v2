import { fetchM6Candidate, queueM6Candidate } from "./m6-routes";
import type { M6CandidateEnv } from "./m6-routes";

export { CachedPublicAssets } from "./lifecycle-cached-entrypoint";

declare global {
  namespace Cloudflare {
    interface GlobalProps { mainModule: typeof import("./m6-worker"); }
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return fetchM6Candidate(request, env, ctx.exports.CachedPublicAssets, {
      workerVersionId: env.CASTLOOP_VERSION_METADATA.id, protocol: "m6_candidate",
      cachedRuntime: () => ctx.exports.CachedPublicAssets.describeRuntime(),
      defaultFetch: (input) => ctx.exports.default.fetch(input),
    });
  },
  async queue(batch, env, ctx): Promise<void> {
    await queueM6Candidate(batch, env, ctx.exports.CachedPublicAssets);
  },
} satisfies ExportedHandler<M6CandidateEnv, unknown>;
