import { fetchM6ManagementIntegration, queueM6Candidate } from "./m6-routes";
import type { M6CandidateEnv } from "./m6-routes";
import { consumeM6SetupProbe } from "./m6-setup-queue";
import { CachedPublicAssets as PublicAssetsEntrypoint } from "./lifecycle-cached-entrypoint";
import { parsePublicAssetPath } from "./public-assets";

export class CachedPublicAssets extends PublicAssetsEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("X-Castloop-Test-Cache-Invocation", crypto.randomUUID());
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const response = await fetchM6ManagementIntegration(request, env, ctx.exports.CachedPublicAssets, { setupRuntime: {
      defaultFetch: (input) => ctx.exports.default.fetch(input),
      cachedRuntime: () => ctx.exports.CachedPublicAssets.describeRuntime(),
      invalidate: (showId) => ctx.exports.CachedPublicAssets.invalidate({ showId }),
    } });
    if (!parsePublicAssetPath(new URL(request.url).pathname)) return response;
    const headers = new Headers(response.headers);
    headers.set("X-Castloop-Test-Gateway-Invocation", crypto.randomUUID());
    headers.set("X-Castloop-Test-Inner-Cache", response.headers.get("Cf-Cache-Status") ?? "absent");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async queue(batch, env, ctx): Promise<void> {
    if (await consumeM6SetupProbe(batch, env)) return;
    await queueM6Candidate(batch, env, ctx.exports.CachedPublicAssets);
  },
} satisfies ExportedHandler<M6CandidateEnv, unknown>;
