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

export class SqlitePublicationQueue {
  executor?: SqlitePublicationExecutor;
  constructor(private readonly storage: PublicationQueueStorage, private runtime: SqlitePublicationRuntime,
    private readonly now: () => number = Date.now, private readonly scope?: { showId: string; ready: () => boolean }) {
    this.runtime = sqlitePublicationRuntimeSchema.parse(runtime);
    storage.transactionSync(() => {
      storage.sql.exec("CREATE TABLE IF NOT EXISTS publication_queue_schema (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)");
      const schema = storage.sql.exec<{ version: number }>("SELECT version FROM publication_queue_schema WHERE id = 1").toArray()[0];
      if (schema && schema.version !== SQLITE_QUEUE_SCHEMA_VERSION) throw new Error("Unsupported SQLite publication schema; do not reset stored state");
      storage.sql.exec("INSERT OR IGNORE INTO publication_queue_schema (id, version) VALUES (1, ?)", SQLITE_QUEUE_SCHEMA_VERSION);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_service (
        id INTEGER PRIMARY KEY CHECK(id = 1), service_id TEXT NOT NULL, service_config_sha256 TEXT NOT NULL)`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_schedules (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL UNIQUE, show_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('show', 'episode')), episode_id TEXT,
        version INTEGER NOT NULL CHECK(version > 0), state TEXT NOT NULL CHECK(state IN ('scheduled', 'needs_approval', 'dispatched', 'cancelled', 'failed')),
        reason_code TEXT, scheduled_at TEXT NOT NULL, scheduled_at_ms INTEGER NOT NULL, timezone TEXT NOT NULL, timezone_source TEXT NOT NULL,
        resolution_source TEXT NOT NULL, local_input TEXT NOT NULL, local_datetime TEXT NOT NULL, local_offset TEXT NOT NULL,
        input_offset TEXT, preview_sha256 TEXT NOT NULL,
        request_sha256 TEXT NOT NULL, request_json TEXT NOT NULL, revision_id TEXT,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, dispatched_at_ms INTEGER, cancelled_at_ms INTEGER,
        CHECK ((kind = 'show' AND episode_id IS NULL) OR (kind = 'episode' AND episode_id IS NOT NULL)),
        CHECK ((state = 'dispatched') = (dispatched_at_ms IS NOT NULL)),
        CHECK ((state = 'cancelled') = (cancelled_at_ms IS NOT NULL)))`);
      storage.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS publication_one_open_schedule
        ON publication_schedules (show_id, kind, COALESCE(episode_id, '')) WHERE state IN ('scheduled', 'needs_approval')`);
      storage.sql.exec("CREATE INDEX IF NOT EXISTS publication_schedules_due ON publication_schedules (state, scheduled_at_ms, sequence)");
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_schedule_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL, version INTEGER NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('create', 'reschedule', 'cancel', 'reapprove', 'dispatch', 'suspend', 'fail')),
        state TEXT NOT NULL, reason_code TEXT, request_sha256 TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL)`);
      storage.sql.exec("CREATE INDEX IF NOT EXISTS publication_schedule_events_schedule ON publication_schedule_events (schedule_id, sequence)");
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
