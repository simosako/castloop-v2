import { describe, expect, test } from "bun:test";
import { episodeCommitSchema, parseEpisodeDraft, parseServiceConfig, parseShowMetadata,
  stringifyToml, validateId } from "./index";

const show = {
  schema_version: 1 as const, show_id: "daily-show", title: "Daily", description: "Description",
  language: "ja", author: "Author", owner_name: "Owner", owner_email: "owner@example.com",
  categories: ["Technology"], explicit: false, site_url: "https://example.com/podcast",
  image_path: "cover.jpg",
};

describe("M1 TOML metadata", () => {
  test("round trips draft input and rejects unknown or generated publication fields", () => {
    expect(parseShowMetadata(stringifyToml(show))).toEqual(show);
    expect(() => parseShowMetadata(stringifyToml(show) + "revision_id = \"old\"\n")).toThrow();
    expect(() => parseShowMetadata(stringifyToml({ ...show, site_url: "not-a-url" }))).toThrow();
  });

  test("accepts explicit RFC3339 offsets, rejects impossible dates and TOML native datetime", () => {
    const input = { schema_version: 1 as const, episode_id: "first", guid: crypto.randomUUID(),
      title: "First", description: "Description", published_at: "2026-02-28T23:59:59+09:00" };
    expect(parseEpisodeDraft(stringifyToml(input)).published_at).toBe(input.published_at);
    expect(() => parseEpisodeDraft(stringifyToml({ ...input, published_at: "2026-02-30T12:00:00Z" }))).toThrow();
    expect(() => parseEpisodeDraft(stringifyToml(input).replace('"2026-02-28T23:59:59+09:00"',
      "2026-02-28T23:59:59+09:00"))).toThrow();
  });

  test("service configuration is strict and IDs have their documented boundaries", () => {
    const config = { schema_version: 1 as const, service_id: "castloop", account_id: "a".repeat(32),
      bucket_name: "castloop-demo-bucket", worker_name: "castloop-demo-worker",
      queue_name: "castloop-demo-queue", dlq_name: "castloop-demo-dlq",
      public_base_url: "https://castloop-demo-worker.example.workers.dev" };
    expect(parseServiceConfig(stringifyToml(config))).toEqual(config);
    expect(() => parseServiceConfig(stringifyToml(config) + "token = \"secret\"\n")).toThrow();
    expect(validateId("a".repeat(32), "show")).toBe("a".repeat(32));
    expect(() => validateId("a".repeat(33), "show")).toThrow();
    expect(() => validateId("a--b", "show")).toThrow();
  });
});

test("Episode commits require both inputs initially and at least one input for revisions", () => {
  const base = { schema_version: 1, kind: "episode", show_id: "daily-show", episode_id: "first",
    job_id: crypto.randomUUID(), committed_at: "2026-09-24T01:05:00Z" };
  const metadata_sha256 = "a".repeat(64);
  const audio = { audio_sha256: "b".repeat(64), audio_length_bytes: 123, duration_seconds: 5 };
  expect(episodeCommitSchema.safeParse({ ...base, metadata_sha256, ...audio }).success).toBe(true);
  expect(episodeCommitSchema.safeParse({ ...base, metadata_sha256 }).success).toBe(false);
  expect(episodeCommitSchema.safeParse({ ...base, ...audio }).success).toBe(false);
  const base_revision_id = crypto.randomUUID();
  expect(episodeCommitSchema.safeParse({ ...base, base_revision_id, metadata_sha256 }).success).toBe(true);
  expect(episodeCommitSchema.safeParse({ ...base, base_revision_id, ...audio }).success).toBe(true);
  expect(episodeCommitSchema.safeParse({ ...base, base_revision_id }).success).toBe(false);
  expect(episodeCommitSchema.safeParse({ ...base, base_revision_id, audio_sha256: "b".repeat(64) }).success)
    .toBe(false);
});
