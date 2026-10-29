import { expect, test } from "bun:test";
import { parseSqliteDirectPublicationRequest, sameSqlitePublicationContent, sqliteDirectPublicationResultSchema } from "./sqlite-direct-publication";
import { sqliteAudioReferenceSchema, sqliteCoverReferenceSchema, sqliteMediaKey } from "./sqlite-media";
import { sqliteContentSnapshotSchema } from "./sqlite-revisions";

const identity = { service_id: "service", service_config_sha256: "a".repeat(64) };
const runtime = { ...identity, worker_version_id: crypto.randomUUID() };
const common = { ...identity, schema_version: 1, protocol: "sqlite-sequential-v1" as const, action: "publish", show_id: "daily",
  expected_show_state_version: 1 };
const metadata = { schema_version: 1 as const, show_id: "daily", title: "Title", description: "Description", language: "ja", author: "Author",
  owner_name: "Owner", owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
  site_url: "https://example.com", image_path: "cover.jpg" };
const episodeMetadata = { schema_version: 1, episode_id: "first", guid: "saved-guid", title: "Episode", description: "Description",
  published_at: "2026-10-28T00:00:00Z" };
const cover = { extension: "jpg" as const, sha256: "b".repeat(64), length_bytes: 100 };
const audio = { sha256: "c".repeat(64), length_bytes: 200, duration_seconds: 10 };
const showRequest = () => {
  const request = parseSqliteDirectPublicationRequest({ ...common, kind: "show", metadata, cover });
  if (request.action !== "publish" || request.kind !== "show") throw new Error("Unexpected fixture kind");
  return request;
};
const episodeRequest = () => {
  const request = parseSqliteDirectPublicationRequest({ ...common, kind: "episode", episode_id: "first",
    metadata: episodeMetadata, audio, expected_episode_lifecycle_version: 0 });
  if (request.action !== "publish" || request.kind !== "episode") throw new Error("Unexpected fixture kind");
  return request;
};
const current = () => {
  const revisionId = crypto.randomUUID(), audioId = crypto.randomUUID();
  const updatedAt = "2026-10-28T01:00:00Z", enclosureUrl = `https://example.com/podcasts/daily/episodes/first/${audioId}.mp3`;
  return sqliteContentSnapshotSchema.parse({ ...runtime, protocol: common.protocol, publication_ready: true,
    show_id: "daily", episode_id: "first", show_lifecycle: "published",
    reservation_id: crypto.randomUUID(), expected_show_state_version: 9, feed_generation: 20, published_episode_count: 1,
    published_inventory_chars: 1000, show_content: { show_id: "daily", revision_sequence: 4, state_version: 9,
      revision_id: crypto.randomUUID(), metadata, metadata_sha256: "d".repeat(64),
      cover: { ...cover, generation: 4, public_url: "https://example.com/podcasts/daily/cover.jpg" },
      restored_from_revision_id: null, updated_at: updatedAt },
    episode_lifecycle: "published", expected_episode_lifecycle_version: 3, episode_site_id: "a".repeat(16),
    episode_content: { show_id: "daily", episode_id: "first", revision_sequence: 5, revision_id: revisionId,
      metadata: episodeMetadata, metadata_sha256: "e".repeat(64), revision: { ...episodeMetadata, ...audio,
        revision_id: revisionId, enclosure_url: enclosureUrl, content_type: "audio/mpeg", updated_at: updatedAt },
      audio: { ...audio, audio_revision_id: audioId, enclosure_url: enclosureUrl }, restored_from_revision_id: null, updated_at: updatedAt },
    snapshot_only: true, authorizes_recovery: false });
};

test("media keys depend only on Show, content hash and media type", () => {
  expect(sqliteMediaKey("daily", audio)).toBe(`public/podcasts/daily/audio/${audio.sha256}.mp3`);
  expect(sqliteMediaKey("daily", cover)).toBe(`public/podcasts/daily/covers/${cover.sha256}.jpg`);
  expect(sqliteMediaKey("daily", { ...cover, extension: "png" })).toEndWith(".png");
  expect(sqliteMediaKey("other", audio)).not.toBe(sqliteMediaKey("daily", audio));
  expect(() => sqliteMediaKey("../system", audio)).toThrow();
  expect(sqliteAudioReferenceSchema.safeParse({ ...audio, length_bytes: 300_000_000 }).success).toBe(true);
  expect(sqliteAudioReferenceSchema.safeParse({ ...audio, length_bytes: 300_000_001 }).success).toBe(false);
  expect(sqliteCoverReferenceSchema.safeParse({ ...cover, length_bytes: 5_000_001 }).success).toBe(false);
});

test("direct requests contain inline metadata and concrete media without operation or storage identities", () => {
  const show = showRequest(), episode = episodeRequest();
  expect(show.metadata).toEqual(metadata);
  expect(episode.audio).toEqual(audio);
  for (const field of ["job_id", "request_id", "payloads", "operation_id"]) {
    expect(() => parseSqliteDirectPublicationRequest({ ...episode, [field]: crypto.randomUUID() })).toThrow();
  }
  for (const change of [{ audio: undefined }, { audio: { ...audio, key: "system/secret" } },
    { audio: { ...audio, duration_seconds: undefined } }, { metadata: { ...episodeMetadata, episode_id: "other" } }]) {
    expect(() => parseSqliteDirectPublicationRequest({ ...episode, ...change })).toThrow();
  }
  for (const change of [{ cover: { ...cover, extension: "png" } }, { metadata: { ...metadata, show_id: "other" } },
    { metadata: { ...metadata, title: "a".repeat(256) } }]) {
    expect(() => parseSqliteDirectPublicationRequest({ ...show, ...change })).toThrow();
  }
});

test("inline request budget supports the existing metadata limits including JSON encoding", () => {
  const episode = episodeRequest();
  const parsed = parseSqliteDirectPublicationRequest({ ...episode, metadata: { ...episode.metadata, description: "文".repeat(10000) } });
  if (parsed.action !== "publish") throw new Error("Unexpected fixture action");
  expect(parsed.metadata.description).toHaveLength(10000);
  expect(() => parseSqliteDirectPublicationRequest({ ...episode, metadata: { ...episode.metadata, description: "a".repeat(10001) } })).toThrow();
  expect(() => parseSqliteDirectPublicationRequest({ ...episode, metadata: { ...episode.metadata,
    description: `<span title="${"a".repeat(1_020_000)}">text</span>` } })).toThrow("size limit");
});

test("same content ignores generated history and stale bases but not publication state", () => {
  const saved = current();
  expect(sameSqlitePublicationContent(showRequest(), saved)).toBe(true);
  expect(sameSqlitePublicationContent(episodeRequest(), saved)).toBe(true);
  expect(sameSqlitePublicationContent({ ...episodeRequest(), base_revision_id: crypto.randomUUID() }, saved)).toBe(true);
  expect(sameSqlitePublicationContent(episodeRequest(), { ...saved, show_lifecycle: "unpublished" })).toBe(false);
  expect(sameSqlitePublicationContent(episodeRequest(), { ...saved, episode_lifecycle: "unpublished" })).toBe(false);
  expect(sameSqlitePublicationContent(episodeRequest(), { ...saved, show_id: "other" })).toBe(false);
});

test("metadata, CSS, cover and audio changes are not unchanged", () => {
  const saved = current(), show = showRequest(), episode = episodeRequest();
  if (show.kind !== "show" || episode.kind !== "episode") throw new Error("Unexpected fixture kind");
  expect(sameSqlitePublicationContent({ ...show, metadata: { ...show.metadata, title: "Changed" } }, saved)).toBe(false);
  expect(sameSqlitePublicationContent({ ...show, cover: { ...show.cover, sha256: "f".repeat(64) } }, saved)).toBe(false);
  const { site_url, ...builtinMetadata } = show.metadata;
  const builtin = { ...builtinMetadata, site_mode: "builtin" as const, site_css_path: "style.css", site_css: "body { color: red; }" };
  const builtinSaved = { ...saved, show_content: { ...saved.show_content!, metadata: builtin } };
  expect(sameSqlitePublicationContent({ ...show, metadata: builtin }, builtinSaved)).toBe(true);
  expect(sameSqlitePublicationContent({ ...show, metadata: { ...builtin, site_css: "body { color: blue; }" } }, builtinSaved)).toBe(false);
  expect(sameSqlitePublicationContent({ ...episode, metadata: { ...episode.metadata, title: "Changed" } }, saved)).toBe(false);
  expect(sameSqlitePublicationContent({ ...episode, metadata: { ...episode.metadata, guid_is_permalink: false } }, saved)).toBe(true);
  for (const change of [{ sha256: "f".repeat(64) }, { length_bytes: 201 }, { duration_seconds: 11 }]) {
    expect(sameSqlitePublicationContent({ ...episode, audio: { ...episode.audio, ...change } }, saved)).toBe(false);
  }
});

test("synchronous results report the current revision without acceptance or job state", () => {
  const result = { ...runtime, protocol: common.protocol, show_id: "daily", episode_id: "first", result: "unchanged" as const, revision_id: crypto.randomUUID() };
  expect(sqliteDirectPublicationResultSchema.parse(result)).toEqual(result);
  expect(sqliteDirectPublicationResultSchema.safeParse({ ...result, result: "accepted" }).success).toBe(false);
  expect(sqliteDirectPublicationResultSchema.safeParse({ ...result, job_id: crypto.randomUUID() }).success).toBe(false);
});
