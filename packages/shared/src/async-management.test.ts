import { expect, test } from "bun:test";
import { managementResultPayloadSchema, signManagementIntent, signManagementResult, verifyManagementIntent, verifyManagementResult } from "./async-management";
import { createHmac } from "node:crypto";

function payload() {
  return { schema_version: 1 as const, family: "management" as const, protocol: "queue-management-v1" as const,
    service_id: "service", request_id: crypto.randomUUID(), worker_version_id: crypto.randomUUID(), service_config_sha256: "a".repeat(64),
    admission_window_id: crypto.randomUUID(), command: { action: "stage-start" as const, upload: { schema_version: 1 as const,
      operation_id: crypto.randomUUID(), draft_job_id: crypto.randomUUID(), show_id: "daily", kind: "episode" as const,
      episode_id: "first", expected_show_generation: 0, expected_episode_generation: 0, created_at: "2026-10-15T00:00:00Z",
      payloads: [{ asset: "audio" as const, length_bytes: 300_000_000, sha256: "b".repeat(64) }] } } };
}
test("management intents authenticate exact window, action, identity and manifest without content or secrets", async () => {
  const signed = await signManagementIntent(payload(), "secret");
  const { mac, ...canonical } = signed;
  expect(mac).toBe(createHmac("sha256", "secret").update(`castloop/queue-management-v1/intent\n${JSON.stringify(canonical)}`).digest("hex"));
  expect(await verifyManagementIntent(signed, "secret")).toEqual(signed);
  expect(await verifyManagementIntent(signed, "wrong")).toBeNull();
  expect(await verifyManagementIntent({ ...signed, admission_window_id: crypto.randomUUID() }, "secret")).toBeNull();
  expect(await verifyManagementIntent({ ...signed, command: { ...signed.command, title: "private" } }, "secret")).toBeNull();
  expect(await verifyManagementIntent({ ...signed, family: "publication_commit" }, "secret")).toBeNull();
  expect(JSON.stringify(signed)).not.toContain("secret");
});
test("signed compact results cannot be swapped across requests or used as an unauthenticated grant", async () => {
  const intent = await signManagementIntent(payload(), "secret");
  const { managementIntentHash } = await import("./async-management");
  const result = await signManagementResult({ schema_version: 1, protocol: "queue-management-v1", service_id: "service",
    request_id: intent.request_id, intent_sha256: await managementIntentHash(intent), action: "stage-start", state: "granted",
    payloads: [{ key: "staging/episodes/daily/first/draft/audio.mp3", length: 300_000_000, sha256: "b".repeat(64) }] }, "secret");
  const { mac, ...canonical } = result;
  expect(mac).toBe(createHmac("sha256", "secret").update(`castloop/queue-management-v1/result\n${JSON.stringify(canonical)}`).digest("hex"));
  expect(await verifyManagementResult(result, intent, "secret")).toEqual(result);
  await expect(verifyManagementResult({ ...result, state: "pending", payloads: undefined }, intent, "secret")).rejects.toThrow();
  await expect(verifyManagementResult(result, await signManagementIntent(payload(), "secret"), "secret")).rejects.toThrow();
  expect(managementResultPayloadSchema.safeParse({ ...result, mac: undefined, state: "published" }).success).toBe(false);
});
