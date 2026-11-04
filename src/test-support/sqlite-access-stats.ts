import { ACCESS_STATS_FORMAT } from "../../packages/shared/src/access-stats";
import { sqliteAccessStatsReplaceRequestSchema, sqliteAccessStatsSourceSchema } from "../../packages/shared/src/sqlite-access-stats";
import type { SqliteAccessStatsReplaceRequest } from "../../packages/shared/src/sqlite-access-stats";
import { parseSqliteDomainRequest, sqliteDomainRequestHash } from "../../packages/shared/src/sqlite-domain";
import { sqliteServiceConfigHash } from "../../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../packages/shared/src/sqlite-service";
import { SqliteAccessStats } from "../sqlite-access-stats";
import { initializeSqliteDomains } from "../sqlite-domain-runtime";
import { SqlitePublicationContent } from "../sqlite-publication-content";
import { seedPublishedEpisode, sqlitePublicationFixture } from "./sqlite-publication";
import { createHash } from "node:crypto";

export function sqliteAccessStatsFixture() {
  const fixture = sqlitePublicationFixture();
  new SqlitePublicationContent(fixture.storage);
  const revisionId = seedPublishedEpisode(fixture.storage);
  initializeSqliteDomains(fixture.storage);
  const config: SqliteServiceConfig = { schema_version: 2, storage_layout: "show-v1", publication_protocol: "sqlite-sequential-v1",
    service_id: fixture.runtime.service_id, account_id: "a".repeat(32), bucket_name: "private-bucket", worker_name: "test-worker",
    public_base_url: "https://media.example.com", workers_dev_base_url: "https://test-worker.example.workers.dev" };
  const metadata = { schema_version: 1, show_id: "daily", title: "Daily", description: "Daily podcast", language: "ja",
    author: "Test", owner_name: "Test", owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
    image_path: "cover.jpg", site_mode: "builtin" };
  fixture.storage.sql.exec(`INSERT INTO publication_show_content
    (show_id, metadata_json, cover_generation, cover_extension, cover_sha256, cover_length_bytes) VALUES ('daily', ?, 1, 'jpg', ?, 100)`,
  JSON.stringify(metadata), "a".repeat(64));
  let now = Date.parse("2026-11-04T12:00:00Z");
  const stats = new SqliteAccessStats(fixture.storage, "daily", fixture.queue, config, () => now);
  const source = sqliteAccessStatsSourceSchema.parse({ source_id: `http_logpush:${"b".repeat(32)}:media.example.com`,
    collector: "http_logpush", zone_id: "b".repeat(32), host: "media.example.com", metric_definition: ACCESS_STATS_FORMAT,
    byte_measurement: "edge_body", collection_mode: "best_effort", collection_started_at_ms: Date.parse("2025-01-01T00:00:00Z"),
    collection_ended_at_ms: null, last_complete_at_ms: null, interruptions: [] });
  const resourcePath = `/podcasts/daily/episodes/first/${revisionId}.mp3`;
  const identity = { ...fixture.identity, show_id: "daily" };
  const update = (date = "2026-11-03", count = 1, changes: Partial<SqliteAccessStatsReplaceRequest> = {}) => {
    const daily = { format: ACCESS_STATS_FORMAT, source_id: source.source_id, show_id: "daily", date_utc: date,
      resource_path: resourcePath, resource_kind: "audio", episode_id: "first", audio_revision_id: revisionId,
      counters: { get_200_requests: count, get_206_requests: 0, head_requests: 0, not_modified_requests: 0,
        response_bytes: count * 100, cache_status_requests: { hit: count } } };
    return sqliteAccessStatsReplaceRequestSchema.parse({ ...identity, source, expected_source_version: 0, daily,
      expected_version: 0, input_sha256: createHash("sha256").update(JSON.stringify(daily)).digest("hex"), read_at_ms: now,
      input_min_at_ms: count ? Date.parse(`${date}T12:00:00Z`) : null,
      input_max_at_ms: count ? Date.parse(`${date}T12:00:00Z`) : null, ...changes });
  };
  const query = (from = "2026-11-03", to = from) => ({ ...identity, source_id: source.source_id,
    resource_path: resourcePath, from_date_utc: from, to_date_utc: to });
  return { ...fixture, stats, source, config, resourcePath, revisionId, identity, update, query, setNow: (at: number) => { now = at; } };
}

export async function saveAccessStatsDomain(fixture: ReturnType<typeof sqliteAccessStatsFixture>, hostname: string): Promise<void> {
  const previous = { ...fixture.config, public_base_url: fixture.config.workers_dev_base_url };
  const target = { ...fixture.config, public_base_url: `https://${hostname}` };
  const domain = await parseSqliteDomainRequest({ schema_version: 1, protocol: "sqlite-domain-change-v1", action: "add",
    operation_id: crypto.randomUUID(), hostname, zone_id: fixture.source.zone_id, zone_name: "example.com", namespace_id: "c".repeat(32),
    previous_config: previous, previous_config_sha256: await sqliteServiceConfigHash(previous),
    target_config: target, target_config_sha256: await sqliteServiceConfigHash(target), worker_source_sha256: "d".repeat(64), worker_metadata_sha256: "e".repeat(64) });
  const digest = await sqliteDomainRequestHash(domain);
  const commit = { operation_id: domain.operation_id, request_sha256: digest, worker_version_id: crypto.randomUUID(),
    deployment_id: crypto.randomUUID(), script_etag: "test-etag", connection: { id: "old-domain", cert_id: crypto.randomUUID(),
      hostname, zone_id: fixture.source.zone_id, zone_name: "example.com", service: fixture.config.worker_name,
      environment: "production", enabled: true, previews_enabled: false } };
  fixture.storage.sql.exec(`INSERT INTO publication_domain_changes (operation_id, request_json, request_sha256, commit_json, state)
    VALUES (?, ?, ?, ?, 'completed')`, domain.operation_id, JSON.stringify(domain), digest, JSON.stringify(commit));
}
