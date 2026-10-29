import { sqlitePublicationRuntimeSchema } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import { sqliteUpdateActivateSchema, sqliteUpdatePrepareSchema, sqliteUpdateResultSchema } from "../packages/shared/src/sqlite-runtime-update";
import type { SqliteUpdateActivate, SqliteUpdatePrepare, SqliteUpdateResult, SqliteUpdateSummary } from "../packages/shared/src/sqlite-runtime-update";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import type { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { SQLITE_CONTENT_SCHEMA_VERSION, SQLITE_QUEUE_SCHEMA_VERSION } from "./sqlite-publication-queue";
import { initializeSqliteDomains, selectPreparedDomainRuntime } from "./sqlite-domain-runtime";

type UpdateRow = { sequence: number; operation_id: string; state: "prepared" | "activated" | "completed";
  request_json: string; activation_json: string | null };
export function initializeSqliteUpdates(storage: PublicationQueueStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_runtime_updates (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT UNIQUE NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared', 'activated', 'completed')), request_json TEXT NOT NULL, activation_json TEXT)`);
  storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS publication_one_runtime_update ON publication_runtime_updates ((1)) WHERE state != 'completed'");
}
export function pendingSqliteUpdate(storage: PublicationQueueStorage): boolean {
  return storage.sql.exec("SELECT operation_id FROM publication_runtime_updates WHERE state != 'completed'").toArray().length !== 0;
}
export function selectSqliteRuntime(storage: PublicationQueueStorage, actual: SqlitePublicationRuntime): SqlitePublicationRuntime {
  if (storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'publication_queue_schema'").toArray().length &&
    storage.sql.exec<{ version: number }>("SELECT version FROM publication_queue_schema WHERE id = 1").toArray()[0]?.version !== SQLITE_QUEUE_SCHEMA_VERSION) throw new Error("SQLite runtime update cannot convert an older queue schema");
  if (storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'publication_content_schema'").toArray().length &&
    storage.sql.exec<{ version: number }>("SELECT version FROM publication_content_schema WHERE id = 1").toArray()[0]?.version !== SQLITE_CONTENT_SCHEMA_VERSION) throw new Error("SQLite runtime update cannot convert an older content schema");
  initializeSqliteUpdates(storage);
  initializeSqliteDomains(storage);
  if (!storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'publication_service'").toArray().length) return actual;
  const saved = sqlitePublicationRuntimeSchema.parse(storage.sql.exec("SELECT service_id, worker_version_id, service_config_sha256 FROM publication_service WHERE id = 1").toArray()[0]);
  if (saved.service_id !== actual.service_id) throw new Error("SQLite service configuration cannot change through a code update");
  if (saved.service_config_sha256 !== actual.service_config_sha256) {
    if (selectPreparedDomainRuntime(storage, saved, actual)) return saved;
    throw new Error("SQLite service configuration cannot change through a code update");
  }
  if (saved.worker_version_id !== actual.worker_version_id) {
    const pending = storage.sql.exec<UpdateRow>("SELECT * FROM publication_runtime_updates WHERE state = 'prepared'").toArray()[0];
    const request = pending ? sqliteUpdatePrepareSchema.parse(JSON.parse(pending.request_json)) : null;
    const service = storage.sql.exec<{ state: string }>("SELECT state FROM publication_service WHERE id = 1").toArray()[0];
    if (!request || request.worker_version_id !== saved.worker_version_id || request.service_id !== saved.service_id ||
      request.service_config_sha256 !== saved.service_config_sha256 || service.state !== "paused") throw new Error("New SQLite runtime has no exact drained maintenance preparation");
  }
  return saved;
}

export class SqliteRuntimeUpdates {
  constructor(private readonly storage: PublicationQueueStorage, private readonly queue: SqlitePublicationQueue,
    private readonly actual: SqlitePublicationRuntime, private readonly ready: () => boolean) { initializeSqliteUpdates(storage); }
  private row(operationId?: string): UpdateRow | null {
    return (operationId ? this.storage.sql.exec<UpdateRow>("SELECT * FROM publication_runtime_updates WHERE operation_id = ?", operationId) :
      this.storage.sql.exec<UpdateRow>("SELECT * FROM publication_runtime_updates ORDER BY sequence DESC LIMIT 1")).toArray()[0] ?? null;
  }
  summary(): SqliteUpdateSummary | null {
    const row = this.row(); if (!row) return null;
    const request = sqliteUpdatePrepareSchema.parse(JSON.parse(row.request_json));
    const activation = row.activation_json ? sqliteUpdateActivateSchema.parse(JSON.parse(row.activation_json)) : null;
    const setup = this.storage.sql.exec<{ operation_id: string; state: string }>("SELECT operation_id, state FROM publication_runtime_setup WHERE id = 1").toArray()[0];
    return { operation_id: row.operation_id, state: setup?.operation_id === row.operation_id && setup.state === "blocked" ? "blocked" : row.state,
      previous_worker_version_id: request.worker_version_id, new_worker_version_id: activation?.new_worker_version_id ?? null };
  }
  statusById(operationId: string): SqliteUpdateResult {
    sqliteUpdatePrepareSchema.shape.operation_id.parse(operationId);
    const row = this.row(operationId);
    if (!row) throw new Error("SQLite runtime update is missing");
    return this.status(sqliteUpdatePrepareSchema.parse(JSON.parse(row.request_json)));
  }
  status(input: SqliteUpdatePrepare): SqliteUpdateResult {
    const request = sqliteUpdatePrepareSchema.parse(input), row = this.row(request.operation_id), snapshot = this.queue.snapshot();
    if (!row || row.request_json !== JSON.stringify(request) || snapshot.state !== "paused" || !snapshot.drained || this.summary()?.operation_id !== request.operation_id) {
      throw new Error("SQLite update evidence differs or is no longer the latest paused operation");
    }
    return sqliteUpdateResultSchema.parse({ ...this.actual, protocol: "sqlite-sequential-v1", request, update: this.summary(), paused: true, drained: true });
  }
  prepare(input: SqliteUpdatePrepare): SqliteUpdateResult {
    const request = sqliteUpdatePrepareSchema.parse(input), existing = this.row(request.operation_id);
    if (existing) return this.status(request);
    this.storage.transactionSync(() => {
      const identity = this.queue.identity(), snapshot = this.queue.snapshot();
      if (!this.ready() || identity.worker_version_id !== this.actual.worker_version_id || request.worker_version_id !== identity.worker_version_id ||
        request.service_id !== identity.service_id || request.service_config_sha256 !== identity.service_config_sha256 ||
        snapshot.state !== "paused" || !snapshot.drained || pendingSqliteUpdate(this.storage)) throw new Error("SQLite update preparation requires the exact ready, paused, drained runtime");
      this.storage.sql.exec("INSERT INTO publication_runtime_updates (operation_id, state, request_json) VALUES (?, 'prepared', ?)", request.operation_id, JSON.stringify(request));
    });
    return this.status(request);
  }
  async activate(input: SqliteUpdateActivate): Promise<SqliteUpdateResult> {
    const request = sqliteUpdateActivateSchema.parse(input), { new_worker_version_id, deployment_id, script_etag, ...prepared } = request;
    const row = this.row(request.operation_id);
    if (!row || row.request_json !== JSON.stringify(prepared)) throw new Error("SQLite activation has no exact prepared update");
    if (row.activation_json) {
      if (row.activation_json !== JSON.stringify(request)) throw new Error("Keep the frozen SQLite activation receipt");
      return this.status(prepared);
    }
    if (row.state !== "prepared" || this.actual.worker_version_id !== new_worker_version_id || new_worker_version_id === request.worker_version_id ||
      this.actual.service_id !== request.service_id || this.actual.service_config_sha256 !== request.service_config_sha256 ||
      this.queue.identity().worker_version_id !== request.worker_version_id) throw new Error("SQLite activation does not match the executing new version");
    await this.queue.changeRuntime(this.actual, () => {
      this.storage.sql.exec("UPDATE publication_runtime_updates SET state = 'activated', activation_json = ? WHERE operation_id = ?", JSON.stringify(request), request.operation_id);
      this.storage.sql.exec("UPDATE publication_runtime_setup SET operation_id = ?, state = 'scheduled', request_json = ? WHERE id = 1", request.operation_id,
        JSON.stringify({ ...this.actual, operation_id: request.operation_id }));
    });
    return this.status(prepared);
  }
}
