import { sqliteDomainRequestSchema } from "../packages/shared/src/sqlite-domain";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import { SQLITE_CONTENT_SCHEMA_VERSION, SQLITE_QUEUE_SCHEMA_VERSION } from "./sqlite-publication-queue";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import { initializeSqliteDomains } from "./sqlite-domain-runtime";

// The running identity comes from the environment; only the service configuration hash is persisted so that
// an ordinary code deploy cannot change the configuration without a prepared domain change.
export function resolveSqliteRuntime(storage: PublicationQueueStorage, actual: SqlitePublicationRuntime): SqlitePublicationRuntime {
  if (storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'publication_queue_schema'").toArray().length &&
    storage.sql.exec<{ version: number }>("SELECT version FROM publication_queue_schema WHERE id = 1").toArray()[0]?.version !== SQLITE_QUEUE_SCHEMA_VERSION) throw new Error("SQLite runtime cannot convert an older queue schema");
  if (storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'publication_content_schema'").toArray().length &&
    storage.sql.exec<{ version: number }>("SELECT version FROM publication_content_schema WHERE id = 1").toArray()[0]?.version !== SQLITE_CONTENT_SCHEMA_VERSION) throw new Error("SQLite runtime cannot convert an older content schema");
  initializeSqliteDomains(storage);
  if (!storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'publication_service'").toArray().length) return actual;
  const saved = storage.sql.exec<{ service_id: string; service_config_sha256: string }>(
    "SELECT service_id, service_config_sha256 FROM publication_service WHERE id = 1").toArray()[0];
  if (!saved) return actual;
  if (saved.service_id !== actual.service_id) throw new Error("SQLite service configuration cannot change through a code update");
  if (saved.service_config_sha256 === actual.service_config_sha256) return actual;
  const prepared = storage.sql.exec<{ request_json: string }>(
    "SELECT request_json FROM publication_domain_changes WHERE state = 'prepared'").toArray()[0];
  if (prepared) {
    const request = sqliteDomainRequestSchema.parse(JSON.parse(prepared.request_json));
    if (request.previous_config_sha256 === saved.service_config_sha256 && request.target_config_sha256 === actual.service_config_sha256) {
      return { service_id: actual.service_id, worker_version_id: actual.worker_version_id, service_config_sha256: saved.service_config_sha256 };
    }
  }
  throw new Error("SQLite service configuration cannot change through a code update");
}
