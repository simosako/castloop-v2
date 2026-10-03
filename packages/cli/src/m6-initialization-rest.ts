import type { CloudflareApi } from "./cloudflare-api";
import type { FreshM6InitializationEffects } from "./m6-service-initialization";
import { M6SetupClient } from "./m6-setup-client";
import type { M6AdminTransport } from "./m6-admin-json";

export function createFreshM6RestEffects(api: CloudflareApi, adminKey: string,
  transport?: M6AdminTransport): FreshM6InitializationEffects {
  return {
    createResources: (config) => api.createFreshM6Resources(config),
    deploy: async (config, source, metadata) => {
      const evidence = await api.uploadFreshM6Worker(config, source, adminKey, metadata);
      return { deployment_id: evidence.deployment_id, worker_version_id: evidence.worker_version_id };
    },
    initialize: (config, target) => new M6SetupClient(config, adminKey, api, transport).initialize(target),
  };
}
