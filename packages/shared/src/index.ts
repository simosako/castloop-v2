import * as TOML from "@iarna/toml";
import { z } from "zod";
import { publishedTimestampSchema as publishedAt } from "./metadata-time";
import type { SqliteServiceConfig } from "./sqlite-service";
import type { AdminConfig } from "./admin-config";
import { isXml10Text } from "./xml";
import { validateSiteCss } from "./site-style";
import { assertEpisodeDraftInputLimits, assertShowMetadataInputLimits } from "./metadata-limits";

export { sqlitePublicationProtocol, MAX_SQLITE_PUBLICATION_BYTES, sqliteUploadKey, sqliteVerifiedUploadSchema,
  sqlitePublicationRuntimeSchema, sqlitePublicationRequestSchema, sqlitePublicationStatusSchema,
  sqlitePublicationFailureSchema, sqlitePublicationBlockSchema, parseSqlitePublicationRequest,
  sqlitePublicationRequestHash } from "./sqlite-publication";
export type { SqliteUploadIdentity, SqliteVerifiedUpload, SqlitePublicationRuntime, SqlitePublicationRequest,
  SqlitePublicationStatus, SqlitePublicationFailure, SqlitePublicationBlock } from "./sqlite-publication";
export { sqliteServiceConfigSchema, sqliteServiceStatusSchema, parseSqliteServiceConfig, sqliteServiceConfigHash } from "./sqlite-service";
export type { SqliteServiceConfig, SqliteServiceStatus } from "./sqlite-service";
export { diagnosticCheckSchema, diagnosticScopeSchema, diagnosticStatusSchema, diagnosticSummarySchema } from "./diagnostics";
export type { DiagnosticCheck, DiagnosticScope, DiagnosticStatus, DiagnosticSummary } from "./diagnostics";
export { stageAssetSchema, stagePayloadSchema, stageReadbackReceiptSchema } from "./upload";
export type { StageAsset, StagePayload, StageReadbackReceipt } from "./upload";
export { validateId } from "./ids";
export { assertPublicationInventoryBudget, assertPublicationRenderBudget, publicationCharacterLength, PUBLICATION_RENDER_BUDGET_BYTES } from "./publication-budget";
export { sha256Hex, toHex } from "./sha256";
export { parsePublicAssetPath } from "./public-assets";
export type { PublicAsset } from "./public-assets";
export { SHOW_TITLE_MAX_CHARS, SHOW_DESCRIPTION_MAX_BYTES, SHOW_AUTHOR_MAX_CHARS, SHOW_OWNER_NAME_MAX_CHARS,
  SHOW_OWNER_EMAIL_MAX_CHARS, SHOW_CATEGORY_MAX_CHARS, SHOW_COPYRIGHT_MAX_CHARS, SHOW_SITE_URL_MAX_CHARS,
  EPISODE_TITLE_MAX_CHARS, EPISODE_DESCRIPTION_MAX_CHARS, stripHtmlTags, countCharacters, utf8ByteLength,
  assertShowMetadataInputLimits, assertEpisodeDraftInputLimits } from "./metadata-limits";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = (max: number) => z.string().max(max).regex(SLUG);
const xmlText = z.string().refine(isXml10Text, "Expected XML 1.0-compatible text");
const trimmedXmlText = xmlText.trim().min(1);
const webUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && !!url.hostname &&
    !url.username && !url.password && !url.hash;
}, "Expected an HTTP(S) URL without credentials or fragment");

export const showMetadataSchema = z.object({
  schema_version: z.literal(1),
  show_id: ID(32),
  title: trimmedXmlText,
  description: trimmedXmlText,
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  author: trimmedXmlText,
  owner_name: trimmedXmlText,
  owner_email: xmlText.pipe(z.email()),
  categories: z.array(trimmedXmlText).min(1),
  explicit: z.boolean(),
  site_mode: z.enum(["builtin", "external"]).optional(),
  site_url: xmlText.pipe(webUrl).optional(),
  site_css_path: z.string().regex(/^[^/\\.][^/\\]*\.css$/i).optional(),
  site_css: z.string().refine((value) => {
    try { validateSiteCss(value); return true; } catch { return false; }
  }, "Invalid site CSS").optional(),
  image_path: z.string().regex(/^[^/\\.][^/\\]*\.(?:jpg|jpeg|png)$/i),
  copyright: xmlText.min(1).optional(),
  show_type: z.enum(["episodic", "serial"]).optional(),
}).strict().superRefine((value, context) => {
  if (value.site_mode !== "builtin" && (value.site_css_path !== undefined || value.site_css !== undefined)) {
    context.addIssue({ code: "custom", path: ["site_css_path"], message: "Site CSS requires a builtin site" });
  }
  if (value.site_mode === "builtin" ? value.site_url !== undefined : value.site_url === undefined) {
    context.addIssue({ code: "custom", path: ["site_url"], message: "Builtin sites omit site_url; external sites require site_url" });
  }
});

export const episodeGuidSchema = z.string().min(1).max(4096).refine((value) => {
  if (!value.trim() || new TextEncoder().encode(value).byteLength > 4096) return false;
  return isXml10Text(value);
}, "Expected a nonblank XML-compatible GUID of at most 4096 UTF-8 bytes");

export const episodeDraftSchema = z.object({
  schema_version: z.literal(1),
  episode_id: ID(80),
  guid: episodeGuidSchema,
  guid_is_permalink: z.boolean().optional(),
  title: trimmedXmlText,
  description: trimmedXmlText,
  published_at: publishedAt,
  explicit: z.boolean().optional(),
  episode_type: z.enum(["full", "trailer", "bonus"]).optional(),
  season_number: z.number().int().positive().optional(),
  episode_number: z.number().int().positive().optional(),
}).strict();

export const episodeRevisionSchema = episodeDraftSchema.extend({
  revision_id: z.uuid(),
  enclosure_url: webUrl,
  content_type: z.literal("audio/mpeg"),
  length_bytes: z.number().int().positive().max(300_000_000),
  duration_seconds: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  updated_at: publishedAt,
}).strict();

export type ShowMetadata = z.infer<typeof showMetadataSchema>;
export type EpisodeDraft = z.infer<typeof episodeDraftSchema>;
export type EpisodeRevision = z.infer<typeof episodeRevisionSchema>;

// Input schemas enforce Apple-based size limits for new drafts and imports.
// Storage schemas above stay unbounded so saved snapshots and revisions remain
// readable even when they predate the limits or came from larger hosts.
const showLimitPath = (message: string): string[] => {
  if (message.startsWith("Show title")) return ["title"];
  if (message.startsWith("Show description")) return ["description"];
  if (message.startsWith("Show author")) return ["author"];
  if (message.startsWith("Show owner_name")) return ["owner_name"];
  if (message.startsWith("Show owner_email")) return ["owner_email"];
  if (message.startsWith("Show category")) return ["categories"];
  if (message.startsWith("Show copyright")) return ["copyright"];
  if (message.startsWith("Show site_url")) return ["site_url"];
  return [];
};

export const showMetadataInputSchema = showMetadataSchema.superRefine((value, context) => {
  try {
    assertShowMetadataInputLimits(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Show metadata exceeds its input limit";
    context.addIssue({ code: "custom", path: showLimitPath(message), message });
  }
});

export const episodeDraftInputSchema = episodeDraftSchema.superRefine((value, context) => {
  try {
    assertEpisodeDraftInputLimits(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Episode metadata exceeds its input limit";
    context.addIssue({ code: "custom", path: message.startsWith("Episode description") ? ["description"] : ["title"], message });
  }
});

export function sameEpisodeIdentity(left: EpisodeDraft, right: EpisodeDraft): boolean {
  return left.episode_id === right.episode_id && left.guid === right.guid &&
    left.published_at === right.published_at &&
    (left.guid_is_permalink ?? false) === (right.guid_is_permalink ?? false);
}

export function episodeDraftFromRevision(revision: EpisodeRevision): EpisodeDraft {
  return episodeDraftSchema.parse(Object.fromEntries(
    Object.keys(episodeDraftSchema.shape).filter((key) => key in revision)
      .map((key) => [key, revision[key as keyof EpisodeDraft]]),
  ));
}

export function parseShowMetadata(source: string): ShowMetadata {
  return showMetadataSchema.parse(TOML.parse(source));
}

export function parseEpisodeDraft(source: string): EpisodeDraft {
  return episodeDraftSchema.parse(TOML.parse(source));
}

export function parseEpisodeRevision(source: string): EpisodeRevision {
  return episodeRevisionSchema.parse(TOML.parse(source));
}

export function stringifyToml(value: SqliteServiceConfig | AdminConfig | ShowMetadata | EpisodeDraft | EpisodeRevision): string {
  return TOML.stringify(value as TOML.JsonMap);
}
