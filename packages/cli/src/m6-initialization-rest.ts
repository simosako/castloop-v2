import type { M6RuntimeReadiness, M6RuntimeTarget, ServiceConfig } from "@castloop/shared";
import type { CloudflareApi } from "./cloudflare-api";
import type { FreshM6InitializationEffects } from "./m6-service-initialization";

export function createFreshM6RestEffects(api: CloudflareApi, adminKey: string,
  initialize: (config: ServiceConfig, target: M6RuntimeTarget) => Promise<M6RuntimeReadiness>): FreshM6InitializationEffects {
  return {
    createResources: (config) => api.createFreshM6Resources(config),
    deploy: async (config, source, metadata) => {
      const evidence = await api.uploadFreshM6Worker(config, source, adminKey, metadata);
      return { deployment_id: evidence.deployment_id, worker_version_id: evidence.worker_version_id };
    },
    initialize,
  };
}
