import { serviceAdmissionSchema } from "@castloop/shared";
import type { CloudflareApi } from "./cloudflare-api";
import type { M6UpdateEffects } from "./m6-service-update";

export function createM6UpdateRestEffects(api: CloudflareApi, controls: Pick<M6UpdateEffects, "begin" | "complete"> & {
  admission: () => Promise<unknown>;
}): M6UpdateEffects {
  return {
    begin: controls.begin,
    complete: controls.complete,
    deploy: async (config, request, source, metadata) => {
      const admission = serviceAdmissionSchema.parse(await controls.admission());
      if (admission.state !== "updating" || JSON.stringify(admission.update?.request) !== JSON.stringify(request) || admission.update?.target) {
        throw new Error("Compatible REST upload requires its exact admitted, undeployed service owner");
      }
      const evidence = await api.uploadCompatibleM6Worker(config, request, source, metadata);
      return { deployment_id: evidence.deployment_id, worker_version_id: evidence.worker_version_id };
    },
  };
}
