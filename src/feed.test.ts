import { expect, test } from "bun:test";
import { SaxesParser } from "saxes";
import type { EpisodeRevision, ShowMetadata } from "../packages/shared/src/index";
import { renderFeed } from "./feed";

const text = "日本語😀e\u0301 & <tag> \"quote\" 'apostrophe'\tline\nnext\rfinal";
const show: ShowMetadata = { schema_version: 1, show_id: "daily", title: text, description: text, language: "ja",
  author: text, owner_name: text, owner_email: "owner@example.com", categories: [text], explicit: false,
  site_url: "https://example.com/podcast?a=1&b=2", image_path: "cover.jpg", copyright: text };
const episode: EpisodeRevision = { schema_version: 1, episode_id: "first", guid: ` ${text} `, guid_is_permalink: true,
  title: text, description: text, published_at: "2026-10-17T12:00:00+09:00", revision_id: "11111111-1111-4111-8111-111111111111",
  enclosure_url: "https://example.com/podcasts/daily/episodes/first/11111111-1111-4111-8111-111111111111.mp3",
  content_type: "audio/mpeg", length_bytes: 1, duration_seconds: 1, sha256: "a".repeat(64), updated_at: "2026-10-17T12:00:00+09:00" };

test("RSS is well-formed XML and escaping preserves Unicode, text whitespace and exact GUID", () => {
  const xml = renderFeed(show, [episode], "https://public.example.com", "jpg");
  const parser = new SaxesParser({ xmlns: true });
  const values: string[] = [];
  parser.on("text", (value) => values.push(value));
  parser.on("error", (error) => { throw error; });
  parser.write(xml).close();
  expect(values).toContain(text);
  expect(values).toContain(episode.guid);
  expect(xml).toContain("&amp; &lt;tag&gt; &quot;quote&quot; &apos;apostrophe&apos;");
  expect(xml).toContain("next&#13;final");
  expect(xml).toContain('isPermaLink="true"');
  expect(xml).toContain("Sat, 17 Oct 2026 03:00:00 GMT");
});

test("rendering refuses invalid XML text even when callers bypass metadata schemas", () => {
  for (const character of ["\u0000", "\u0008", "\u000b", "\u000c", "\u001f", "\ufffe", "\uffff", "\ud800", "\udfff"]) {
    const invalid = `before${character}after`;
    for (const field of ["title", "description", "author", "owner_name", "owner_email", "site_url", "language", "copyright"] as const) {
      expect(() => renderFeed({ ...show, [field]: invalid }, [], "https://public.example.com", "jpg")).toThrow("XML");
    }
    expect(() => renderFeed({ ...show, categories: [invalid] }, [], "https://public.example.com", "jpg")).toThrow("XML");
    for (const field of ["title", "description", "guid"] as const) {
      expect(() => renderFeed(show, [{ ...episode, [field]: invalid }], "https://public.example.com", "jpg")).toThrow("XML");
    }
    expect(() => renderFeed(show, [], `https://public.example.com/${invalid}`, "jpg")).toThrow("XML");
  }
});
