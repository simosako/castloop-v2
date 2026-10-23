import { parseSqlitePublicationRequest, sqlitePublicationBlockSchema, sqlitePublicationFailureSchema,
  sqlitePublicationProtocol, sqlitePublicationRequestHash, sqlitePublicationRequestSchema, sqlitePublicationRuntimeSchema,
  sqlitePublicationStatusSchema } from "../packages/shared/src/sqlite-publication";
import type { SqlitePublicationBlock, SqlitePublicationFailure, SqlitePublicationRequest,
  SqlitePublicationRuntime, SqlitePublicationStatus } from "../packages/shared/src/sqlite-publication";
import type { OperationClient } from "../packages/shared/src/sqlite-operations";
import type { SqliteOperationRecords } from "./sqlite-operation-records";
import { sqliteDeliveryPolicy } from "./sqlite-feed";
import { initializeSqliteFeedGenerations, reserveSqliteFeedGeneration, SQLITE_QUEUE_SCHEMA_VERSION } from "./sqlite-feed-generations";

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
type ServiceRow = SqlitePublicationRuntime & { state: "open" | "paused"; admission_window_id: string | null };
type JobRow = { sequence: number; request_id: string; job_id: string; show_id: string; request_sha256: string; request_json: string;
  state: SqlitePublicationStatus["state"]; reason_code: string | null; delivery_policy: string };
export type PublicationQueueSnapshot = { state: "open" | "paused"; admission_window_id: string | null;
  queued: number; active: SqlitePublicationStatus | null; drained: boolean };
export type PublicationClaim = { state: "idle" } | { state: "blocked"; job: SqlitePublicationStatus } |
  { state: "interrupted"; job: SqlitePublicationStatus } |
  { state: "claimed"; job: SqlitePublicationStatus; request: SqlitePublicationRequest };

export class PublicationQueueConflict extends Error {
  constructor() { super("SQLite publication identity already has another frozen request"); }
}

export class SqlitePublicationQueue {
  operationRecords?: SqliteOperationRecords;
  constructor(private readonly storage: PublicationQueueStorage, private runtime: SqlitePublicationRuntime,
    private readonly now: () => number = Date.now, private readonly scope?: { showId: string; ready: () => boolean }) {
    this.runtime = sqlitePublicationRuntimeSchema.parse(runtime);
    storage.transactionSync(() => {
      storage.sql.exec("CREATE TABLE IF NOT EXISTS publication_queue_schema (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)");
      const schema = storage.sql.exec<{ version: number }>("SELECT version FROM publication_queue_schema WHERE id = 1").toArray()[0];
      if (schema && schema.version !== SQLITE_QUEUE_SCHEMA_VERSION) throw new Error("Unsupported SQLite publication schema; do not reset stored state");
      storage.sql.exec("INSERT OR IGNORE INTO publication_queue_schema (id, version) VALUES (1, ?)", SQLITE_QUEUE_SCHEMA_VERSION);
      initializeSqliteFeedGenerations(storage);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_service (
        id INTEGER PRIMARY KEY CHECK(id = 1), service_id TEXT NOT NULL, worker_version_id TEXT NOT NULL,
        service_config_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open', 'paused')), admission_window_id TEXT)`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_jobs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL UNIQUE,
        show_id TEXT NOT NULL, request_sha256 TEXT NOT NULL, request_json TEXT NOT NULL, feed_generation INTEGER NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed', 'blocked')), reason_code TEXT,
        delivery_policy TEXT NOT NULL CHECK(delivery_policy IN ('exclusive', 'preserve_committed')),
        read_feed_generation INTEGER, read_show_version INTEGER, read_episode_id TEXT, read_request_sha256 TEXT,
        read_verified INTEGER NOT NULL DEFAULT 0 CHECK(read_verified IN (0, 1)),
        read_episode_state TEXT CHECK(read_episode_state IN ('absent', 'published')),
        read_episode_revision_id TEXT, read_episode_lifecycle_version INTEGER,
        read_target_kind TEXT CHECK(read_target_kind IN ('show', 'episode')), read_cover_generation INTEGER,
        CHECK ((read_target_kind IS NULL AND read_feed_generation IS NULL AND read_show_version IS NULL
            AND read_cover_generation IS NULL AND read_request_sha256 IS NULL AND read_episode_id IS NULL
            AND read_episode_state IS NULL AND read_episode_revision_id IS NULL AND read_episode_lifecycle_version IS NULL AND read_verified = 0)
          OR (read_target_kind IS NOT NULL AND read_feed_generation IS NOT NULL AND read_show_version IS NOT NULL
            AND read_cover_generation IS NOT NULL AND read_request_sha256 IS NOT NULL AND
            ((read_target_kind IS 'show' AND read_episode_id IS NULL AND read_episode_state IS NULL
                AND read_episode_revision_id IS NULL AND read_episode_lifecycle_version IS NULL)
              OR (read_target_kind IS 'episode' AND read_episode_id IS NOT NULL AND
                ((read_episode_state IS 'absent' AND read_episode_revision_id IS NULL AND read_episode_lifecycle_version IS NULL)
                  OR (read_episode_state IS 'published' AND read_episode_revision_id IS NOT NULL AND read_episode_lifecycle_version IS NOT NULL)))))))`);
      storage.sql.exec("CREATE INDEX IF NOT EXISTS publication_jobs_pending ON publication_jobs (state, sequence)");
      storage.sql.exec("CREATE INDEX IF NOT EXISTS publication_jobs_show_state ON publication_jobs (show_id, state)");
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

  async enqueue(input: SqlitePublicationRequest, client?: OperationClient, invocation = crypto.randomUUID()): Promise<SqlitePublicationStatus> {
    const request = parseSqlitePublicationRequest(input);
    const source = JSON.stringify(request);
    const hash = await sqlitePublicationRequestHash(request);
    return this.storage.transaction(async () => {
      const service = this.requireRuntime();
      if (this.scope && (request.show_id !== this.scope.showId || !this.scope.ready())) throw new Error("Show publication scope is unavailable");
      if (request.service_id !== service.service_id) throw new Error("Publication belongs to another service");
      const existing = this.storage.sql.exec<JobRow>("SELECT * FROM publication_jobs WHERE request_id = ? OR job_id = ?",
        request.request_id, request.job_id).toArray();
      if (existing.length) {
        if (existing.length !== 1 || existing[0].request_id !== request.request_id || existing[0].job_id !== request.job_id ||
          existing[0].request_sha256 !== hash || existing[0].request_json !== source) throw new PublicationQueueConflict();
        if (client) this.operationRecords?.requirePublicationClient(request, hash, client);
        await this.schedule();
        return this.statusRow(existing[0]);
      }
      if (service.state !== "open") throw new Error("SQLite publication admission is paused");
      if (request.worker_version_id !== service.worker_version_id || request.service_config_sha256 !== service.service_config_sha256 ||
        request.admission_window_id !== service.admission_window_id) throw new Error("Publication runtime or resume window is stale");
      if (this.active()?.state === "blocked") throw new Error("SQLite publication queue is blocked; inspect the retained job");
      this.operationRecords?.validatePublicationAssets(request);
      if (client) this.operationRecords?.publicationAccepted(request, hash, client, invocation);
      const feedGeneration = reserveSqliteFeedGeneration(this.storage, { kind: "publication", id: request.job_id,
        showId: request.show_id, requestSha256: hash });
      this.storage.sql.exec(`INSERT INTO publication_jobs (request_id, job_id, show_id, request_sha256, request_json, feed_generation, state, delivery_policy)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`, request.request_id, request.job_id, request.show_id, hash, source, feedGeneration, sqliteDeliveryPolicy(request));
      await this.schedule();
      return this.statusRow(this.byJob(request.job_id));
    });
  }

  status(requestId: string): SqlitePublicationStatus | null {
    this.requireRuntime();
    const row = this.storage.sql.exec<JobRow>("SELECT * FROM publication_jobs WHERE request_id = ?", requestId).toArray()[0];
    return row ? this.statusRow(row) : null;
  }

  identity(): SqlitePublicationRuntime {
    this.requireRuntime();
    return { ...this.runtime };
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

  claim(invocation = crypto.randomUUID()): PublicationClaim {
    return this.storage.transactionSync(() => {
      const service = this.requireRuntime();
      const active = this.active();
      if (active) return { state: active.state === "blocked" ? "blocked" : "interrupted", job: this.statusRow(active) };
      const row = this.storage.sql.exec<JobRow>("SELECT * FROM publication_jobs WHERE state = 'queued' ORDER BY sequence LIMIT 1").toArray()[0];
      if (!row) return { state: "idle" };
      let request: SqlitePublicationRequest;
      try {
        request = parseSqlitePublicationRequest(JSON.parse(row.request_json));
        if (request.service_id !== this.runtime.service_id || request.worker_version_id !== this.runtime.worker_version_id ||
          request.service_config_sha256 !== this.runtime.service_config_sha256 || request.request_id !== row.request_id || request.job_id !== row.job_id || request.show_id !== row.show_id ||
          request.admission_window_id !== service.admission_window_id || JSON.stringify(request) !== row.request_json ||
          row.delivery_policy !== sqliteDeliveryPolicy(request)) throw new Error("Stored request differs");
      } catch {
        this.storage.sql.exec("UPDATE publication_jobs SET state = 'blocked', reason_code = 'stored_request_invalid' WHERE job_id = ?", row.job_id);
        this.operationRecords?.publicationChanged(row.job_id, "blocked", "stored_request_invalid", invocation);
        return { state: "blocked", job: this.statusRow(this.byJob(row.job_id)) };
      }
      if (row.delivery_policy === "preserve_committed" && this.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE name = 'publication_shows'").toArray().length) {
        this.storage.sql.exec(`UPDATE publication_jobs SET
          read_feed_generation = (SELECT feed_generation FROM publication_shows WHERE show_id = ?),
          read_cover_generation = (SELECT cover_generation FROM publication_show_content WHERE show_id = ?),
          read_show_version = ?, read_target_kind = ?, read_episode_id = ?, read_request_sha256 = ?,
          read_episode_state = ?, read_episode_revision_id = ?, read_episode_lifecycle_version = ?
          WHERE job_id = ? AND EXISTS (SELECT 1 FROM publication_shows s JOIN publication_show_content c USING (show_id)
            WHERE s.show_id = ? AND s.lifecycle = 'published' AND s.state_version = ? AND s.feed_generation > 0 AND c.cover_generation > 0)
          AND (? = 'show' OR ((? IS NULL AND ? = 0 AND NOT EXISTS
            (SELECT 1 FROM publication_episodes WHERE show_id = ? AND episode_id = ?))
            OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM publication_episodes WHERE show_id = ? AND episode_id = ?
              AND lifecycle = 'published' AND revision_id = ? AND lifecycle_version = ?))))`,
        request.show_id, request.show_id, request.expected_show_state_version, request.kind, request.episode_id ?? null,
        row.request_sha256, request.kind === "show" ? null : request.base_revision_id ? "published" : "absent",
        request.base_revision_id ?? null, request.kind === "episode" && request.base_revision_id ? request.expected_episode_lifecycle_version ?? 0 : null,
        row.job_id, request.show_id, request.expected_show_state_version, request.kind,
        request.base_revision_id ?? null, request.expected_episode_lifecycle_version ?? 0, request.show_id, request.episode_id ?? null,
        request.base_revision_id ?? null, request.show_id, request.episode_id ?? null, request.base_revision_id ?? null,
        request.expected_episode_lifecycle_version ?? 0);
      }
      this.storage.sql.exec("UPDATE publication_jobs SET state = 'running' WHERE job_id = ? AND state = 'queued'", row.job_id);
      this.operationRecords?.publicationChanged(row.job_id, "running", undefined, invocation);
      return { state: "claimed", job: this.statusRow(this.byJob(row.job_id)), request };
    });
  }

  async finish(jobId: string, failure?: SqlitePublicationFailure, apply?: () => undefined, invocation = crypto.randomUUID()): Promise<SqlitePublicationStatus> {
    if (failure !== undefined) sqlitePublicationFailureSchema.parse(failure);
    if (failure !== undefined && apply) throw new Error("Failed input cannot commit publication content");
    return this.storage.transaction(async () => {
      this.requireRuntime();
      const current = this.byJob(jobId);
      if (current.state !== "running") throw new Error("Only the running publication can finish");
      if (apply && apply() !== undefined) throw new Error("Publication content commit must be synchronous");
      this.storage.sql.exec("UPDATE publication_jobs SET state = ?, reason_code = ? WHERE job_id = ?",
        failure === undefined ? "succeeded" : "failed", failure ?? null, jobId);
      this.operationRecords?.publicationChanged(jobId, failure === undefined ? "succeeded" : "failed", failure, invocation);
      await this.schedule();
      return this.statusRow(this.byJob(jobId));
    });
  }

  async block(jobId: string, reason: SqlitePublicationBlock, invocation = crypto.randomUUID()): Promise<SqlitePublicationStatus> {
    sqlitePublicationBlockSchema.parse(reason);
    const status = this.storage.transactionSync(() => {
      this.requireRuntime();
      const current = this.byJob(jobId);
      if (current.state === "blocked") return this.statusRow(current);
      if (current.state !== "running") throw new Error("Only a running publication can be blocked");
      this.storage.sql.exec("UPDATE publication_jobs SET state = 'blocked', reason_code = ? WHERE job_id = ?", reason, jobId);
      this.operationRecords?.publicationChanged(jobId, "blocked", reason, invocation);
      return this.statusRow(this.byJob(jobId));
    });
    await this.storage.sync();
    return status;
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
}
