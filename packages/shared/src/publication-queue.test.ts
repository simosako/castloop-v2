import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { MAX_PUBLICATION_INTENT_BYTES, parsePublicationCommitIntent, publicationCommitIntentPayloadSchema,
  publicationIntentHash, publicationQueuedReceiptSchema, signPublicationCommitIntent, verifyPublicationCommitIntent } from "./publication-queue";

const payload = () => publicationCommitIntentPayloadSchema.parse({ schema_version: 1, family: "publication_commit", commit_protocol: "queue-commit-v1",
  action: "commit", service_id: "test-service", submission_id: crypto.randomUUID(), operation: {
    show_id: "test-show", job_id: crypto.randomUUID(), show_generation: 1 }, manifest_sha256: "a".repeat(64), request_sha256: "b".repeat(64),
  worker_version_id: crypto.randomUUID(), service_config_sha256: "c".repeat(64) });

test("Queue intent uses a domain-separated canonical HMAC compatible with independent clients", async () => {
  const input = payload();
  const intent = await signPublicationCommitIntent(input, "test-key");
  expect(intent.mac).toBe(createHmac("sha256", "test-key").update(`castloop/publication-commit/queue-commit-v1\n${JSON.stringify(input)}`).digest("hex"));
  expect(await verifyPublicationCommitIntent(intent, "test-key")).toEqual(intent);
  expect(await verifyPublicationCommitIntent(Object.fromEntries(Object.entries(intent).reverse()), "test-key")).toEqual(intent);
  expect(await verifyPublicationCommitIntent(intent, "another-key")).toBeNull();
  expect(Buffer.byteLength(JSON.stringify(intent))).toBeLessThan(MAX_PUBLICATION_INTENT_BYTES);
  expect(await publicationIntentHash(intent)).toMatch(/^[a-f0-9]{64}$/);
});

test("Queue intent binds all identities and rejects unknown fields, versions, payload text and secrets", async () => {
  const intent = await signPublicationCommitIntent(payload(), "test-key");
  for (const patch of [{ service_id: "other" }, { submission_id: crypto.randomUUID() }, { manifest_sha256: "d".repeat(64) },
    { request_sha256: "e".repeat(64) }, { worker_version_id: crypto.randomUUID() }, { service_config_sha256: "f".repeat(64) },
    { operation: { ...intent.operation, show_id: "other" } }, { operation: { ...intent.operation, job_id: crypto.randomUUID() } },
    { operation: { ...intent.operation, show_generation: 2 } }, { action: "claim" }, { family: "lifecycle" }, { commit_protocol: "unknown" },
    { schema_version: 2 }, { title: "private" }, { api_token: "secret" }, { audio: "x".repeat(8192) }]) {
    expect(await verifyPublicationCommitIntent({ ...intent, ...patch }, "test-key")).toBeNull();
  }
  expect(() => parsePublicationCommitIntent({ ...intent, operation: { ...intent.operation, show_generation: Number.MAX_SAFE_INTEGER + 1 } })).toThrow();
  await expect(signPublicationCommitIntent(payload(), "")).rejects.toThrow("administrator key");
});

test("queued receipt is not an accepted commit marker or publication success receipt", async () => {
  const intent = await signPublicationCommitIntent(payload(), "test-key");
  const receipt = { schema_version: 1, result: "queued", commit_protocol: "queue-commit-v1", service_id: intent.service_id,
    submission_id: intent.submission_id, operation: intent.operation, manifest_sha256: intent.manifest_sha256,
    intent_sha256: await publicationIntentHash(intent), queue_id: "1".repeat(32) };
  expect(publicationQueuedReceiptSchema.parse(receipt).result).toBe("queued");
  for (const patch of [{ result: "accepted" }, { key: "staging/shows/test-show/commit.json" }, { created: true }, { staging_verified: true }]) {
    expect(publicationQueuedReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(false);
  }
});
