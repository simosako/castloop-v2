import { WorkerEntrypoint } from "cloudflare:workers";
import { purgeLifecycleCache, serveCachedLifecycleAsset } from "./lifecycle-cache";
import type { LifecycleCacheEnv, LifecyclePurgeTarget } from "./lifecycle-cache";
import type { PublicCacheProps } from "./public-assets";
import { describeCachedDeliveryRuntime } from "./lifecycle-delivery-gate";
import type { CachedDeliveryRuntime } from "../packages/shared/src/index";

type CachedEntrypointEnv = LifecycleCacheEnv & { CASTLOOP_VERSION_METADATA: WorkerVersionMetadata };

export class CachedPublicAssets extends WorkerEntrypoint<CachedEntrypointEnv, PublicCacheProps> {
  async fetch(request: Request): Promise<Response> {
    return serveCachedLifecycleAsset(request, this.env, this.ctx.props);
  }

  async invalidate(target: LifecyclePurgeTarget): Promise<void> {
    await purgeLifecycleCache(this.ctx.cache, target);
  }

  async describeRuntime(): Promise<CachedDeliveryRuntime> {
    return describeCachedDeliveryRuntime(this.env.CASTLOOP_VERSION_METADATA, this.ctx.cache);
  }
}
