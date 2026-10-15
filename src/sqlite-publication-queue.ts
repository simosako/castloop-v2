import { parseSqlitePublicationRequest, sqlitePublicationBlockSchema, sqlitePublicationFailureSchema,
  sqlitePublicationProtocol, sqlitePublicationRequestHash, sqlitePublicationRequestSchema, sqlitePublicationRuntimeSchema,
  sqlitePublicationStatusSchema } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationBlock, SqlitePublicationFailure, SqlitePublicationRequest,
  SqlitePublicationRuntime, SqlitePublicationStatus } from "../packages/shared/src/sqlite-publication";

type Binding = string | number | null;
export type PublicationSql = {
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
type ServiceRow = SqlitePublicationRuntime & { state: "open" | "paused"; admission_window_id: string | null };
type JobRow = { sequence: number; request_id: string; job_id: string; request_sha256: string; request_json: string;
  state: SqlitePublicationStatus["state"]; reason_code: string | null };
export type PublicationQueueSnapshot = { state: "open" | "paused"; admission_window_id: string | null;
  queued: number; active: SqlitePublicationStatus | null; drained: boolean };
export type PublicationClaim = { state: "idle" } | { state: "blocked"; job: SqlitePublicationStatus } |
  { state: "interrupted"; job: SqlitePublicationStatus } |
  { state: "claimed"; job: SqlitePublicationStatus; request: SqlitePublicationRequest };

export class PublicationQueueConflict extends Error {
  constructor() { super("SQLite publication identity already has another frozen request"); }
}

export class SqlitePublicationQueue {
  constructor(private readonly storage: PublicationQueueStorage, private readonly runtime: SqlitePublicationRuntime,
    private readonly now: () => number = Date.now) {
    this.runtime = sqlitePublicationRuntimeSchema.parse(runtime);
    storage.transactionSync(() => {
      storage.sql.exec("CREATE TABLE IF NOT EXISTS publication_queue_schema (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)");
      const schema = storage.sql.exec<{ version: number }>("SELECT version FROM publication_queue_schema WHERE id = 1").toArray()[0];
      if (schema && schema.version !== 1) throw new Error("Unsupported SQLite publication schema; do not reset stored state");
      storage.sql.exec("INSERT OR IGNORE INTO publication_queue_schema (id, version) VALUES (1, 1)");
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_service (
        id INTEGER PRIMARY KEY CHECK(id = 1), service_id TEXT NOT NULL, worker_version_id TEXT NOT NULL,
        service_config_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open', 'paused')), admission_window_id TEXT)`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL UNIQUE,
        request_sha256 TEXT NOT NULL, request_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'blocked')), reason_code TEXT)`);
      storage.sql.exec("CREATE INDEX IF NOT EXISTS publication_jobs_pending ON publication_jobs (state, sequence)");
      storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS publication_one_active ON publication_jobs ((1)) WHERE state IN ('running', 'blocked')");
      storage.sql.exec(`INSERT OR IGNORE INTO publication_service
        (id, service_id, worker_version_id, service_config_sha256, state) VALUES (1, ?, ?, ?, 'paused')`,
      this.runtime.service_id, this.runtime.worker_version_id, this.runtime.service_config_sha256);
      this.requireRuntime();
    });
  }

  private service(): ServiceRow {
    const row = this.storage.sql.exec<ServiceRow>("SELECT service_id, worker_version_id, service_config_sha256, state, admission_window_id FROM publication_service WHERE id = 1").toArray()[0];
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

  private statusRow(row: JobRow): SqlitePublicationStatus {
    return sqlitePublicationStatusSchema.parse({ protocol: sqlitePublicationProtocol, service_id: this.runtime.service_id,
      request_id: row.request_id, job_id: row.job_id, request_sha256: row.request_sha256, sequence: row.sequence,
      state: row.state, ...(row.reason_code === null ? {} : { reason_code: row.reason_code }) });
  }

  private active(): JobRow | undefined {
    return this.storage.sql.exec<JobRow>("SELECT * FROM publication_jobs WHERE state IN ('running', 'blocked')").toArray()[0];
  }

  private byJob(jobId: string): JobRow {
    const row = this.storage.sql.exec<JobRow>("SELECT * FROM publication_jobs WHERE job_id = ?", jobId).toArray()[0];
    if (!row) throw new Error("SQLite publication job is missing");
    return row;
  }

  private async schedule(): Promise<void> {
    if (this.active() || !this.storage.sql.exec<{ sequence: number }>(
      "SELECT sequence FROM publication_jobs WHERE state = 'queued' ORDER BY sequence LIMIT 1").toArray().length) return;
    const alarm = await this.storage.getAlarm();
    if (alarm === null) await this.storage.setAlarm(this.now());
  }

  async enqueue(input: SqlitePublicationRequest): Promise<SqlitePublicationStatus> {
    const request = parseSqlitePublicationRequest(input);
    const source = JSON.stringify(request);
    const hash = await sqlitePublicationRequestHash(request);
    return this.storage.transaction(async () => {
      const service = this.requireRuntime();
      if (request.service_id !== service.service_id) throw new Error("Publication belongs to another service");
      const existing = this.storage.sql.exec<JobRow>("SELECT * FROM publication_jobs WHERE request_id = ? OR job_id = ?",
        request.request_id, request.job_id).toArray();
      if (existing.length) {
        if (existing.length !== 1 || existing[0].request_id !== request.request_id || existing[0].job_id !== request.job_id ||
          existing[0].request_sha256 !== hash || existing[0].request_json !== source) throw new PublicationQueueConflict();
        await this.schedule();
        return this.statusRow(existing[0]);
      }
      if (service.state !== "open") throw new Error("SQLite publication admission is paused");
      if (request.worker_version_id !== service.worker_version_id || request.service_config_sha256 !== service.service_config_sha256 ||
        request.admission_window_id !== service.admission_window_id) throw new Error("Publication runtime or resume window is stale");
      if (this.active()?.state === "blocked") throw new Error("SQLite publication queue is blocked; inspect the retained job");
      this.storage.sql.exec(`INSERT INTO publication_jobs (request_id, job_id, request_sha256, request_json, state)
        VALUES (?, ?, ?, ?, 'queued')`, request.request_id, request.job_id, hash, source);
      await this.schedule();
      return this.statusRow(this.byJob(request.job_id));
    });
  }

  status(requestId: string): SqlitePublicationStatus | null {
    this.requireRuntime();
    const row = this.storage.sql.exec<JobRow>("SELECT * FROM publication_jobs WHERE request_id = ?", requestId).toArray()[0];
    return row ? this.statusRow(row) : null;
  }

  snapshot(): PublicationQueueSnapshot {
    return this.storage.transactionSync(() => {
      const service = this.requireRuntime();
      const active = this.active();
      const queued = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publication_jobs WHERE state = 'queued'").toArray()[0]!.count;
      return { state: service.state, admission_window_id: service.admission_window_id, queued,
        active: active ? this.statusRow(active) : null, drained: queued === 0 && active === undefined };
    });
  }

  pause(): PublicationQueueSnapshot {
    return this.storage.transactionSync(() => {
      this.requireRuntime();
      this.storage.sql.exec("UPDATE publication_service SET state = 'paused' WHERE id = 1");
      return this.snapshot();
    });
  }

  resume(windowId: string): PublicationQueueSnapshot {
    sqlitePublicationRequestSchema.shape.admission_window_id.parse(windowId);
    return this.storage.transactionSync(() => {
      const current = this.snapshot();
      if (current.state === "open" && current.admission_window_id === windowId) return current;
      if (current.state !== "paused" || !current.drained || current.admission_window_id === windowId) {
        throw new Error("Resume requires a drained paused queue and a new explicit admission window");
      }
      this.storage.sql.exec("UPDATE publication_service SET state = 'open', admission_window_id = ? WHERE id = 1", windowId);
      return this.snapshot();
    });
  }

  claim(): PublicationClaim {
    return this.storage.transactionSync(() => {
      const service = this.requireRuntime();
      const active = this.active();
      if (active) return { state: active.state === "blocked" ? "blocked" : "interrupted", job: this.statusRow(active) };
      const row = this.storage.sql.exec<JobRow>("SELECT * FROM publication_jobs WHERE state = 'queued' ORDER BY sequence LIMIT 1").toArray()[0];
      if (!row) return { state: "idle" };
      const request = parseSqlitePublicationRequest(JSON.parse(row.request_json));
      if (request.service_id !== this.runtime.service_id || request.worker_version_id !== this.runtime.worker_version_id ||
        request.service_config_sha256 !== this.runtime.service_config_sha256 || request.request_id !== row.request_id || request.job_id !== row.job_id) {
        throw new Error("Stored publication request differs from its runtime or job");
      }
      if (request.admission_window_id !== service.admission_window_id) throw new Error("Stored publication has another admission window");
      this.storage.sql.exec("UPDATE publication_jobs SET state = 'running' WHERE job_id = ? AND state = 'queued'", row.job_id);
      return { state: "claimed", job: this.statusRow(this.byJob(row.job_id)), request };
    });
  }

  async finish(jobId: string, failure?: SqlitePublicationFailure): Promise<SqlitePublicationStatus> {
    if (failure !== undefined) sqlitePublicationFailureSchema.parse(failure);
    return this.storage.transaction(async () => {
      this.requireRuntime();
      const current = this.byJob(jobId);
      if (current.state !== "running") throw new Error("Only the running publication can finish");
      this.storage.sql.exec("UPDATE publication_jobs SET state = ?, reason_code = ? WHERE job_id = ?",
        failure === undefined ? "succeeded" : "failed", failure ?? null, jobId);
      await this.schedule();
      return this.statusRow(this.byJob(jobId));
    });
  }

  async block(jobId: string, reason: SqlitePublicationBlock): Promise<SqlitePublicationStatus> {
    sqlitePublicationBlockSchema.parse(reason);
    const status = this.storage.transactionSync(() => {
      this.requireRuntime();
      const current = this.byJob(jobId);
      if (current.state === "blocked") return this.statusRow(current);
      if (current.state !== "running") throw new Error("Only a running publication can be blocked");
      this.storage.sql.exec("UPDATE publication_jobs SET state = 'blocked', reason_code = ? WHERE job_id = ?", reason, jobId);
      return this.statusRow(this.byJob(jobId));
    });
    await this.storage.sync();
    return status;
  }

  async confirm(): Promise<void> { await this.storage.sync(); }
}
