import { serviceCapabilitiesSchema } from "../packages/shared/src/index";
import type { ServiceCapabilities } from "../packages/shared/src/index";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { readServiceAdmission } from "./service-admission";

export async function readServiceCapabilities(env: LifecycleControlEnv, serviceId: string,
  protocol: ServiceCapabilities["worker_protocol"] = "legacy_fenced"): Promise<ServiceCapabilities> {
  const snapshot = await readServiceAdmission(env, serviceId);
  const admission = snapshot ? { mode: snapshot.value.mode, state: snapshot.value.state, generation: snapshot.value.generation,
    active_invocations: snapshot.value.invocations.length, ...(snapshot.value.migration ? { migration_id: snapshot.value.migration.migration_id } : {}) } :
    { mode: "legacy" as const, state: "uninitialized" as const, active_invocations: 0 };
  return serviceCapabilitiesSchema.parse({ schema_version: 1, service_id: serviceId, worker_protocol: protocol,
    features: { service_mutation_fence: true, migration_controls: false, m6_staging: false, m6_publication: false,
      lifecycle_commands: false, lifecycle_delivery: protocol === "m6_candidate" }, admission,
    legacy_mutations_admitted: protocol === "legacy_fenced" && admission.mode === "legacy" && ["uninitialized", "open"].includes(admission.state), m6_ready: false });
}
