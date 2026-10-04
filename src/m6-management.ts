import { cachedDeliveryRuntimeSchema, parseServiceConfig } from "../packages/shared/src/index";
import type { ServiceAdmission, ServiceConfig } from "../packages/shared/src/index";
import { createM6DeliveryGate } from "./lifecycle-delivery-gate";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import type { LifecycleControlEnv, LifecycleReadEnv } from "./lifecycle-control";
import type { LifecyclePurgeTarget } from "./lifecycle-cache";
import { readServiceAdmission, requireM6ServiceRuntime, withServiceInvocation } from "./service-admission";

export class M6ManagementServiceMismatch extends Error {
  constructor() { super("Management input targets another service"); }
}

export async function withM6ManagementInvocation<T>(env: LifecycleControlEnv, serviceId: string, kind: "m6_admin" | "m6_recovery",
  target: LifecyclePurgeTarget, bindings: M6DeliveryGateBindings, callback: () => Promise<T>): Promise<T> {
  const object = await env.CASTLOOP_BUCKET.get("system/service.toml");
  if (!object || object.size < 1 || object.size > 16384) throw new Error("Invalid service configuration");
  const config = parseServiceConfig(await object.text());
  if (config.service_id !== serviceId) throw new M6ManagementServiceMismatch();
  await requireM6ServiceRuntime(env, config.service_id, bindings.versionMetadata.id);
  return withServiceInvocation(env, config.service_id, kind, async (invocation) => {
    const gate = createM6DeliveryGate(env, invocation, bindings);
    await gate(target);
    const result = await callback();
    await gate(target);
    return result;
  });
}

export async function withM6ManagementRead<T>(env: LifecycleReadEnv, serviceId: string, bindings: M6DeliveryGateBindings,
  callback: (admission: ServiceAdmission, config: ServiceConfig) => Promise<T>): Promise<T> {
  const configObject = await env.CASTLOOP_BUCKET.get("system/service.toml");
  if (!configObject || configObject.size < 1 || configObject.size > 16384) throw new Error("Invalid service configuration");
  const config = parseServiceConfig(await configObject.text());
  if (config.service_id !== serviceId) throw new M6ManagementServiceMismatch();
  if (bindings.gatewayProtocol !== "m6-uncached-gateway-v1") throw new Error("Management preview requires the uncached gateway protocol");
  const snapshot = await requireM6ServiceRuntime(env, serviceId, bindings.versionMetadata.id);
  const readiness = snapshot.readiness;
  const checkRuntime = async () => {
    if (bindings.versionMetadata.id !== readiness.worker_version_id) throw new Error("Management preview has another executing Worker version");
    const cached = cachedDeliveryRuntimeSchema.parse(await bindings.cachedAssets.describeRuntime());
    if (cached.worker_version_id !== readiness.worker_version_id || cached.entrypoint !== readiness.cached_entrypoint) {
      throw new Error("Management preview has another cache owner");
    }
  };
  await checkRuntime();
  const result = await callback(snapshot.value, config);
  await checkRuntime();
  const current = await readServiceAdmission(env, serviceId);
  const currentConfig = await env.CASTLOOP_BUCKET.head("system/service.toml");
  if (!current || current.etag !== snapshot.etag || JSON.stringify(current.value) !== JSON.stringify(snapshot.value) ||
    !currentConfig || currentConfig.etag !== configObject.etag || currentConfig.size !== configObject.size) {
    throw new Error("Management snapshot changed during its read-only preview");
  }
  return result;
}
