import type { EpisodeDraft, ShowMetadata } from "./index";

// Apple Podcasts RSS limits are the normative reference.
// Show description uses UTF-8 bytes, Episode description and other tag values
// use characters. Where interpretation is ambiguous, the larger allowance wins:
// HTML tags are excluded from the measured text and characters count Unicode
// code points rather than UTF-16 code units.
export const SHOW_TITLE_MAX_CHARS = 255;
export const SHOW_DESCRIPTION_MAX_BYTES = 4000;
export const SHOW_AUTHOR_MAX_CHARS = 255;
export const SHOW_OWNER_NAME_MAX_CHARS = 255;
export const SHOW_OWNER_EMAIL_MAX_CHARS = 255;
export const SHOW_CATEGORY_MAX_CHARS = 255;
export const SHOW_COPYRIGHT_MAX_CHARS = 255;
// Apple lists 255 for tag values, but a site URL is a practical locator rather
// than display text. Take the larger common locator budget instead of Apple's
// display default so valid long site URLs are not rejected early.
export const SHOW_SITE_URL_MAX_CHARS = 2048;
export const EPISODE_TITLE_MAX_CHARS = 255;
// Apple allows 10,000 characters for Episode descriptions while several hosts
// document 4,000 for cross-directory compatibility. Take the larger Apple RSS
// value for new inputs; downstream truncation remains the directory's choice.
export const EPISODE_DESCRIPTION_MAX_CHARS = 10000;

export function stripHtmlTags(value: string): string {
  return value.replace(/<[^<>]*>/g, "");
}

export function countCharacters(value: string): number {
  return Array.from(value).length;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function measuredText(value: string): string {
  return stripHtmlTags(value.trim()).trim();
}

function checkChars(value: string, maximum: number, field: string): void {
  if (countCharacters(measuredText(value)) > maximum) {
    throw new Error(`${field} exceeds its input limit`);
  }
}

export function assertShowMetadataInputLimits(show: ShowMetadata): void {
  checkChars(show.title, SHOW_TITLE_MAX_CHARS, "Show title");
  if (utf8ByteLength(measuredText(show.description)) > SHOW_DESCRIPTION_MAX_BYTES) {
    throw new Error("Show description exceeds its input limit");
  }
  checkChars(show.author, SHOW_AUTHOR_MAX_CHARS, "Show author");
  checkChars(show.owner_name, SHOW_OWNER_NAME_MAX_CHARS, "Show owner_name");
  checkChars(show.owner_email, SHOW_OWNER_EMAIL_MAX_CHARS, "Show owner_email");
  for (const category of show.categories) checkChars(category, SHOW_CATEGORY_MAX_CHARS, "Show category");
  if (show.copyright !== undefined) checkChars(show.copyright, SHOW_COPYRIGHT_MAX_CHARS, "Show copyright");
  if (countCharacters(show.site_url.trim()) > SHOW_SITE_URL_MAX_CHARS) {
    throw new Error("Show site_url exceeds its input limit");
  }
}

export function assertEpisodeDraftInputLimits(episode: EpisodeDraft): void {
  checkChars(episode.title, EPISODE_TITLE_MAX_CHARS, "Episode title");
  if (countCharacters(measuredText(episode.description)) > EPISODE_DESCRIPTION_MAX_CHARS) {
    throw new Error("Episode description exceeds its input limit");
  }
}
