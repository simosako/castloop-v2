import { SaxesParser } from "saxes";
import { episodeDraftSchema, episodeGuidSchema, showMetadataSchema, validateId } from "@castloop/shared";
import type { EpisodeDraft, ShowMetadata } from "@castloop/shared";
import { createHash } from "node:crypto";

const ITUNES = "http://www.itunes.com/dtds/podcast-1.0.dtd";
const CONTENT = "http://purl.org/rss/1.0/modules/content/";
export const RSS_IMPORT_MAXIMUM_BYTES = 8 * 1024 * 1024;

type Element = { name: string; uri: string; attributes: Record<string, string>; text: string; children: Element[] };
export type RssImportEpisode = { metadata: Partial<EpisodeDraft> & Pick<EpisodeDraft, "episode_id" | "guid" | "published_at">;
  audio_url: string; declared_length?: number };
export type RssImportFeed = { show: Partial<ShowMetadata> & Pick<ShowMetadata, "schema_version" | "show_id">;
  cover_url?: string; episodes: RssImportEpisode[]; warnings: string[]; missing_fields: string[] };

function parseXml(source: string, maximumBytes: number): Element {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 32_000_000 ||
    !source || Buffer.byteLength(source) > maximumBytes) throw new Error("RSS is empty or exceeds its XML size budget");
  const stack: Element[] = [];
  let root: Element | undefined;
  let nodes = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", () => { throw new Error("Invalid RSS XML"); });
  parser.on("doctype", () => { throw new Error("RSS DTD and external entities are not supported"); });
  parser.on("xmldecl", (declaration) => {
    if (declaration.version !== "1.0" || declaration.encoding && !/^utf-8$/i.test(declaration.encoding)) {
      throw new Error("RSS requires XML 1.0 with UTF-8 encoding");
    }
  });
  parser.on("opentag", (tag) => {
    if (++nodes > 100000 || stack.length >= 32) throw new Error("RSS XML structure exceeds its limit");
    const element: Element = { name: tag.local, uri: tag.uri, text: "", children: [], attributes: {} };
    for (const attribute of Object.values(tag.attributes)) {
      if (!attribute.uri) element.attributes[attribute.local] = attribute.value;
    }
    if (stack.length) stack.at(-1)!.children.push(element);
    else root = element;
    stack.push(element);
  });
  const text = (value: string) => { if (stack.length) stack.at(-1)!.text += value; };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => { stack.pop(); });
  parser.write(source).close();
  if (!root) throw new Error("RSS has no root element");
  return root;
}

function children(element: Element, name: string, uri = ""): Element[] {
  return element.children.filter((child) => child.name === name && child.uri === uri);
}

function one(element: Element, name: string, uri = ""): Element | undefined {
  const matches = children(element, name, uri);
  if (matches.length > 1) throw new Error(`RSS has multiple ${name} elements`);
  return matches[0];
}

function value(element: Element, name: string, uri = ""): string | undefined {
  const child = one(element, name, uri);
  if (!child) return undefined;
  if (child.children.length) throw new Error(`RSS ${name} must contain text or CDATA, not nested XML`);
  return child.text;
}

function url(source: string, base: string): string {
  let parsed: URL;
  try { parsed = new URL(source, base); } catch { throw new Error("Invalid RSS asset URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("RSS asset URL must use HTTP(S) without credentials or fragments");
  }
  return parsed.href;
}

function explicit(source: string | undefined): boolean | undefined {
  if (source === undefined) return undefined;
  if (/^(true|yes|explicit)$/i.test(source.trim())) return true;
  if (/^(false|no|clean)$/i.test(source.trim())) return false;
  throw new Error("Invalid RSS explicit value");
}

function number(source: string | undefined): number | undefined {
  if (source === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(source.trim()) || !Number.isSafeInteger(Number(source))) throw new Error("Invalid RSS positive integer");
  return Number(source);
}

function publicationDate(source: string | undefined): string {
  const match = source?.trim().match(/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UT|UTC|[ECMP][SD]T|[+-]\d{4})$/i);
  if (!match) throw new Error("RSS Episode requires a valid RFC 822 pubDate with timezone");
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const day = Number(match[1]), month = months.indexOf(match[2]!.toLowerCase()), year = Number(match[3]);
  const hours = Number(match[4]), minutes = Number(match[5]), seconds = Number(match[6] ?? 0);
  const zones: Record<string, string> = { GMT: "+0000", UT: "+0000", UTC: "+0000", EST: "-0500", EDT: "-0400",
    CST: "-0600", CDT: "-0500", MST: "-0700", MDT: "-0600", PST: "-0800", PDT: "-0700" };
  const zone = zones[match[7]!.toUpperCase()] ?? match[7]!;
  const local = new Date(0);
  local.setUTCFullYear(year, month, day);
  local.setUTCHours(hours, minutes, seconds, 0);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month || local.getUTCDate() !== day ||
    hours > 23 || minutes > 59 || seconds > 59 || Number(zone.slice(1, 3)) > 23 || Number(zone.slice(3)) > 59) {
    throw new Error("RSS pubDate contains an impossible date or offset");
  }
  const offset = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3))) * (zone[0] === "-" ? -1 : 1);
  return new Date(local.getTime() - offset * 60000).toISOString().replace(/\.000Z$/, "Z");
}

function compact<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined)) as T;
}

export function parseRssImportFeed(source: string, showId: string, feedUrl: string, maximumBytes = RSS_IMPORT_MAXIMUM_BYTES): RssImportFeed {
  validateId(showId, "show");
  const root = parseXml(source, maximumBytes);
  if (root.name !== "rss" || root.uri || root.attributes.version !== "2.0") throw new Error("Only RSS 2.0 is supported");
  const channel = one(root, "channel");
  if (!channel) throw new Error("RSS requires one channel");
  const warnings = new Set<string>();
  const owner = one(channel, "owner", ITUNES);
  const image = one(channel, "image");
  const cover = one(channel, "image", ITUNES)?.attributes.href ?? (image && value(image, "url"));
  const categories = children(channel, "category", ITUNES);
  if (categories.some((category) => category.children.length)) warnings.add("Nested iTunes categories are flattened to top-level categories");
  const show: RssImportFeed["show"] = compact({ schema_version: 1, show_id: showId, title: value(channel, "title"),
    description: value(channel, "description"), language: value(channel, "language"), author: value(channel, "author", ITUNES),
    owner_name: owner && value(owner, "name", ITUNES), owner_email: owner && value(owner, "email", ITUNES),
    categories: categories.length ? categories.map((category) => category.attributes.text ?? "") : undefined,
    explicit: explicit(value(channel, "explicit", ITUNES)), site_url: value(channel, "link"),
    copyright: value(channel, "copyright"), show_type: value(channel, "type", ITUNES) as ShowMetadata["show_type"] });
  const guids = new Set<string>();
  const ids = new Set<string>();
  const episodes: RssImportEpisode[] = [];
  const missing: string[] = [];
  const reportUnknown = (element: Element, known: Set<string>) => {
    for (const child of element.children) {
      const key = `{${child.uri}}${child.name}`;
      if (!known.has(key)) warnings.add(`Not imported: ${key}`);
    }
  };
  reportUnknown(channel, new Set(["title", "description", "language", "link", "copyright", "image", "item"].map((name) => `{}${name}`)
    .concat(["author", "owner", "category", "explicit", "type", "image"].map((name) => `{${ITUNES}}${name}`))));
  for (const [index, item] of children(channel, "item").entries()) {
    try {
      const guid = episodeGuidSchema.parse(value(item, "guid"));
      if (guids.has(guid)) throw new Error("Duplicate Episode GUID");
      guids.add(guid);
      const episodeId = `ep-${createHash("sha256").update(guid).digest("hex")}`;
      if (ids.has(episodeId)) throw new Error("Derived Episode ID collision");
      ids.add(episodeId);
      const permalink = one(item, "guid")!.attributes.isPermaLink;
      if (permalink !== undefined && !["true", "false"].includes(permalink)) throw new Error("Invalid GUID isPermaLink attribute");
      const enclosure = one(item, "enclosure");
      if (!enclosure?.attributes.url) throw new Error("Episode requires one enclosure URL");
      const metadata: RssImportEpisode["metadata"] = compact({ schema_version: 1,
        episode_id: episodeId, guid,
        guid_is_permalink: permalink !== "false", published_at: publicationDate(value(item, "pubDate")),
        title: value(item, "title"), description: value(item, "encoded", CONTENT) ?? value(item, "description"),
        explicit: explicit(value(item, "explicit", ITUNES)), episode_type: value(item, "episodeType", ITUNES) as EpisodeDraft["episode_type"],
        season_number: number(value(item, "season", ITUNES)), episode_number: number(value(item, "episode", ITUNES)) });
      const validation = episodeDraftSchema.safeParse(metadata);
      if (!validation.success) missing.push(...validation.error.issues.map((issue) => `Episode ${index + 1}: ${issue.path.join(".")}`));
      const length = enclosure.attributes.length;
      const declared = length !== undefined && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length) > 0 ? Number(length) : undefined;
      if (length !== undefined && declared === undefined) warnings.add(`Episode ${index + 1}: enclosure length is unavailable or unreliable`);
      episodes.push(compact({ metadata, audio_url: url(enclosure.attributes.url, feedUrl), declared_length: declared }));
      reportUnknown(item, new Set(["guid", "pubDate", "enclosure", "title", "description"].map((name) => `{}${name}`)
        .concat([`{${CONTENT}}encoded`], ["explicit", "episodeType", "season", "episode"].map((name) => `{${ITUNES}}${name}`))));
    } catch {
      throw new Error(`RSS Episode ${index + 1} has an invalid GUID, date, metadata or enclosure; no Episodes were imported`);
    }
  }
  const showValidation = showMetadataSchema.omit({ image_path: true }).safeParse(show);
  if (!showValidation.success) missing.unshift(...showValidation.error.issues.map((issue) => `Show: ${issue.path.join(".")}`));
  if (!cover) missing.push("Show: cover image");
  return { show, ...(cover ? { cover_url: url(cover, feedUrl) } : {}), episodes, warnings: [...warnings].sort(), missing_fields: missing };
}
