import { describe, expect, test } from "bun:test";
import { episodeDraftSchema, episodeGuidSchema, episodeRevisionSchema, parseEpisodeDraft, sameEpisodeIdentity, stringifyToml } from "./index";

const draft = { schema_version: 1 as const, episode_id: "first", guid: "old-host:episode:123",
  title: "First", description: "Description", published_at: "2020-04-01T03:00:00Z" };

describe("M7 Episode GUID compatibility", () => {
  test("preserves UUIDs, opaque strings, URLs, whitespace and Unicode without normalization", () => {
    for (const guid of [crypto.randomUUID(), draft.guid, "https://old.example/episode?a=1&b=2", " episode ", "番組😀e\u0301"]) {
      expect(episodeGuidSchema.parse(guid)).toBe(guid);
      expect(parseEpisodeDraft(stringifyToml({ ...draft, guid })).guid).toBe(guid);
    }
    expect(episodeGuidSchema.parse("a".repeat(4096))).toHaveLength(4096);
    expect(episodeGuidSchema.parse("😀".repeat(1024))).toHaveLength(2048);
  });

  test("rejects blank, oversized, non-XML and malformed Unicode GUIDs", () => {
    for (const guid of ["", " \n\t", "a".repeat(4097), "😀".repeat(1025), "x\0", "x\u000b", "x\ufffe", "x\uffff", "x\ud800", "x\udfff"]) {
      expect(episodeGuidSchema.safeParse(guid).success).toBe(false);
    }
  });

  test("keeps optional attributes absent in old data and shares validation with revisions", () => {
    expect(episodeDraftSchema.parse(draft)).toEqual(draft);
    expect(parseEpisodeDraft(stringifyToml(draft))).not.toHaveProperty("guid_is_permalink");
    const revision = { ...draft, guid_is_permalink: true, revision_id: crypto.randomUUID(),
      enclosure_url: "https://new.example/audio.mp3", content_type: "audio/mpeg", length_bytes: 123,
      duration_seconds: 5, sha256: "a".repeat(64), updated_at: "2026-10-12T00:00:00Z" };
    expect(episodeRevisionSchema.parse(revision).guid_is_permalink).toBe(true);
    expect(episodeDraftSchema.safeParse({ ...draft, guid_is_permalink: "false" }).success).toBe(false);
    expect(episodeRevisionSchema.safeParse({ ...revision, revision_id: "opaque-id" }).success).toBe(false);
    expect(episodeDraftSchema.safeParse({ ...draft, unknown_field: true }).success).toBe(false);
  });

  test("identity compares the effective permalink attribute without changing old values", () => {
    expect(sameEpisodeIdentity(draft, { ...draft, guid_is_permalink: false })).toBe(true);
    expect(sameEpisodeIdentity(draft, { ...draft, guid_is_permalink: true })).toBe(false);
    for (const changed of [{ ...draft, guid: "other" }, { ...draft, episode_id: "second" },
      { ...draft, published_at: "2020-04-02T03:00:00Z" }]) {
      expect(sameEpisodeIdentity(draft, changed)).toBe(false);
    }
  });
});
