import { expect, test } from "bun:test";
import { episodeDraftInputSchema, episodeDraftSchema, showMetadataInputSchema, showMetadataSchema } from "./index";

const show = { schema_version: 1 as const, show_id: "daily", title: "Daily", description: "Description", language: "ja",
  author: "Author", owner_name: "Owner", owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
  site_url: "https://example.com/podcast", image_path: "cover.jpg" };
const episode = { schema_version: 1 as const, episode_id: "first", guid: "stable-guid", title: "First",
  description: "Description", published_at: "2026-10-17T12:00:00+09:00" };

test("Apple-based input limits accept boundary values", () => {
  expect(showMetadataInputSchema.safeParse({ ...show, title: "t".repeat(255) }).success).toBe(true);
  expect(showMetadataInputSchema.safeParse({ ...show, title: "t".repeat(256) }).success).toBe(false);
  expect(showMetadataInputSchema.safeParse({ ...show, description: "あ".repeat(1333) }).success).toBe(true);
  expect(showMetadataInputSchema.safeParse({ ...show, description: "あ".repeat(1334) }).success).toBe(false);
  expect(episodeDraftInputSchema.safeParse({ ...episode, title: "t".repeat(255) }).success).toBe(true);
  expect(episodeDraftInputSchema.safeParse({ ...episode, title: "t".repeat(256) }).success).toBe(false);
  expect(episodeDraftInputSchema.safeParse({ ...episode, description: "d".repeat(10000) }).success).toBe(true);
  expect(episodeDraftInputSchema.safeParse({ ...episode, description: "d".repeat(10001) }).success).toBe(false);
});

test("multibyte and HTML tags use the generous interpretation", () => {
  // Show description is 4000 UTF-8 bytes of text without tags.
  expect(showMetadataInputSchema.safeParse({ ...show, description: "<p>" + "あ".repeat(1333) + "</p>" }).success).toBe(true);
  expect(showMetadataInputSchema.safeParse({ ...show, description: "あ".repeat(1334) }).success).toBe(false);
  // Emoji counts as one character, not two UTF-16 code units.
  expect(episodeDraftInputSchema.safeParse({ ...episode, description: "😀".repeat(10000) }).success).toBe(true);
  expect(episodeDraftInputSchema.safeParse({ ...episode, description: "😀".repeat(10001) }).success).toBe(false);
  // Tags do not count toward the Episode description budget either.
  expect(episodeDraftInputSchema.safeParse({ ...episode, description: "<p>" + "d".repeat(10000) + "</p>" }).success).toBe(true);
});

test("storage schemas keep reading over-limit history without rewriting it", () => {
  const legacy = { ...show, title: "t".repeat(300), description: "d".repeat(5000) };
  expect(showMetadataSchema.safeParse(legacy).success).toBe(true);
  expect(showMetadataInputSchema.safeParse(legacy).success).toBe(false);
  const legacyEpisode = { ...episode, description: "d".repeat(10001) };
  expect(episodeDraftSchema.safeParse(legacyEpisode).success).toBe(true);
  expect(episodeDraftInputSchema.safeParse(legacyEpisode).success).toBe(false);
});
