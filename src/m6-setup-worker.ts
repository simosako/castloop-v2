import { fetchM6ManagementIntegration, queueM6Candidate } from "./m6-routes";
import type { M6CandidateEnv } from "./m6-routes";
import { consumeM6SetupProbe } from "./m6-setup-queue";

export { CachedPublicAssets } from "./lifecycle-cached-entrypoint";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return fetchM6ManagementIntegration(request, env, ctx.exports.CachedPublicAssets, { setupRuntime: {
      defaultFetch: (input) => ctx.exports.default.fetch(input),
      cachedRuntime: () => ctx.exports.CachedPublicAssets.describeRuntime(),
      invalidate: (showId) => ctx.exports.CachedPublicAssets.invalidate({ showId }),
    } });
  },
  async queue(batch, env, ctx): Promise<void> {
    if (await consumeM6SetupProbe(batch, env)) return;
    await queueM6Candidate(batch, env, ctx.exports.CachedPublicAssets);
  },
} satisfies ExportedHandler<M6CandidateEnv, unknown>;
