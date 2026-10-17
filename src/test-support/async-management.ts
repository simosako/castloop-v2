import { m6ServiceConfigHash, signManagementIntent, stringifyToml } from "../../packages/shared/src/index";
import type { ManagementCommand, ManagementIntent } from "../../packages/shared/src/index";
import { queueM6Candidate } from "../m6-routes";
import type { M6CachedLoopback, M6CandidateEnv } from "../m6-routes";
import { publicationAdminFixture } from "./publication-admin";
import { stagingAdminFixture } from "./staging-admin";

export async function asyncManagementFixture(mode: "stage" | "show" | "episode" | "metadata" | "audio" = "stage") {
  const setup = mode === "stage" ? await stagingAdminFixture() : await publicationAdminFixture(mode);
  const windowId = crypto.randomUUID();
  const readiness = { operation_id: crypto.randomUUID(), deployment_id: crypto.randomUUID(), worker_version_id: setup.versionId,
    service_config_sha256: await m6ServiceConfigHash(setup.config), default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets",
    cutover_verified: true, publication_routes_verified: true, management_protocol: "queue-management-v1" };
  await setup.bucket.put("system/lifecycle-service.json", JSON.stringify({ schema_version: 1, service_id: setup.config.service_id,
    generation: 0, mode: "m6", state: "open", invocations: [], last_resumed_pause_id: windowId, runtime_readiness: readiness }));
  const cachedAssets: M6CachedLoopback = Object.assign(() => ({ fetch: async () => new Response() }), {
    invalidate: async () => {}, ...setup.bindings.cachedAssets,
  });
  const env: M6CandidateEnv = { ...setup.env, CASTLOOP_BUCKET: setup.bucket as never,
    CASTLOOP_VERSION_METADATA: { id: setup.versionId, tag: "", timestamp: "2026-10-15T00:00:00Z" },
    CASTLOOP_DLQ_NAME: setup.config.dlq_name, CASTLOOP_QUEUE: { send: async () => {} } as never };
  const intent = (command: ManagementCommand, requestId = crypto.randomUUID()) => signManagementIntent({ schema_version: 1,
    family: "management", protocol: "queue-management-v1", service_id: setup.config.service_id, request_id: requestId,
    worker_version_id: setup.versionId, service_config_sha256: readiness.service_config_sha256, admission_window_id: windowId, command }, "private-secret");
  const deliver = (body: ManagementIntent | unknown, dlq = false) => queueM6Candidate({ queue: dlq ? setup.config.dlq_name : setup.config.queue_name,
    messages: [{ id: crypto.randomUUID(), body, attempts: 1, timestamp: new Date() }] } as never, env, cachedAssets);
  const reader = { async read(key: string, maximum = 16384) {
    const object = await setup.bucket.get(key);
    if (!object) return null;
    if (!("text" in object)) throw new Error("Test object body is missing");
    if (object.size > maximum) throw new Error("Oversized test management object");
    return { source: await object.text(), etag: object.etag };
  } };
  return { ...setup, env, windowId, readiness, cachedAssets, intent, deliver, reader, stringifyToml };
}
