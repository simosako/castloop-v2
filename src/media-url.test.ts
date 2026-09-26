import { expect, test } from "bun:test";
import type { EpisodeRevision } from "../packages/shared/src/index";
import { canonicalEnclosureUrl } from "./media-url";

const revisionId = "12345678-1234-1234-1234-123456789abc";
const revision = { episode_id: "first", enclosure_url:
  `https://old.example.com/podcasts/daily/episodes/first/${revisionId}.mp3` } as EpisodeRevision;

test("rebases an immutable audio path without changing its revision", () => {
  const url = canonicalEnclosureUrl(revision, "daily", "https://podcasts.example.com");
  expect(url).toBe(`https://podcasts.example.com/podcasts/daily/episodes/first/${revisionId}.mp3`);
  expect(revision.enclosure_url).toStartWith("https://old.example.com/");
});

test("refuses to rebase audio from a different Show or a modified URL", () => {
  for (const enclosure_url of [
    `https://old.example.com/podcasts/other/episodes/first/${revisionId}.mp3`,
    `https://old.example.com/podcasts/daily/episodes/other/${revisionId}.mp3`,
    `https://old.example.com/podcasts/daily/episodes/first/${revisionId}.mp3?variant=1`,
    `https://old.example.com/podcasts/daily/episodes/first/${revisionId}.mp3#fragment`,
    `https://user@old.example.com/podcasts/daily/episodes/first/${revisionId}.mp3`,
  ]) {
    expect(() => canonicalEnclosureUrl({ ...revision, enclosure_url }, "daily", "https://podcasts.example.com"))
      .toThrow("invalid audio reference");
  }
});
