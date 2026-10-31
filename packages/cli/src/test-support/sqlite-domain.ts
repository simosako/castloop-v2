import { SQLITE_DOMAIN_PROTOCOL } from "../../../shared/src/sqlite-domain";
import { sqliteServiceConfigHash } from "../../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../../shared/src/sqlite-service";

export async function customDomainRequest(f: { config: SqliteServiceConfig }) {
  const target = { ...f.config, public_base_url: "https://podcasts.example.com" };
  const request = { schema_version: 1 as const, protocol: SQLITE_DOMAIN_PROTOCOL, operation_id: crypto.randomUUID(), action: "add" as const,
    hostname: "podcasts.example.com", zone_id: "c".repeat(32), zone_name: "example.com", namespace_id: "b".repeat(32),
    previous_config: f.config, previous_config_sha256: await sqliteServiceConfigHash(f.config), target_config: target,
    target_config_sha256: await sqliteServiceConfigHash(target), worker_source_sha256: "d".repeat(64), worker_metadata_sha256: "e".repeat(64) };
  const connection = { id: "f".repeat(32), cert_id: crypto.randomUUID(), hostname: request.hostname, zone_id: request.zone_id,
    zone_name: request.zone_name, service: f.config.worker_name, environment: "production" as const, enabled: true as const, previews_enabled: false as const };
  return { target, request, connection };
}
