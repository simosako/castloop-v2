import { describe, expect, test } from "bun:test";
import { parseSqlitePublicationRequest, sqlitePublicationRequestHash, sqlitePublicationStatusSchema,
  sqliteUploadKey, sqliteVerifiedUploadSchema } from "./sqlite-publication";
import { sqlitePublicationRequest } from "../../../src/test-support/sqlite-publication";

const runtime = { service_id: "service", worker_version_id: crypto.randomUUID(), service_config_sha256: "a".repeat(64) };
const request = () => sqlitePublicationRequest(runtime, crypto.randomUUID());

describe("SQLite sequential publication protocol", () => {
  test("only explicit publication of verified unique uploads is accepted", () => {
    const value = request();
    expect(parseSqlitePublicationRequest(value)).toEqual(value);
    expect(() => parseSqlitePublicationRequest({ ...value, action: "upload-complete" })).toThrow();
    expect(() => parseSqlitePublicationRequest({ ...value, protocol: "queue-management-v1" })).toThrow();
    expect(() => parseSqlitePublicationRequest({ ...value, title: "private title" })).toThrow();
    expect(() => parseSqlitePublicationRequest({ ...value, payloads: [{ ...value.payloads[0], verified: false }, value.payloads[1]] })).toThrow();
  });

  test("upload keys are isolated by Show, draft and individual upload", () => {
    const identity = { show_id: "daily", draft_job_id: crypto.randomUUID(), upload_id: crypto.randomUUID(), asset: "audio" as const };
    const key = sqliteUploadKey(identity);
    expect(key).toBe(`staging/uploads/daily/${identity.draft_job_id}/${identity.upload_id}/audio.mp3`);
    expect(sqliteUploadKey({ ...identity, upload_id: crypto.randomUUID() })).not.toBe(key);
    expect(sqliteUploadKey({ ...identity, draft_job_id: crypto.randomUUID() })).not.toBe(key);
    expect(() => sqliteUploadKey({ ...identity, show_id: "../system" })).toThrow();
  });

  test("foreign upload paths and assets are not adopted", () => {
    const value = request();
    for (const key of ["system/service.toml", "public/podcasts/daily/feed.xml", value.payloads[0].key.replace("daily", "other")]) {
      expect(() => parseSqlitePublicationRequest({ ...value, payloads: [{ ...value.payloads[0], key }, value.payloads[1]] })).toThrow();
    }
    expect(() => parseSqlitePublicationRequest({ ...value, job_id: crypto.randomUUID() })).toThrow();
    expect(() => parseSqlitePublicationRequest({ ...value, payloads: [value.payloads[0], value.payloads[0]] })).toThrow();
  });

  test("initial Episode publication requires metadata and audio", () => {
    const value = request();
    expect(() => parseSqlitePublicationRequest({ ...value, payloads: [value.payloads[0]] })).toThrow();
    expect(() => parseSqlitePublicationRequest({ ...value, episode_id: undefined })).toThrow();
    for (const payload of value.payloads) {
      expect(parseSqlitePublicationRequest({ ...value, base_revision_id: crypto.randomUUID(), payloads: [payload] }).payloads).toHaveLength(1);
    }
  });

  test("Show publication binds metadata and exactly one cover", () => {
    const value = sqlitePublicationRequest(runtime, crypto.randomUUID(), { kind: "show" });
    expect(parseSqlitePublicationRequest(value).kind).toBe("show");
    expect(() => parseSqlitePublicationRequest({ ...value, episode_id: "first" })).toThrow();
    expect(() => parseSqlitePublicationRequest({ ...value, payloads: [value.payloads[0]] })).toThrow();
  });

  test("size, duration and receipt fields remain strict", () => {
    const audio = request().payloads[1];
    expect(sqliteVerifiedUploadSchema.safeParse({ ...audio, length_bytes: 300_000_000 }).success).toBe(true);
    for (const change of [{ length_bytes: 300_000_001 }, { length_bytes: 0 }, { duration_seconds: undefined },
      { duration_seconds: 1.5 }, { etag: "unsafe\nheader" }, { sha256: "invalid" }, { secret: "private" }]) {
      expect(sqliteVerifiedUploadSchema.safeParse({ ...audio, ...change }).success).toBe(false);
    }
    const metadata = request().payloads[0];
    expect(sqliteVerifiedUploadSchema.safeParse({ ...metadata, length_bytes: 1_000_001 }).success).toBe(false);
    expect(sqliteVerifiedUploadSchema.safeParse({ ...metadata, duration_seconds: 1 }).success).toBe(false);
  });

  test("hash binds the canonical strict request, independent of object property order", async () => {
    const value = request();
    expect(await sqlitePublicationRequestHash(value)).toBe(await sqlitePublicationRequestHash(
      Object.fromEntries(Object.entries(value).reverse()) as typeof value));
    expect(await sqlitePublicationRequestHash(value)).not.toBe(await sqlitePublicationRequestHash({ ...value, expected_show_state_version: 1 }));
  });

  test("failure and blocked codes cannot be copied onto successful records", async () => {
    const value = request();
    const status = { protocol: value.protocol, service_id: value.service_id, request_id: value.request_id, job_id: value.job_id,
      request_sha256: await sqlitePublicationRequestHash(value), sequence: 1, state: "queued" };
    expect(sqlitePublicationStatusSchema.safeParse(status).success).toBe(true);
    expect(sqlitePublicationStatusSchema.safeParse({ ...status, reason_code: "validation_failed" }).success).toBe(false);
    expect(sqlitePublicationStatusSchema.safeParse({ ...status, state: "failed", reason_code: "validation_failed" }).success).toBe(true);
    expect(sqlitePublicationStatusSchema.safeParse({ ...status, state: "blocked", reason_code: "validation_failed" }).success).toBe(false);
    expect(sqlitePublicationStatusSchema.safeParse({ ...status, state: "blocked", reason_code: "execution_interrupted" }).success).toBe(true);
    expect(sqlitePublicationStatusSchema.safeParse({ ...status, state: "blocked", reason_code: "arbitrary exception" }).success).toBe(false);
  });
});
