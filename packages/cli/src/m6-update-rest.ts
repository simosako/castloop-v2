import { serviceAdmissionSchema } from "@castloop/shared";
import type { M6ServiceUpdateRequest } from "@castloop/shared";
import type { CloudflareApi } from "./cloudflare-api";
import type { M6UpdateEffects } from "./m6-service-update";

export function createM6UpdateRestEffects(api: CloudflareApi, controls: Pick<M6UpdateEffects, "begin" | "complete"> & {
  admission: () => Promise<unknown>;
}): M6UpdateEffects {
  const owner = async (request: M6ServiceUpdateRequest) => {
    const admission = serviceAdmissionSchema.parse(await controls.admission());
    if (admission.service_id !== request.service_id || admission.state !== "updating" || admission.mode !== "m6" ||
      admission.invocations.length || admission.url_change ||
      admission.pause_id !== request.pause_id || admission.generation !== request.expected_service_generation + 1 ||
      JSON.stringify(admission.update?.request) !== JSON.stringify(request) || admission.update?.target ||
      (admission.runtime_readiness ?? admission.readiness)?.worker_version_id !== request.previous_worker_version_id) {
      throw new Error("Compatible REST activation requires its exact admitted, undeployed service owner");
    }
    return admission;
  };
  const unchangedOwner = (request: M6ServiceUpdateRequest, before: Awaited<ReturnType<typeof owner>>) => async () => {
    if (JSON.stringify(await owner(request)) !== JSON.stringify(before)) throw new Error("Compatible update owner changed before activation");
  };
  return {
    begin: controls.begin,
    complete: controls.complete,
    deploy: async (config, request, source, metadata, receipts) => {
      const admission = await owner(request);
      const evidence = await api.uploadCompatibleM6Worker(config, request, source, metadata, receipts, unchangedOwner(request, admission));
      return { deployment_id: evidence.deployment_id, worker_version_id: evidence.worker_version_id };
    },
    activate: async (config, request, upload, previousDeploymentId, receipts) => {
      const admission = await owner(request);
      const evidence = await api.activateCompatibleM6Worker(config, request, upload, previousDeploymentId, receipts, unchangedOwner(request, admission));
      return { deployment_id: evidence.deployment_id, worker_version_id: evidence.worker_version_id };
    },
    verifyDeployment: async (config, request, upload, deployment) => {
      const admission = serviceAdmissionSchema.parse(await controls.admission());
      if (admission.state !== "updating" || JSON.stringify(admission.update?.request) !== JSON.stringify(request) || admission.update?.target) {
        throw new Error("Compatible verification requires its exact retained, unverified update owner");
      }
      const evidence = await api.verifyCompatibleM6WorkerDeployment(config, request, upload, deployment);
      return { deployment_id: evidence.deployment_id, worker_version_id: evidence.worker_version_id };
    },
  };
}
