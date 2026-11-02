import { sqlitePublicationFailureSchema, sqlitePublicationProtocol, sqlitePublicationRuntimeSchema } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationFailure, SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import { parseSqliteDirectPublicationRequest } from "../packages/shared/src/sqlite-direct-publication";
import type { SqliteDirectPublicationRequest, SqliteDirectPublicationResult } from "../packages/shared/src/sqlite-direct-publication";

export const SQLITE_QUEUE_SCHEMA_VERSION = 14;
export const SQLITE_CONTENT_SCHEMA_VERSION = 13;

type Binding = string | number | null;
export type PublicationSql = {
  readonly databaseSize?: number;
  exec: <Row extends Record<string, Binding>>(query: string, ...bindings: Binding[]) => { toArray: () => Row[] };
};
export type PublicationQueueStorage = {
  sql: PublicationSql;
  transactionSync: <T>(callback: () => T) => T;
  transaction: <T>(callback: () => Promise<T>) => Promise<T>;
  getAlarm: () => Promise<number | null>;
  setAlarm: (time: number) => Promise<void>;
  sync: () => Promise<void>;
};
type ServiceRow = { service_id: string; service_config_sha256: string };

export class SqlitePublicationInputError extends Error {
  readonly reason: SqlitePublicationFailure;
  constructor(reason: SqlitePublicationFailure) {
    super(`SQLite publication input error: ${sqlitePublicationFailureSchema.parse(reason)}`);
    this.reason = reason;
  }
}

export type SqlitePublicationExecutor = {
  current: (request: SqliteDirectPublicationRequest) => string | null;
  execute: (request: SqliteDirectPublicationRequest) => Promise<{ revisionId: string; commit: () => void }>;
};

export function ensureSchemaVersionTable(storage: PublicationQueueStorage, table: string, version: number, mismatch: string): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)`);
  const saved = storage.sql.exec<{ version: number }>(`SELECT version FROM ${table} WHERE id = 1`).toArray()[0];
  if (saved && saved.version !== version) throw new Error(mismatch);
  storage.sql.exec(`INSERT OR IGNORE INTO ${table} (id, version) VALUES (1, ?)`, version);
}

export class SqlitePublicationQueue {
  executor?: SqlitePublicationExecutor;
  constructor(private readonly storage: PublicationQueueStorage, private runtime: SqlitePublicationRuntime,
    private readonly scope?: { showId: string; ready: () => boolean }) {
    this.runtime = sqlitePublicationRuntimeSchema.parse(runtime);
    storage.transactionSync(() => {
      ensureSchemaVersionTable(storage, "publication_queue_schema", SQLITE_QUEUE_SCHEMA_VERSION,
        "Unsupported SQLite publication schema; do not reset stored state");
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_service (
        id INTEGER PRIMARY KEY CHECK(id = 1), service_id TEXT NOT NULL, service_config_sha256 TEXT NOT NULL)`);
      storage.sql.exec("INSERT OR IGNORE INTO publication_service (id, service_id, service_config_sha256) VALUES (1, ?, ?)",
        this.runtime.service_id, this.runtime.service_config_sha256);
      this.requireRuntime();
    });
  }

  private service(): ServiceRow {
    const row = this.storage.sql.exec<ServiceRow>("SELECT service_id, service_config_sha256 FROM publication_service WHERE id = 1").toArray()[0];
    if (!row) throw new Error("SQLite publication service is missing");
    return row;
  }

  private requireRuntime(): ServiceRow {
    const service = this.service();
    if (service.service_id !== this.runtime.service_id || service.service_config_sha256 !== this.runtime.service_config_sha256) {
      throw new Error("SQLite publication runtime differs from its initialized service");
    }
    return service;
  }

  admits(input: SqliteDirectPublicationRequest): boolean {
    const service = this.service();
    return input.service_id === service.service_id && input.service_config_sha256 === service.service_config_sha256;
  }

  private requirePublication(request: SqliteDirectPublicationRequest): void {
    const service = this.requireRuntime();
    if (this.scope && (request.show_id !== this.scope.showId || !this.scope.ready())) throw new SqlitePublicationInputError("target_unavailable");
    if (request.service_id !== service.service_id || request.service_config_sha256 !== service.service_config_sha256) {
      throw new SqlitePublicationInputError("runtime_mismatch");
    }
  }

  async publish(input: SqliteDirectPublicationRequest, applySchedule?: (result: SqliteDirectPublicationResult) => void): Promise<SqliteDirectPublicationResult> {
    const request = parseSqliteDirectPublicationRequest(input), executor = this.executor;
    if (!executor) throw new Error("Publication executor is unavailable");
    this.requirePublication(request);
    const current = executor.current(request);
    const result = (revisionId: string, changed: boolean): SqliteDirectPublicationResult => ({ ...this.identity(), protocol: sqlitePublicationProtocol,
      show_id: request.show_id, ...(request.episode_id ? { episode_id: request.episode_id } : {}), result: changed ? "changed" : "unchanged", revision_id: revisionId });
    if (current) return this.storage.transactionSync(() => {
      const reply = result(current, false); applySchedule?.(reply); return reply;
    });
    this.requirePublication(request);
    const prepared = await executor.execute(request);
    return this.storage.transactionSync(() => {
      this.requirePublication(request);
      prepared.commit();
      const reply = result(prepared.revisionId, true);
      applySchedule?.(reply);
      return reply;
    });
  }

  identity(): SqlitePublicationRuntime {
    this.requireRuntime();
    return { ...this.runtime };
  }

  async changeConfiguration(input: SqlitePublicationRuntime, apply: () => undefined): Promise<void> {
    const next = sqlitePublicationRuntimeSchema.parse(input);
    await this.storage.transaction(async () => {
      const current = this.requireRuntime();
      if (current.service_id !== next.service_id || current.service_config_sha256 === next.service_config_sha256) {
        throw new Error("Configuration change requires its exact domain preparation");
      }
      if (apply() !== undefined) throw new Error("Configuration change must be synchronous");
      this.storage.sql.exec("UPDATE publication_service SET service_config_sha256 = ? WHERE id = 1", next.service_config_sha256);
      await this.storage.sync();
    });
    this.runtime = next;
  }
}
