import { parseServiceConfig } from "../packages/shared/src/index";
import { createM6DeliveryGate } from "./lifecycle-delivery-gate";
import type { M6DeliveryGateBindings } from "./lifecycle-delivery-gate";
import type { LifecycleControlEnv } from "./lifecycle-control";
import type { LifecyclePurgeTarget } from "./lifecycle-cache";
import { withServiceInvocation } from "./service-admission";

export class M6ManagementServiceMismatch extends Error {
  constructor() { super("Management input targets another service"); }
}

export async function withM6ManagementInvocation<T>(env: LifecycleControlEnv, serviceId: string, kind: "m6_admin" | "m6_recovery",
  target: LifecyclePurgeTarget, bindings: M6DeliveryGateBindings, callback: () => Promise<T>): Promise<T> {
  const object = await env.CASTLOOP_BUCKET.get("system/service.toml");
  if (!object || object.size < 1 || object.size > 16384) throw new Error("Invalid service configuration");
  const config = parseServiceConfig(await object.text());
  if (config.service_id !== serviceId) throw new M6ManagementServiceMismatch();
  return withServiceInvocation(env, config.service_id, kind, async (invocation) => {
    const gate = createM6DeliveryGate(env, invocation, bindings);
    await gate(target);
    const result = await callback();
    await gate(target);
    return result;
  });
}
