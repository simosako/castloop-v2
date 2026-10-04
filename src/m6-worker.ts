import { fetchM6Candidate, queueM6Candidate } from "./m6-routes";
import type { M6CandidateEnv } from "./m6-routes";
import { migrationBootstrapRequestSchema } from "../packages/shared/src/index";

export { CachedPublicAssets } from "./lifecycle-cached-entrypoint";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const bootstrapId = migrationBootstrapRequestSchema.shape.bootstrap_id.safeParse(env.CASTLOOP_VERSION_METADATA.tag);
    return fetchM6Candidate(request, env, ctx.exports.CachedPublicAssets, {
      workerVersionId: env.CASTLOOP_VERSION_METADATA.id, protocol: "m6_candidate",
      ...(bootstrapId.success ? { workerBootstrapId: bootstrapId.data } : {}),
      cachedRuntime: () => ctx.exports.CachedPublicAssets.describeRuntime(),
      defaultFetch: (input) => ctx.exports.default.fetch(input),
    });
  },
  async queue(batch, env, ctx): Promise<void> {
    await queueM6Candidate(batch, env, ctx.exports.CachedPublicAssets);
  },
} satisfies ExportedHandler<M6CandidateEnv, unknown>;
