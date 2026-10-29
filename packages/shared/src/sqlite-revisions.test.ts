import { expect, test } from "bun:test";
import { sqliteContentActionRequestSchema as sqlitePublicationRequestSchema } from "./sqlite-direct-publication";
import { diffEpisodeDraftFields, diffShowMetadataFields } from "./sqlite-revisions";

const request = { schema_version: 1, protocol: "sqlite-sequential-v1", service_id: "service", kind: "episode", show_id: "daily", episode_id: "first",
  action: "restore_revision", service_config_sha256: "a".repeat(64), expected_show_state_version: 1,
  expected_episode_lifecycle_version: 0, base_revision_id: crypto.randomUUID(), target_revision_id: crypto.randomUUID() };

test("revision requests require an exact current base, target revision, valid scope and no uploads", () => {
  expect(sqlitePublicationRequestSchema.safeParse(request).success).toBe(true);
  for (const change of [{ base_revision_id: undefined }, { target_revision_id: undefined }, { expected_episode_lifecycle_version: undefined },
    { action: "restore" }, { action: "unpublish" }, { action: "publish" }, { target_revision_id: "invalid" }, { unknown: true }]) {
    expect(sqlitePublicationRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  }
  const show = { ...request, kind: "show", episode_id: undefined, base_revision_id: undefined, expected_episode_lifecycle_version: undefined };
  expect(sqlitePublicationRequestSchema.safeParse(show).success).toBe(true);
});

test("field diff respects optional absence, order and permalink identity defaults without truncating text", () => {
  const episode = { schema_version: 1 as const, episode_id: "first", guid: "stable", published_at: "2026-10-25T00:00:00Z", title: "Title", description: "文".repeat(10000) };
  expect(diffEpisodeDraftFields(episode, { ...episode, guid_is_permalink: false }).every((field) => !field.changed)).toBe(true);
  const changed = diffEpisodeDraftFields(episode, { ...episode, description: "New", episode_number: 1 });
  expect(changed.find((field) => field.field === "description")?.published).toBe(episode.description);
  expect(changed.find((field) => field.field === "episode_number")).toMatchObject({ changed: true, published: null, candidate: 1 });
  const show = { schema_version: 1 as const, show_id: "daily", title: "Title", description: "Description", language: "ja", author: "Author",
    owner_name: "Owner", owner_email: "owner@example.com", categories: ["Technology", "News"], explicit: false, site_url: "https://example.com", image_path: "cover.jpg" };
  expect(diffShowMetadataFields(show, { ...show, categories: ["News", "Technology"] }).find((field) => field.field === "categories")?.changed).toBe(true);
  const { site_url, ...withoutSite } = show;
  expect(diffShowMetadataFields(show, { ...withoutSite, site_mode: "builtin" }).find((field) => field.field === "site_mode"))
    .toMatchObject({ changed: true, published: null, candidate: "builtin" });
  const builtin = { ...withoutSite, site_mode: "builtin" as const, site_timezone: "Asia/Tokyo" };
  expect(diffShowMetadataFields({ ...withoutSite, site_mode: "builtin" }, builtin).find((field) => field.field === "site_timezone"))
    .toMatchObject({ changed: true, published: null, candidate: "Asia/Tokyo" });
  expect(diffShowMetadataFields(builtin, { ...builtin, site_timezone: undefined }).find((field) => field.field === "site_timezone"))
    .toMatchObject({ changed: true, published: "Asia/Tokyo", candidate: null });
});
