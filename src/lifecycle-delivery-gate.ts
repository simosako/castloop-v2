import { cachedDeliveryRuntimeSchema, validateId } from "../packages/shared/src/index";
import type { CachedDeliveryRuntime, ServiceAdmission } from "../packages/shared/src/index";
import type { LifecyclePurgeTarget } from "./lifecycle-cache";
import type { LifecycleControlEnv } from "./lifecycle-control";
import { readServiceAdmission } from "./service-admission";
import type { ServiceInvocation } from "./service-admission";

export type M6DeliveryGateBindings = {
  versionMetadata: Pick<WorkerVersionMetadata, "id">;
  gatewayProtocol: "m6-uncached-gateway-v1";
  cachedAssets: { describeRuntime: () => Promise<unknown> };
};

export function describeCachedDeliveryRuntime(versionMetadata: Pick<WorkerVersionMetadata, "id"> | undefined,
  cache: Pick<CacheContext, "purge"> | undefined): CachedDeliveryRuntime {
  if (!cache || typeof cache.purge !== "function") throw new Error("Cached entrypoint has no Workers Cache purge API");
  return cachedDeliveryRuntimeSchema.parse({ schema_version: 1, protocol: "m6-cached-assets-v1", entrypoint: "CachedPublicAssets",
    worker_version_id: versionMetadata?.id, purge_api_available: true });
}

async function requireRuntimeAdmission(env: LifecycleControlEnv, invocation: ServiceInvocation,
  bindings: M6DeliveryGateBindings): Promise<NonNullable<ServiceAdmission["readiness"]>> {
  if (!["m6_admin", "m6_consumer", "m6_recovery"].includes(invocation.kind)) throw new Error("M6 delivery requires a registered M6 invocation");
  if (bindings.gatewayProtocol !== "m6-uncached-gateway-v1") throw new Error("M6 delivery requires the uncached gateway protocol");
  const snapshot = await readServiceAdmission(env, invocation.serviceId);
  if (!snapshot || snapshot.value.mode !== "m6" || snapshot.value.state === "migrating" || !snapshot.value.readiness) {
    throw new Error("M6 delivery requires completed service migration readiness");
  }
  if (!snapshot.value.invocations.some((item) => item.token === invocation.token && item.kind === invocation.kind)) {
    throw new Error("M6 delivery invocation no longer owns its service token");
  }
  if (snapshot.value.readiness.worker_version_id !== bindings.versionMetadata?.id) {
    throw new Error("Executing Worker version does not match verified M6 cutover");
  }
  return snapshot.value.readiness;
}

export function createM6DeliveryGate(env: LifecycleControlEnv, invocation: ServiceInvocation,
  bindings: M6DeliveryGateBindings): (target: LifecyclePurgeTarget) => Promise<void> {
  return async (target) => {
    validateId(target.showId, "show");
    if (target.episodeId !== undefined) validateId(target.episodeId, "episode");
    const readiness = await requireRuntimeAdmission(env, invocation, bindings);
    const cached = cachedDeliveryRuntimeSchema.parse(await bindings.cachedAssets.describeRuntime());
    if (cached.worker_version_id !== readiness.worker_version_id || cached.entrypoint !== readiness.cached_entrypoint) {
      throw new Error("Cache owner runtime does not match verified M6 gateway");
    }
    const current = await requireRuntimeAdmission(env, invocation, bindings);
    if (JSON.stringify(current) !== JSON.stringify(readiness)) throw new Error("M6 runtime readiness changed during the delivery gate");
  };
}
