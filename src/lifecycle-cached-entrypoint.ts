import { WorkerEntrypoint } from "cloudflare:workers";
import { purgeLifecycleCache, serveCachedLifecycleAsset } from "./lifecycle-cache";
import type { LifecycleCacheEnv, LifecyclePurgeTarget } from "./lifecycle-cache";
import type { PublicCacheProps } from "./public-assets";

export class CachedPublicAssets extends WorkerEntrypoint<LifecycleCacheEnv, PublicCacheProps> {
  async fetch(request: Request): Promise<Response> {
    return serveCachedLifecycleAsset(request, this.env, this.ctx.props);
  }

  async invalidate(target: LifecyclePurgeTarget): Promise<void> {
    await purgeLifecycleCache(this.ctx.cache, target);
  }
}
