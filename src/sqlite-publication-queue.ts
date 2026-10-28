import { z } from "zod";
import { sqlitePublicationFailureSchema, sqlitePublicationProtocol, sqlitePublicationRuntimeSchema } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationFailure, SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import { parseSqliteDirectPublicationRequest } from "../packages/shared/src/sqlite-direct-publication";
import type { SqliteDirectPublicationRequest, SqliteDirectPublicationResult } from "../packages/shared/src/sqlite-direct-publication";
import { sqliteAvailabilityRequestSchema, sqliteAvailabilityRecordSchema } from "../packages/shared/src/sqlite-availability";
import type { SqliteAvailabilityRequest, SqliteAvailabilityRecord, SqliteAvailabilityState } from "../packages/shared/src/sqlite-availability";
import { sha256Hex } from "../packages/shared/src/sha256";

export const SQLITE_QUEUE_SCHEMA_VERSION = 13;
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
type ServiceRow = SqlitePublicationRuntime & { state: SqliteAvailabilityState; admission_window_id: string | null; availability_version: number };
export type PublicationQueueSnapshot = { state: SqliteAvailabilityState; admission_window_id: string | null; availability_version: number;
  queued: number; active: null; drained: boolean };

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

export class PublicationQueueConflict extends Error {
  constructor() { super("SQLite publication identity already has another frozen request"); }
}

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
        id INTEGER PRIMARY KEY CHECK(id = 1), service_id TEXT NOT NULL, worker_version_id TEXT NOT NULL,
        service_config_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open', 'admission_paused', 'paused')), admission_window_id TEXT,
        availability_version INTEGER NOT NULL DEFAULT 0 CHECK(availability_version >= 0 AND availability_version <= 9007199254740991))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_availability_controls (
        operation_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, record_json TEXT NOT NULL, opened_window_id TEXT UNIQUE)`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_schedules (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, schedule_id TEXT NOT NULL UNIQUE, show_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('show', 'episode')), episode_id TEXT,
        version INTEGER NOT NULL CHECK(version > 0), state TEXT NOT NULL CHECK(state IN ('scheduled', 'needs_approval', 'dispatched', 'cancelled', 'failed', 'blocked')),
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
        action TEXT NOT NULL CHECK(action IN ('create', 'reschedule', 'cancel', 'reapprove', 'dispatch', 'suspend', 'fail', 'block')),
        state TEXT NOT NULL, reason_code TEXT, request_sha256 TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL)`);
      storage.sql.exec("CREATE INDEX IF NOT EXISTS publication_schedule_events_schedule ON publication_schedule_events (schedule_id, sequence)");
      storage.sql.exec(`INSERT OR IGNORE INTO publication_service
        (id, service_id, worker_version_id, service_config_sha256, state) VALUES (1, ?, ?, ?, 'paused')`,
      this.runtime.service_id, this.runtime.worker_version_id, this.runtime.service_config_sha256);
      this.requireRuntime();
    });
  }

  private service(): ServiceRow {
    const row = this.storage.sql.exec<ServiceRow>("SELECT service_id, worker_version_id, service_config_sha256, state, admission_window_id, availability_version FROM publication_service WHERE id = 1").toArray()[0];
    if (!row) throw new Error("SQLite publication service is missing");
    return row;
  }

  private requireRuntime(): ServiceRow {
    const service = this.service();
    if (service.service_id !== this.runtime.service_id || service.worker_version_id !== this.runtime.worker_version_id ||
      service.service_config_sha256 !== this.runtime.service_config_sha256) {
      throw new Error("SQLite publication runtime differs from its initialized service");
    }
    return service;
  }

  scheduleAdmission(input: SqliteDirectPublicationRequest): "open" | "paused" | "runtime_mismatch" | "stale_window" {
    const service = this.requireRuntime();
    if (service.state !== "open") return "paused";
    if (input.service_id !== service.service_id || input.worker_version_id !== service.worker_version_id || input.service_config_sha256 !== service.service_config_sha256) return "runtime_mismatch";
    if (input.admission_window_id !== service.admission_window_id) return "stale_window";
    return "open";
  }

  private requirePublication(request: SqliteDirectPublicationRequest, changing: boolean): void {
    const service = this.requireRuntime();
    if (this.scope && (request.show_id !== this.scope.showId || !this.scope.ready())) throw new SqlitePublicationInputError("target_unavailable");
    if (request.service_id !== service.service_id || request.worker_version_id !== service.worker_version_id ||
      request.service_config_sha256 !== service.service_config_sha256) throw new SqlitePublicationInputError("runtime_mismatch");
    if (changing && (service.state !== "open" || request.admission_window_id !== service.admission_window_id)) throw new SqlitePublicationInputError("stale_window");
  }

  async publish(input: SqliteDirectPublicationRequest, applySchedule?: (result: SqliteDirectPublicationResult) => void): Promise<SqliteDirectPublicationResult> {
    const request = parseSqliteDirectPublicationRequest(input), executor = this.executor;
    if (!executor) throw new Error("Publication executor is unavailable");
    this.requirePublication(request, false);
    const current = executor.current(request);
    const result = (revisionId: string, changed: boolean): SqliteDirectPublicationResult => ({ ...this.identity(), protocol: sqlitePublicationProtocol,
      show_id: request.show_id, ...(request.episode_id ? { episode_id: request.episode_id } : {}), result: changed ? "changed" : "unchanged", revision_id: revisionId });
    if (current) return this.storage.transactionSync(() => {
      const reply = result(current, false); applySchedule?.(reply); return reply;
    });
    this.requirePublication(request, true);
    const prepared = await executor.execute(request);
    return this.storage.transactionSync(() => {
      this.requirePublication(request, true);
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

  snapshot(): PublicationQueueSnapshot {
    return this.storage.transactionSync(() => {
      const service = this.requireRuntime();
      return { state: service.state, admission_window_id: service.admission_window_id, availability_version: service.availability_version,
        queued: 0, active: null, drained: true };
    });
  }

  pause(): PublicationQueueSnapshot {
    return this.storage.transactionSync(() => {
      this.requireRuntime();
      this.storage.sql.exec("UPDATE publication_service SET state = 'paused' WHERE id = 1");
      return this.snapshot();
    });
  }

  controlRecord(operationId: string): SqliteAvailabilityRecord | null {
    sqliteAvailabilityRequestSchema.shape.operation_id.parse(operationId);
    const row = this.storage.sql.exec<{ request_json: string; record_json: string }>(
      "SELECT request_json, record_json FROM publication_availability_controls WHERE operation_id = ?", operationId).toArray()[0];
    if (!row) return null;
    const record = sqliteAvailabilityRecordSchema.parse(JSON.parse(row.record_json));
    if (record.request.operation_id !== operationId || row.request_json !== JSON.stringify(record.request)) throw new Error("Stored Show control differs");
    return record;
  }

  async applyControl(input: SqliteAvailabilityRequest, actual = this.runtime,
    suspendSchedules?: (reason: "show_paused" | "show_admission_paused") => void): Promise<SqliteAvailabilityRecord> {
    const request = sqliteAvailabilityRequestSchema.parse(input), source = JSON.stringify(request);
    const hash = await sha256Hex(source);
    const result = this.storage.transactionSync(() => {
      const service = this.requireRuntime();
      if (request.service_id !== actual.service_id || request.worker_version_id !== actual.worker_version_id ||
        request.service_config_sha256 !== actual.service_config_sha256 || this.scope && request.show_id !== this.scope.showId) {
        throw new Error("Show control target differs");
      }
      const previous = this.controlRecord(request.operation_id);
      if (previous) {
        if (JSON.stringify(previous.request) !== source || previous.request_sha256 !== hash) throw new PublicationQueueConflict();
        return previous;
      }
      if (request.expected_availability_version !== service.availability_version) throw new Error("Show control observation is stale");
      if (request.action !== "pause" && this.scope && !this.scope.ready()) throw new Error("Show control requires verified runtime outside maintenance");
      if (request.action === "pause" || request.action === "admission-pause") {
        suspendSchedules?.(request.action === "pause" ? "show_paused" : "show_admission_paused");
      }
      let state = service.state, window = service.admission_window_id;
      if (request.action === "pause") state = "paused";
      else if (request.action === "admission-pause") { if (state === "open") state = "admission_paused"; }
      else {
        if (!this.snapshot().drained || state === "open") throw new Error("Show resume requires a drained stopped queue");
        if (request.action === "delivery-resume") state = "admission_paused";
        else {
          if (window === request.admission_window_id) throw new Error("Resume requires a new explicit admission window");
          window = request.admission_window_id!;
          state = "open";
        }
      }
      const record = sqliteAvailabilityRecordSchema.parse({ request, request_sha256: hash, applied_at_ms: this.now(),
        result: { state, admission_window_id: window, availability_version: service.availability_version + 1 } });
      this.storage.sql.exec(`INSERT INTO publication_availability_controls (operation_id, request_json, record_json, opened_window_id)
        VALUES (?, ?, ?, ?)`, request.operation_id, source, JSON.stringify(record), request.action === "resume" ? window : null);
      this.storage.sql.exec("UPDATE publication_service SET state = ?, admission_window_id = ?, availability_version = ? WHERE id = 1",
        state, window, record.result.availability_version);
      return record;
    });
    await this.storage.sync();
    return result;
  }

  resume(windowId: string): PublicationQueueSnapshot {
    z.uuid().parse(windowId);
    return this.storage.transactionSync(() => {
      if (this.scope && !this.scope.ready()) throw new Error("Show resume requires its verified runtime outside maintenance");
      const current = this.snapshot();
      if (current.state === "open" && current.admission_window_id === windowId) return current;
      if (current.state !== "paused" || !current.drained || current.admission_window_id === windowId) {
        throw new Error("Resume requires a drained paused queue and a new explicit admission window");
      }
      this.storage.sql.exec("UPDATE publication_service SET state = 'open', admission_window_id = ? WHERE id = 1", windowId);
      return this.snapshot();
    });
  }

  async confirm(): Promise<void> { await this.storage.sync(); }

  async changeRuntime(input: SqlitePublicationRuntime, apply: () => undefined): Promise<void> {
    const next = sqlitePublicationRuntimeSchema.parse(input);
    await this.storage.transaction(async () => {
      const current = this.requireRuntime(), snapshot = this.snapshot();
      if (current.service_id !== next.service_id || current.service_config_sha256 !== next.service_config_sha256 ||
        current.worker_version_id === next.worker_version_id || snapshot.state !== "paused" || !snapshot.drained) throw new Error("SQLite runtime change requires compatible drained maintenance");
      if (apply() !== undefined) throw new Error("SQLite runtime preparation must be synchronous");
      this.storage.sql.exec("UPDATE publication_service SET worker_version_id = ? WHERE id = 1", next.worker_version_id);
      await this.storage.setAlarm(this.now());
    });
    this.runtime = next;
  }

  async changeConfiguration(input: SqlitePublicationRuntime, previous: SqlitePublicationRuntime, apply: () => undefined): Promise<void> {
    const next = sqlitePublicationRuntimeSchema.parse(input);
    await this.storage.transaction(async () => {
      const current = this.requireRuntime(), snapshot = this.snapshot();
      if (JSON.stringify(this.identity()) !== JSON.stringify(sqlitePublicationRuntimeSchema.parse(previous)) ||
        current.service_id !== next.service_id || current.service_config_sha256 === next.service_config_sha256 ||
        current.worker_version_id === next.worker_version_id || snapshot.state !== "paused" || !snapshot.drained) throw new Error("Configuration change requires its exact paused drained preparation");
      if (apply() !== undefined) throw new Error("Configuration activation must be synchronous");
      this.storage.sql.exec("UPDATE publication_service SET worker_version_id = ?, service_config_sha256 = ? WHERE id = 1", next.worker_version_id, next.service_config_sha256);
      await this.storage.setAlarm(this.now());
    });
    this.runtime = next;
  }
}
