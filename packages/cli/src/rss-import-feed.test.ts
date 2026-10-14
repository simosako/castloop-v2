import { describe, expect, test } from "bun:test";
import { episodeDraftSchema } from "@castloop/shared";
import { parseRssImportFeed, RSS_IMPORT_MAXIMUM_BYTES } from "./rss-import-feed";

const item = `<item><title>First</title><description>Short description</description>
  <guid isPermaLink="false">old:episode:123&amp;456</guid><pubDate>Wed, 01 Apr 2020 12:00:00 +0900</pubDate>
  <enclosure url="https://media.example/first.mp3?key=private" length="123" type="audio/mpeg"/>
  <p:episodeType>full</p:episodeType><p:season>1</p:season><p:episode>2</p:episode>
  <c:encoded><![CDATA[<p>Full & detailed description</p>]]></c:encoded></item>`;

function feed(items = item): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"
    xmlns:p="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:c="http://purl.org/rss/1.0/modules/content/">
    <channel><title>Imported Show</title><description>Description</description><language>ja</language>
    <link>https://site.example/podcast</link><p:author>Author</p:author><p:explicit>no</p:explicit>
    <p:owner><p:name>Owner</p:name><p:email>owner@example.com</p:email></p:owner>
    <p:category text="Technology"/><p:image href="https://media.example/cover.jpg"/>${items}</channel></rss>`;
}

describe("RSS import conversion", () => {
  test("matches namespace URIs, preserves identity, prefers full descriptions and resolves assets", () => {
    const result = parseRssImportFeed(feed(), "imported", "https://old.example/feed.xml");
    expect(result.missing_fields).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.show.owner_email).toBe("owner@example.com");
    const episode = episodeDraftSchema.parse(result.episodes[0]!.metadata);
    expect(episode.guid).toBe("old:episode:123&456");
    expect(episode.guid_is_permalink).toBe(false);
    expect(episode.published_at).toBe("2020-04-01T03:00:00Z");
    expect(episode.description).toBe("<p>Full & detailed description</p>");
    expect(episode.episode_id).toMatch(/^ep-[a-f0-9]{64}$/);
    expect(result.episodes[0]!.audio_url).toBe("https://media.example/first.mp3?key=private");
    expect(result.episodes[0]!.declared_length).toBe(123);
    expect(result.cover_url).toBe("https://media.example/cover.jpg");
    expect(parseRssImportFeed(feed(item.replace("First", "New title")), "imported", "https://old.example/feed.xml")
      .episodes[0]!.metadata.episode_id).toBe(episode.episode_id);
  });

  test("retains GUID whitespace and maps an absent isPermaLink to the RSS default", () => {
    const result = parseRssImportFeed(feed(item.replace(' isPermaLink="false"', "").replace("old:episode:123&amp;456", " original ")),
      "imported", "https://old.example/feed.xml");
    expect(result.episodes[0]!.metadata.guid).toBe(" original ");
    expect(result.episodes[0]!.metadata.guid_is_permalink).toBe(true);
  });

  test("reports missing publication fields and unsupported extensions without inventing values", () => {
    const result = parseRssImportFeed(feed().replace("<p:email>owner@example.com</p:email>", "")
      .replace("<p:category text=\"Technology\"/>", '<p:category text="Technology"><p:category text="News"/></p:category>')
      .replace("</item>", "<p:image href=\"https://media.example/item.jpg\"/></item>"), "imported", "https://old.example/feed.xml");
    expect(result.show.owner_email).toBeUndefined();
    expect(result.missing_fields).toContain("Show: owner_email");
    expect(result.warnings).toContain("Nested iTunes categories are flattened to top-level categories");
    expect(result.warnings.some((warning) => warning.includes("image"))).toBe(true);
  });

  test("rejects missing or duplicate identity, invalid dates and ambiguous enclosures without silently skipping", () => {
    for (const input of [item + item, item.replace(/<guid[^>]*>.*?<\/guid>/, ""),
      item.replace("01 Apr 2020", "31 Apr 2020"), item.replace("+0900", "+2500"),
      item.replace(/<pubDate>.*?<\/pubDate>/, ""), item.replace("</item>", '<enclosure url="https://media.example/other.mp3"/></item>'),
      item.replace('isPermaLink="false"', 'isPermaLink="invalid"'),
      item.replace("https://media.example/first.mp3?key=private", "https://user:secret@media.example/audio.mp3")]) {
      expect(() => parseRssImportFeed(feed(input), "imported", "https://old.example/feed.xml")).toThrow("Episode");
    }
  });

  test("rejects malformed XML, DTD, non-RSS and oversized or deeply nested input", () => {
    for (const input of ["<rss>", '<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + feed(),
      '<feed xmlns="http://www.w3.org/2005/Atom"/>', feed().replace('version="2.0"', 'version="1.0"'),
      "x".repeat(RSS_IMPORT_MAXIMUM_BYTES + 1), "<a>".repeat(33) + "</a>".repeat(33),
      feed().replace("Short description", "&unknown;"), feed().replace("</rss>", "<channel/></rss>")]) {
      expect(() => parseRssImportFeed(input, "imported", "https://old.example/feed.xml")).toThrow();
    }
  });
});
