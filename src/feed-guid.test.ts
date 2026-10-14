import { expect, test } from "bun:test";
import { episodeRevisionSchema, showMetadataSchema } from "../packages/shared/src/index";
import { renderFeed } from "./feed";

test("RSS preserves imported GUID text and permalink meaning while old UUID output stays unchanged", () => {
  const show = showMetadataSchema.parse({ schema_version: 1, show_id: "daily", title: "Daily", description: "Description",
    language: "ja", author: "Author", owner_name: "Owner", owner_email: "owner@example.com", categories: ["Technology"],
    explicit: false, site_url: "https://example.com", image_path: "cover.jpg" });
  const base = episodeRevisionSchema.parse({ schema_version: 1, episode_id: "first", guid: crypto.randomUUID(),
    title: "First", description: "Description", published_at: "2020-04-01T03:00:00Z", revision_id: crypto.randomUUID(),
    enclosure_url: `https://new.example/podcasts/daily/episodes/first/${crypto.randomUUID()}.mp3`, content_type: "audio/mpeg", length_bytes: 123, duration_seconds: 5,
    sha256: "a".repeat(64), updated_at: "2026-10-12T00:00:00Z" });
  expect(renderFeed(show, [base], "https://new.example", "jpg")).toContain(`<guid isPermaLink="false">${base.guid}</guid>`);
  const imported = { ...base, guid: "https://old.example/episode?a=1&b=2", guid_is_permalink: true };
  const feed = renderFeed(show, [imported], "https://new.example", "jpg");
  expect(feed).toContain('<guid isPermaLink="true">https://old.example/episode?a=1&amp;b=2</guid>');
  expect(feed).toContain("<pubDate>Wed, 01 Apr 2020 03:00:00 GMT</pubDate>");
  expect(renderFeed(show, [{ ...imported, guid: "old\ridentity" }], "https://new.example", "jpg"))
    .toContain("old&#13;identity");
});
