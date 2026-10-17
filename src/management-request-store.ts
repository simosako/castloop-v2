import { managementIntentHash, managementOperationId, managementRequestPrefix, parseManagementIntent,
  signManagementResult, verifyManagementResult } from "../packages/shared/src/index";
import type { ManagementIntent, ManagementResult, ManagementResultPayload } from "../packages/shared/src/index";
import type { LifecycleControlEnv } from "./lifecycle-control";

export class ManagementRequestConflict extends Error {
  constructor() { super("Management request ID or operation already has another frozen request"); }
}

export async function readManagementResult(env: LifecycleControlEnv, intent: ManagementIntent, secret: string): Promise<ManagementResult | null> {
  const object = await env.CASTLOOP_BUCKET.get(`${managementRequestPrefix(intent.request_id)}/result.json`);
  if (!object) return null;
  if (object.size < 1 || object.size > 16384) { await object.body?.cancel(); throw new ManagementRequestConflict(); }
  return verifyManagementResult(await object.json<unknown>(), intent, secret);
}

export async function retainManagementRequest(env: LifecycleControlEnv, intent: ManagementIntent, secret: string): Promise<ManagementResult> {
  const key = `${managementRequestPrefix(intent.request_id)}/intent.json`;
  const written = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(intent), { onlyIf: { etagDoesNotMatch: "*" } });
  if (!written) {
    const object = await env.CASTLOOP_BUCKET.get(key);
    if (!object || object.size < 1 || object.size > 16384) { await object?.body?.cancel(); throw new ManagementRequestConflict(); }
    if (await managementIntentHash(parseManagementIntent(await object.json<unknown>())) !== await managementIntentHash(intent)) {
      throw new ManagementRequestConflict();
    }
  }
  return await readManagementResult(env, intent, secret) ?? writeManagementResult(env, intent, secret, { state: "pending" });
}

export async function bindManagementOperation(env: LifecycleControlEnv, intent: ManagementIntent): Promise<void> {
  const id = managementOperationId(intent.command);
  const key = `system/jobs/${id}/management-${intent.command.action}.json`;
  const value = { request_id: intent.request_id, intent_sha256: await managementIntentHash(intent) };
  const written = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(value), { onlyIf: { etagDoesNotMatch: "*" } });
  if (written) return;
  const object = await env.CASTLOOP_BUCKET.get(key);
  if (!object || object.size < 1 || object.size > 1024 || JSON.stringify(await object.json<unknown>()) !== JSON.stringify(value)) {
    await object?.body?.cancel();
    throw new ManagementRequestConflict();
  }
}

export async function writeManagementResult(env: LifecycleControlEnv, intent: ManagementIntent, secret: string,
  result: Pick<ManagementResultPayload, "state" | "payloads" | "reason_code">): Promise<ManagementResult> {
  const key = `${managementRequestPrefix(intent.request_id)}/result.json`;
  const object = await env.CASTLOOP_BUCKET.get(key);
  if (object && (object.size < 1 || object.size > 16384)) { await object.body?.cancel(); throw new ManagementRequestConflict(); }
  const previous = object ? await verifyManagementResult(await object.json<unknown>(), intent, secret) : null;
  if (previous && previous.state !== "pending") {
    if (previous.state === result.state && previous.reason_code === result.reason_code &&
      JSON.stringify(previous.payloads) === JSON.stringify(result.payloads)) return previous;
    throw new ManagementRequestConflict();
  }
  const value = await signManagementResult({ schema_version: 1, protocol: "queue-management-v1", service_id: intent.service_id,
    request_id: intent.request_id, intent_sha256: await managementIntentHash(intent), action: intent.command.action, ...result }, secret);
  const written = await env.CASTLOOP_BUCKET.put(key, JSON.stringify(value), {
    onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
  });
  if (!written) throw new Error("Management result write conflicted; retain the exact request without replaying mutations");
  return value;
}
