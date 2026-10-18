import { expect, test } from "bun:test";
import { parseEpisodeDraft, parseShowMetadata, stringifyToml, validateId } from "./index";

const show = { schema_version: 1 as const, show_id: "daily-show", title: "Daily", description: "Description",
  language: "ja", author: "Author", owner_name: "Owner", owner_email: "owner@example.com",
  categories: ["Technology"], explicit: false, site_url: "https://example.com/podcast", image_path: "cover.jpg" };

test("version 1 content metadata still round trips and rejects generated/unknown fields", () => {
  expect(parseShowMetadata(stringifyToml(show))).toEqual(show);
  expect(() => parseShowMetadata(stringifyToml(show) + 'revision_id = "old"\n')).toThrow();
  expect(() => parseShowMetadata(stringifyToml({ ...show, site_url: "not-a-url" }))).toThrow();
  expect(validateId("a".repeat(32), "show")).toBe("a".repeat(32));
  expect(() => validateId("a".repeat(33), "show")).toThrow();
  expect(() => validateId("a--b", "show")).toThrow();
});

test("Episode input accepts explicit RFC3339 offsets but rejects impossible dates and TOML native datetime", () => {
  const input = { schema_version: 1 as const, episode_id: "first", guid: crypto.randomUUID(),
    title: "First", description: "Description", published_at: "2026-02-28T23:59:59+09:00" };
  expect(parseEpisodeDraft(stringifyToml(input)).published_at).toBe(input.published_at);
  expect(() => parseEpisodeDraft(stringifyToml({ ...input, published_at: "2026-02-30T12:00:00Z" }))).toThrow();
  expect(() => parseEpisodeDraft(stringifyToml(input).replace('"2026-02-28T23:59:59+09:00"', "2026-02-28T23:59:59+09:00"))).toThrow();
});
