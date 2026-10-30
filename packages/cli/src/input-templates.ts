import { stringifyToml, showMetadataSchema, episodeDraftSchema } from "@castloop/shared";
import type { ShowMetadata, EpisodeDraft } from "@castloop/shared";
import { sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";

export function showTemplate(showId: string, siteUrl?: string): ShowMetadata {
  return showMetadataSchema.parse({ schema_version: 1, show_id: showId, title: showId,
    description: "Edit this description before publication", language: "ja", author: "Edit author", owner_name: "Edit owner",
    owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
    ...(siteUrl === undefined ? { site_mode: "builtin" } : { site_url: siteUrl }), image_path: "cover.jpg" });
}

export function episodeTemplate(episodeId: string, guid: string, publishedAt: string): EpisodeDraft {
  return episodeDraftSchema.parse({ schema_version: 1, episode_id: episodeId, guid, title: episodeId,
    description: "Edit this description before publication", published_at: publishedAt });
}

export function inputTemplate(kind: string): string {
  const note = "# EXAMPLES ONLY: ask the administrator for missing values; do not upload or publish examples.\n" +
    "# Preserve IDs from create-show/create-episode; Episode GUID/date are examples, not identities to reuse.\n";
  if (kind === "admin-config") return "# Optional workspace CLI preferences. No secrets, targets or approvals.\n" +
    "# Omit timezone to use the server basis (UTC); --timezone overrides this preference.\n" +
    stringifyToml({ schema_version: 1, timezone: "Asia/Tokyo" });
  if (kind === "show") return note +
    "# Builtin websites omit site_url; optional site_timezone=\"Asia/Tokyo\" (default UTC) and site_css_path=\"site.css\".\n" +
    "# For external websites, set site_mode=\"external\" and site_url; omit site_timezone and site_css_path.\n" +
    "# image_path and site_css_path name files beside show.toml; do not put generated site_css in local TOML.\n" +
    stringifyToml(showTemplate("samplepodcast"));
  if (kind === "episode") return note + "# Dates are quoted RFC 3339 strings; retain the GUID/date from create-episode when editing.\n" +
    stringifyToml(episodeTemplate("first", "550e8400-e29b-41d4-a716-446655440000", "2026-01-02T10:00:00+09:00"));
  if (kind === "service-config") return note + "# Only init creates a service. Never adopt remote resources using this example.\n" + stringifyToml(sqliteServiceConfigSchema.parse({
    schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1", service_id: "sample",
    account_id: "0".repeat(32), bucket_name: "example-private-bucket", worker_name: "castloop-example",
    public_base_url: "https://castloop-example.example.workers.dev", workers_dev_base_url: "https://castloop-example.example.workers.dev",
  }));
  throw new Error("Choose service-config, admin-config, show or episode");
}
