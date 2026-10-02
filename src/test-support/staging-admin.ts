import { parseServiceConfig, serviceAdmissionSchema, stagePayloadKey, stageUploadRequestSchema, stringifyToml } from "../../packages/shared/src/index";
import type { StageAsset, StagingAdminRequest, StagingAdminResponse } from "../../packages/shared/src/index";
import { stagingAdminResponseSchema } from "../../packages/shared/src/index";
import { readShowControl } from "../lifecycle-control";
import { describeCachedDeliveryRuntime } from "../lifecycle-delivery-gate";
import { consumeOwnedPublication } from "../publication-consumer";
import { SERVICE_ADMISSION_KEY } from "../service-admission";
import { handleM6StagingAdmin } from "../staging-admin";
import type { StagingAdminEnv } from "../staging-admin";
import { publicationTestDigest } from "./episode-publication";
import { publicationFixture, PUBLICATION_SHOW_TEXT } from "./publication";
import { createHash } from "node:crypto";

export async function stagingAdminFixture(kind: "show" | "audio" | "episode_metadata" = "show") {
  const setup = await publicationFixture();
  await consumeOwnedPublication(setup.env, setup.key, { async checkDeliveryGate() {}, async purge() {} });
  const config = parseServiceConfig(setup.text("system/service.toml"));
  const versionId = crypto.randomUUID();
  const service = serviceAdmissionSchema.parse({ schema_version: 1, service_id: config.service_id, generation: 0, mode: "m6", state: "open",
    invocations: [], readiness: { migration_id: crypto.randomUUID(), plan_sha256: "a".repeat(64), deployment_id: crypto.randomUUID(),
      worker_version_id: versionId, completed_execution_id: crypto.randomUUID(), default_cache_disabled: true, cached_entrypoint: "CachedPublicAssets",
      old_cache_purged: true, cutover_verified: true, old_io_quiesced: true, publication_routes_verified: true } });
  await setup.bucket.put(SERVICE_ADMISSION_KEY, JSON.stringify(service));
  const contents: Array<{ asset: StageAsset; bytes: Uint8Array }> = kind === "show" ? [
    { asset: "show_metadata", bytes: new TextEncoder().encode(PUBLICATION_SHOW_TEXT) },
    { asset: "cover_jpg", bytes: Uint8Array.from([255, 216, 255, 2]) },
  ] : kind === "audio" ? [{ asset: "audio", bytes: Uint8Array.from([73, 68, 51, 1, 2, 3]) }] : [
    { asset: "episode_metadata", bytes: new TextEncoder().encode(stringifyToml({ schema_version: 1, episode_id: "next", guid: crypto.randomUUID(),
      title: "Private Episode title", description: "Private description", published_at: "2026-10-02T12:00:00Z" })) },
  ];
  const upload = stageUploadRequestSchema.parse({ schema_version: 1, operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(),
    show_id: "daily", kind: kind === "show" ? "show" : "episode", expected_show_generation: (await readShowControl(setup.env, "daily"))!.value.generation,
    ...(kind !== "show" ? { episode_id: "next", expected_episode_generation: 0 } : {}), created_at: "2026-10-02T12:00:00Z",
    payloads: contents.map(({ asset, bytes }) => ({ asset, length_bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })) });
  const operation = { show_id: upload.show_id, operation_id: upload.operation_id, show_generation: upload.expected_show_generation + 1 };
  const env: StagingAdminEnv = { CASTLOOP_BUCKET: setup.bucket, CASTLOOP_ADMIN_KEY: "private-secret" } as never;
  const bindings = { versionMetadata: { id: versionId }, gatewayProtocol: "m6-uncached-gateway-v1" as const,
    cachedAssets: { describeRuntime: async () => describeCachedDeliveryRuntime({ id: versionId }, { purge: async () => ({ success: true, errors: [] }) }) } };
  const input = <T extends StagingAdminRequest["action"]>(action: T, fields: Omit<Extract<StagingAdminRequest, { action: T }>, "schema_version" | "service_id" | "action">) =>
    ({ schema_version: 1, service_id: config.service_id, action, ...fields });
  const http = (body: unknown, secret = "private-secret", method = "POST") => new Request("https://current.example/admin/staging", {
    method, headers: { "X-Castloop-Key": secret }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  const call = async (body: unknown) => {
    const response = await handleM6StagingAdmin(http(body), env, bindings, { digest: publicationTestDigest });
    if (!response) throw new Error("Staging route was not handled");
    return response;
  };
  const success = async (body: unknown): Promise<StagingAdminResponse> => {
    const response = await call(body);
    if (response.status !== 200) throw new Error(`Staging API failed with HTTP ${response.status}`);
    return stagingAdminResponseSchema.parse(await response.json<unknown>());
  };
  return { ...setup, config, versionId, service, env, bindings, contents, upload, operation, input, http, call, success,
    putPayloads: async () => { for (const { asset, bytes } of contents) await setup.bucket.put(stagePayloadKey(upload, asset), bytes); } };
}
