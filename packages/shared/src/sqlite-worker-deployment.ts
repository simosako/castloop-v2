import { z } from "zod";
import type { SqliteServiceConfig } from "./sqlite-service";

export const SQLITE_WORKER_COMPATIBILITY_DATE = "2026-10-16";
export const sqliteDeploymentReceiptSchema = z.object({
  worker_version_id: z.uuid(), deployment_id: z.uuid(), script_etag: z.string().min(1).max(256),
}).strict();
type SqliteWorkerBinding = { name: "CASTLOOP_BUCKET"; type: "r2_bucket"; bucket_name: string } |
  { name: "CASTLOOP_ADMIN_KEY"; type: "secret_text"; text: string } |
  { name: "CASTLOOP_VERSION_METADATA"; type: "version_metadata" } |
  { name: "CASTLOOP_SQLITE_CONFIG" | "CASTLOOP_SERVICE_ID" | "CASTLOOP_MANAGEMENT_ORIGIN"; type: "plain_text"; text: string } |
  { name: "CASTLOOP_SQLITE"; type: "durable_object_namespace"; class_name: "SqlitePublicationService" };
export type SqliteWorkerUploadMetadata = { main_module: "index.js"; compatibility_date: string; compatibility_flags: string[];
  cache_options: { enabled: true; cross_version_cache: false };
  exports: { default: { type: "worker"; cache: { enabled: false } }; SqliteCachedDecisions: { type: "worker"; cache: { enabled: true } };
    SqliteCachedAssets: { type: "worker"; cache: { enabled: true } };
    SiteCachedPages: { type: "worker"; cache: { enabled: true } }; SqlitePublicationService: { type: "durable-object"; storage: "sqlite" } };
  observability: { enabled: true; logs: { enabled: true }; traces: { enabled: true } }; bindings: SqliteWorkerBinding[] };
export function buildSqliteWorkerMetadata(config: SqliteServiceConfig, adminKey: string): SqliteWorkerUploadMetadata {
  if (!adminKey || adminKey.length > 1024 || /[^\x21-\x7e]/.test(adminKey)) throw new Error("SQLite deployment requires an administrator secret");
  return { main_module: "index.js", compatibility_date: SQLITE_WORKER_COMPATIBILITY_DATE,
    compatibility_flags: ["enable_ctx_exports"], cache_options: { enabled: true, cross_version_cache: false },
    exports: { default: { type: "worker", cache: { enabled: false } }, SqliteCachedDecisions: { type: "worker", cache: { enabled: true } },
      SqliteCachedAssets: { type: "worker", cache: { enabled: true } },
      SiteCachedPages: { type: "worker", cache: { enabled: true } },
      SqlitePublicationService: { type: "durable-object", storage: "sqlite" } },
    observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true } },
    bindings: [{ name: "CASTLOOP_BUCKET", type: "r2_bucket", bucket_name: config.bucket_name },
      { name: "CASTLOOP_ADMIN_KEY", type: "secret_text", text: adminKey },
      { name: "CASTLOOP_VERSION_METADATA", type: "version_metadata" },
      { name: "CASTLOOP_SQLITE_CONFIG", type: "plain_text", text: JSON.stringify(config) },
      { name: "CASTLOOP_SERVICE_ID", type: "plain_text", text: config.service_id },
      { name: "CASTLOOP_MANAGEMENT_ORIGIN", type: "plain_text", text: config.workers_dev_base_url },
      { name: "CASTLOOP_SQLITE", type: "durable_object_namespace", class_name: "SqlitePublicationService" }] };
}
