import worker from "./worker";
import type { M6CandidateEnv } from "./m6-routes";
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
    const response = await worker.fetch(request, env, ctx);
    if (!parsePublicAssetPath(new URL(request.url).pathname)) return response;
    const headers = new Headers(response.headers);
    headers.set("X-Castloop-Test-Gateway-Invocation", crypto.randomUUID());
    headers.set("X-Castloop-Test-Inner-Cache", response.headers.get("Cf-Cache-Status") ?? "absent");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async queue(batch, env, ctx): Promise<void> {
    await worker.queue(batch, env, ctx);
  },
} satisfies ExportedHandler<M6CandidateEnv, unknown>;
