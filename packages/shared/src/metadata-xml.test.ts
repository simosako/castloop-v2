import { expect, test } from "bun:test";
import { episodeDraftSchema, episodeRevisionSchema, parseEpisodeDraft, parseShowMetadata,
  showMetadataSchema, stringifyToml } from "./index";
import { isXml10Text } from "./xml";

const show = { schema_version: 1 as const, show_id: "daily", title: "Daily", description: "Description", language: "ja",
  author: "Author", owner_name: "Owner", owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
  site_url: "https://example.com/podcast", image_path: "cover.jpg" };
const episode = { schema_version: 1 as const, episode_id: "first", guid: "stable-guid", title: "First",
  description: "Description", published_at: "2026-10-17T12:00:00+09:00" };
const invalidCharacters = [...Array.from({ length: 32 }, (_, index) => index).filter((point) => ![9, 10, 13].includes(point)),
  0xfffe, 0xffff, 0xd800, 0xdfff].map((point) => String.fromCharCode(point));

test("XML 1.0 character boundaries match the existing GUID contract", () => {
  for (const point of [9, 10, 13, 0x20, 0xd7ff, 0xe000, 0xfffd, 0x10000, 0x10ffff]) {
    expect(isXml10Text(String.fromCodePoint(point))).toBe(true);
  }
  for (const character of invalidCharacters) expect(isXml10Text(character)).toBe(false);
  expect(isXml10Text("")).toBe(true);
});

test("Show and Episode text reject every forbidden XML control and unpaired surrogate", () => {
  for (const character of invalidCharacters) {
    const text = `before${character}after`;
    for (const field of ["title", "description", "author", "owner_name", "copyright"] as const) {
      expect(showMetadataSchema.safeParse({ ...show, [field]: text }).success).toBe(false);
    }
    expect(showMetadataSchema.safeParse({ ...show, categories: [text] }).success).toBe(false);
    for (const field of ["title", "description"] as const) {
      expect(episodeDraftSchema.safeParse({ ...episode, [field]: text }).success).toBe(false);
    }
  }
  for (const character of ["\u000b", "\u000c"]) {
    expect(showMetadataSchema.safeParse({ ...show, title: `${character}Daily` }).success).toBe(false);
    expect(episodeDraftSchema.safeParse({ ...episode, description: `Description${character}` }).success).toBe(false);
  }
  expect(showMetadataSchema.safeParse({ ...show, site_url: "https://example.com/a\u0000b" }).success).toBe(false);
});

test("TOML parsing and published revisions share XML text validation", () => {
  expect(() => parseShowMetadata(stringifyToml({ ...show, title: "bad\u0000title" }))).toThrow();
  expect(() => parseEpisodeDraft(stringifyToml({ ...episode, description: "bad\u0008description" }))).toThrow();
  expect(episodeRevisionSchema.safeParse({ ...episode, title: "bad\ufffetitle", revision_id: crypto.randomUUID(),
    enclosure_url: "https://example.com/audio.mp3", content_type: "audio/mpeg", length_bytes: 1,
    duration_seconds: 1, sha256: "a".repeat(64), updated_at: episode.published_at }).success).toBe(false);
});

test("valid XML text keeps existing trimming, Unicode, whitespace and GUID identity", () => {
  const text = "日本語😀e\u0301 & <tag> \"quote\" 'apostrophe'\tline\nnext\rfinal";
  const value = { ...show, title: ` ${text} `, description: text, author: text, owner_name: text,
    categories: [text], copyright: ` ${text} ` };
  expect(parseShowMetadata(stringifyToml(value))).toEqual({ ...value, title: text });
  const draft = { ...episode, title: ` ${text} `, description: text, guid: ` ${text} ` };
  expect(parseEpisodeDraft(stringifyToml(draft))).toEqual({ ...draft, title: text });
});
