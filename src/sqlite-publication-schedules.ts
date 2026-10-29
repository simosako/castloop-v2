import { parseSqliteDirectPublicationRequest, sqliteDirectPublicationRequestHash } from "../packages/shared/src/sqlite-direct-publication";
import type { SqliteDirectPublicationRequest } from "../packages/shared/src/sqlite-direct-publication";
import { SQLITE_SCHEDULE_PAGE_SIZE, sqliteScheduleCancelSchema, sqliteScheduleCreateSchema, sqliteScheduleListSchema,
  sqliteScheduleReapproveSchema, sqliteScheduleRecordSchema, sqliteScheduleRescheduleSchema, sqliteScheduleStatusSchema } from "../packages/shared/src/sqlite-schedule";
import type { SqliteScheduleCancel, SqliteScheduleCreate, SqliteScheduleList, SqliteScheduleReason,
  SqliteScheduleRecord, SqliteScheduleReapprove, SqliteScheduleReschedule, SqliteScheduleStatus } from "../packages/shared/src/sqlite-schedule";
import type { SqlitePublicationContent } from "./sqlite-publication-content";
import { SqlitePublicationInputError } from "./sqlite-publication-queue";
import type { PublicationQueueStorage, SqlitePublicationQueue } from "./sqlite-publication-queue";

type ScheduleRow = {
  sequence: number;
  schedule_id: string;
  show_id: string;
  kind: "show" | "episode";
  episode_id: string | null;
  version: number;
  state: SqliteScheduleRecord["state"];
  reason_code: SqliteScheduleReason | null;
  scheduled_at: string;
  scheduled_at_ms: number;
  timezone: string;
  timezone_source: SqliteScheduleRecord["scheduled_at"]["timezone_source"];
  resolution_source: SqliteScheduleRecord["scheduled_at"]["resolution_source"];
  local_input: string;
  local_datetime: string;
  local_offset: string;
  input_offset: string | null;
  preview_sha256: string;
  revision_id: string | null;
  request_sha256: string;
  request_json: string;
  created_at_ms: number;
  updated_at_ms: number;
  dispatched_at_ms: number | null;
  cancelled_at_ms: number | null;
};

class ScheduleDeferred extends Error {
  constructor(readonly reason: SqliteScheduleReason) { super(reason); }
}
class ScheduleSkipped extends Error {}

export type SqliteScheduleSummary = { scheduled: number; needs_approval: number; dispatched: number; next_scheduled_at_ms: number | null };

export class SqlitePublicationSchedules {
  constructor(private readonly storage: PublicationQueueStorage, private readonly queue: SqlitePublicationQueue,
    private readonly content: SqlitePublicationContent, private readonly now: () => number = Date.now,
    private readonly scope?: { showId: string; ready: () => boolean }) {}

  private row(scheduleId: string): ScheduleRow | null {
    return this.storage.sql.exec<ScheduleRow>("SELECT * FROM publication_schedules WHERE schedule_id = ?", scheduleId).toArray()[0] ?? null;
  }

  private requireRow(scheduleId: string): ScheduleRow {
    const row = this.row(scheduleId);
    if (!row) throw new Error("Publication schedule is missing");
    return row;
  }

  private record(row: ScheduleRow): SqliteScheduleRecord {
    return sqliteScheduleRecordSchema.parse({
      protocol: "sqlite-schedule-v1", service_id: this.queue.identity().service_id, show_id: row.show_id,
      schedule_id: row.schedule_id, version: row.version, state: row.state, kind: row.kind, episode_id: row.episode_id,
      scheduled_at: {
        input: row.local_input, scheduled_at: row.scheduled_at, scheduled_at_ms: row.scheduled_at_ms,
        input_offset: row.input_offset, resolution_source: row.resolution_source, timezone: row.timezone,
        timezone_source: row.timezone_source, local_datetime: row.local_datetime, offset: row.local_offset,
      },
      revision_id: row.revision_id, request_sha256: row.request_sha256, preview_sha256: row.preview_sha256,
      reason_code: row.reason_code, created_at_ms: row.created_at_ms, updated_at_ms: row.updated_at_ms,
      dispatched_at_ms: row.dispatched_at_ms, cancelled_at_ms: row.cancelled_at_ms,
    });
  }

  private event(row: ScheduleRow, action: "create" | "reschedule" | "cancel" | "reapprove" | "dispatch" | "suspend" | "fail",
    state: SqliteScheduleRecord["state"], reason: SqliteScheduleReason | null, time = this.now()): void {
    this.storage.sql.exec(`INSERT INTO publication_schedule_events
      (schedule_id, version, action, state, reason_code, request_sha256, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.schedule_id, row.version, action, state, reason, row.request_sha256, time);
  }

  private async wakeAt(time: number): Promise<void> {
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > time) await this.storage.setAlarm(time);
  }

  private requireScope(showId?: string): string {
    if (!this.scope) throw new Error("Publication schedules require a Show scope");
    if (showId !== undefined && showId !== this.scope.showId) throw new Error("Publication schedule target differs");
    return this.scope.showId;
  }

  private checkAdmission(publication: SqliteDirectPublicationRequest, reasonPrefix: "create" | "reapprove"): void {
    if (!this.scope?.ready()) throw new Error(`SQLite schedule ${reasonPrefix} requires a ready Show`);
    if (!this.queue.admits(publication)) throw new Error("SQLite schedule runtime differs");
    if (!this.content.matchesScheduledTarget(publication)) throw new Error("SQLite schedule target or base is unavailable");
  }

  private activeTarget(showId: string, kind: "show" | "episode", episodeId: string | undefined, except?: string): string | null {
    return this.storage.sql.exec<{ schedule_id: string }>(`SELECT schedule_id FROM publication_schedules
      WHERE show_id = ? AND kind = ? AND COALESCE(episode_id, '') = ? AND state IN ('scheduled', 'needs_approval')
        AND schedule_id != ? LIMIT 1`, showId, kind, episodeId ?? "", except ?? "").toArray()[0]?.schedule_id ?? null;
  }

  async create(input: SqliteScheduleCreate): Promise<SqliteScheduleStatus> {
    const request = sqliteScheduleCreateSchema.parse(input), showId = this.requireScope(request.show_id);
    if (request.show_id !== showId) throw new Error("Publication schedule target differs");
    const publication = parseSqliteDirectPublicationRequest(request.publication);
    const hash = await sqliteDirectPublicationRequestHash(publication);
    if (request.scheduled_at.scheduled_at_ms <= this.now()) throw new Error("Publication schedule must be in the future");
    const matches = (row: ScheduleRow) => row.schedule_id === request.schedule_id && row.request_sha256 === hash && row.preview_sha256 === request.preview_sha256 &&
      row.scheduled_at_ms === request.scheduled_at.scheduled_at_ms && row.request_json === JSON.stringify(publication);
    const existing = this.storage.sql.exec<ScheduleRow>("SELECT * FROM publication_schedules WHERE schedule_id = ?", request.schedule_id).toArray();
    if (existing.length) {
      if (existing.length === 1 && matches(existing[0])) {
        await this.wakeAt(existing[0].scheduled_at_ms);
        return this.status(request.schedule_id);
      }
      throw new Error("Publication schedule identity already has another frozen request");
    }
    this.checkAdmission(publication, "create");
    await this.storage.transaction(async () => {
      if (this.row(request.schedule_id)) {
        throw new Error("Publication schedule identity changed concurrently");
      }
      this.checkAdmission(publication, "create");
      if (this.activeTarget(publication.show_id, publication.kind, publication.episode_id)) throw new Error("This target already has an open publication schedule");
      const time = this.now();
      this.storage.sql.exec(`INSERT INTO publication_schedules
        (schedule_id, show_id, kind, episode_id, version, state, reason_code, scheduled_at, scheduled_at_ms, timezone, timezone_source,
          resolution_source, local_input, local_datetime, local_offset, input_offset, preview_sha256,
          request_sha256, request_json, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, 1, 'scheduled', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      request.schedule_id, publication.show_id, publication.kind, publication.episode_id ?? null, request.scheduled_at.scheduled_at,
      request.scheduled_at.scheduled_at_ms, request.scheduled_at.timezone, request.scheduled_at.timezone_source,
      request.scheduled_at.resolution_source, request.scheduled_at.input, request.scheduled_at.local_datetime,
      request.scheduled_at.offset, request.scheduled_at.input_offset, request.preview_sha256,
      hash, JSON.stringify(publication), time, time);
      this.event(this.requireRow(request.schedule_id), "create", "scheduled", null, time);
      await this.wakeAt(request.scheduled_at.scheduled_at_ms);
    });
    return this.status(request.schedule_id);
  }

  async reschedule(input: SqliteScheduleReschedule): Promise<SqliteScheduleStatus> {
    const request = sqliteScheduleRescheduleSchema.parse(input), showId = this.requireScope(request.show_id);
    const row = this.requireRow(request.schedule_id);
    if (row.show_id !== showId) throw new Error("Publication schedule target differs");
    if (request.scheduled_at.scheduled_at_ms <= this.now()) throw new Error("Publication schedule must be in the future");
    await this.storage.transaction(async () => {
      const current = this.requireRow(request.schedule_id);
      if (current.version === request.expected_version + 1 && current.state === "scheduled" &&
        current.preview_sha256 === request.preview_sha256 && current.scheduled_at_ms === request.scheduled_at.scheduled_at_ms) {
        await this.wakeAt(current.scheduled_at_ms); return;
      }
      if (current.version !== request.expected_version || current.state !== "scheduled") throw new Error("Publication schedule changed; inspect it before rescheduling");
      const time = this.now();
      this.storage.sql.exec(`UPDATE publication_schedules SET version = version + 1, scheduled_at = ?, scheduled_at_ms = ?, timezone = ?,
        timezone_source = ?, resolution_source = ?, local_input = ?, local_datetime = ?, local_offset = ?, input_offset = ?,
        preview_sha256 = ?, updated_at_ms = ? WHERE schedule_id = ? AND version = ?`, request.scheduled_at.scheduled_at,
      request.scheduled_at.scheduled_at_ms, request.scheduled_at.timezone, request.scheduled_at.timezone_source,
      request.scheduled_at.resolution_source, request.scheduled_at.input, request.scheduled_at.local_datetime,
      request.scheduled_at.offset, request.scheduled_at.input_offset, request.preview_sha256, time, request.schedule_id,
      request.expected_version);
      this.event(this.requireRow(request.schedule_id), "reschedule", "scheduled", null, time);
      await this.wakeAt(request.scheduled_at.scheduled_at_ms);
    });
    return this.status(request.schedule_id);
  }

  async cancel(input: SqliteScheduleCancel): Promise<SqliteScheduleStatus> {
    const request = sqliteScheduleCancelSchema.parse(input), showId = this.requireScope(request.show_id);
    const row = this.requireRow(request.schedule_id);
    if (row.show_id !== showId) throw new Error("Publication schedule target differs");
    this.storage.transactionSync(() => {
      const current = this.requireRow(request.schedule_id);
      if (current.version === request.expected_version + 1 && current.state === "cancelled" && current.preview_sha256 === request.preview_sha256) return;
      if (current.version !== request.expected_version || !["scheduled", "needs_approval"].includes(current.state)) {
        throw new Error("Publication schedule changed or was already dispatched; inspect it before cancelling");
      }
      const time = this.now();
      this.storage.sql.exec(`UPDATE publication_schedules SET version = version + 1, state = 'cancelled',
        reason_code = 'cancelled_by_administrator', preview_sha256 = ?, cancelled_at_ms = ?, updated_at_ms = ?
        WHERE schedule_id = ? AND version = ?`, request.preview_sha256, time, time, request.schedule_id, request.expected_version);
      this.event(this.requireRow(request.schedule_id), "cancel", "cancelled", "cancelled_by_administrator", time);
    });
    return this.status(request.schedule_id);
  }

  async reapprove(input: SqliteScheduleReapprove): Promise<SqliteScheduleStatus> {
    const request = sqliteScheduleReapproveSchema.parse(input), showId = this.requireScope(request.show_id);
    const row = this.requireRow(request.schedule_id);
    if (row.show_id !== showId) throw new Error("Publication schedule target differs");
    const publication = parseSqliteDirectPublicationRequest(request.publication);
    const hash = await sqliteDirectPublicationRequestHash(publication);
    if (publication.show_id !== row.show_id || publication.kind !== row.kind ||
      (publication.episode_id ?? null) !== row.episode_id) throw new Error("Publication schedule reapproval target differs");
    if (request.scheduled_at.scheduled_at_ms <= this.now()) throw new Error("Publication schedule must be in the future");
    this.checkAdmission(publication, "reapprove");
    await this.storage.transaction(async () => {
      const current = this.requireRow(request.schedule_id);
      if (current.version === request.expected_version + 1 && current.state === "scheduled" && current.request_sha256 === hash &&
        current.preview_sha256 === request.preview_sha256 && current.scheduled_at_ms === request.scheduled_at.scheduled_at_ms) {
        await this.wakeAt(current.scheduled_at_ms); return;
      }
      if (current.version !== request.expected_version || current.state !== "needs_approval") {
        throw new Error("Publication schedule changed or does not require reapproval");
      }
      this.checkAdmission(publication, "reapprove");
      if (this.activeTarget(current.show_id, current.kind, current.episode_id ?? undefined, current.schedule_id)) throw new Error("This target already has pending publication work");
      const time = this.now();
      this.storage.sql.exec(`UPDATE publication_schedules SET version = version + 1, state = 'scheduled', reason_code = NULL,
        scheduled_at = ?, scheduled_at_ms = ?, timezone = ?, timezone_source = ?, resolution_source = ?, local_input = ?,
         local_datetime = ?, local_offset = ?, input_offset = ?, preview_sha256 = ?, request_sha256 = ?,
        request_json = ?, updated_at_ms = ? WHERE schedule_id = ? AND version = ?`, request.scheduled_at.scheduled_at,
      request.scheduled_at.scheduled_at_ms, request.scheduled_at.timezone, request.scheduled_at.timezone_source,
      request.scheduled_at.resolution_source, request.scheduled_at.input, request.scheduled_at.local_datetime,
      request.scheduled_at.offset, request.scheduled_at.input_offset, request.preview_sha256, hash,
      JSON.stringify(publication), time, request.schedule_id, request.expected_version);
      this.event(this.requireRow(request.schedule_id), "reapprove", "scheduled", null, time);
      await this.wakeAt(request.scheduled_at.scheduled_at_ms);
    });
    return this.status(request.schedule_id);
  }

  status(scheduleId: string): SqliteScheduleStatus {
    const showId = this.requireScope();
    const schedule = this.record(this.requireRow(scheduleId));
    return sqliteScheduleStatusSchema.parse({ ...this.queue.identity(), protocol: "sqlite-schedule-v1", show_id: showId, schedule,
      publication: JSON.parse(this.requireRow(scheduleId).request_json) });
  }

  list(cursor?: string): SqliteScheduleList {
    const showId = this.requireScope();
    if (cursor !== undefined) sqliteScheduleCancelSchema.shape.schedule_id.parse(cursor);
    const anchor = cursor ? this.requireRow(cursor) : null;
    if (anchor && anchor.show_id !== showId) throw new Error("Publication schedule cursor belongs to another Show");
    const rows = this.storage.sql.exec<ScheduleRow>(`SELECT * FROM publication_schedules
      WHERE show_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`, showId, anchor?.sequence ?? Number.MAX_SAFE_INTEGER,
    SQLITE_SCHEDULE_PAGE_SIZE + 1).toArray();
    return sqliteScheduleListSchema.parse({ ...this.queue.identity(), protocol: "sqlite-schedule-v1", show_id: showId,
      schedules: rows.slice(0, SQLITE_SCHEDULE_PAGE_SIZE).map((row) => this.record(row)),
      next_cursor: rows.length > SQLITE_SCHEDULE_PAGE_SIZE ? rows[SQLITE_SCHEDULE_PAGE_SIZE - 1]!.schedule_id : null });
  }

  summary(): SqliteScheduleSummary {
    const rows = this.storage.sql.exec<{ state: string; count: number }>(
      "SELECT state, COUNT(*) AS count FROM publication_schedules GROUP BY state").toArray();
    const count = (state: string) => rows.find((row) => row.state === state)?.count ?? 0;
    const next = this.storage.sql.exec<{ scheduled_at_ms: number }>(
      "SELECT scheduled_at_ms FROM publication_schedules WHERE state = 'scheduled' ORDER BY scheduled_at_ms, sequence LIMIT 1").toArray()[0];
    return { scheduled: count("scheduled"), needs_approval: count("needs_approval"), dispatched: count("dispatched"),
      next_scheduled_at_ms: next?.scheduled_at_ms ?? null };
  }

  suspendOpen(reason: "domain_change"): void {
    const rows = this.storage.sql.exec<ScheduleRow>("SELECT * FROM publication_schedules WHERE state = 'scheduled'").toArray();
    const time = this.now();
    for (const row of rows) {
      this.storage.sql.exec(`UPDATE publication_schedules SET version = version + 1, state = 'needs_approval', reason_code = ?,
        updated_at_ms = ? WHERE schedule_id = ? AND state = 'scheduled'`, reason, time, row.schedule_id);
      this.event(this.requireRow(row.schedule_id), "suspend", "needs_approval", reason, time);
    }
  }

  private suspendOne(scheduleId: string, reason: SqliteScheduleReason): void {
    this.storage.transactionSync(() => {
      const row = this.requireRow(scheduleId);
      if (row.state !== "scheduled") return;
      const time = this.now();
      this.storage.sql.exec(`UPDATE publication_schedules SET version = version + 1, state = 'needs_approval', reason_code = ?,
        updated_at_ms = ? WHERE schedule_id = ? AND state = 'scheduled'`, reason, time, scheduleId);
      this.event(this.requireRow(scheduleId), "suspend", "needs_approval", reason, time);
    });
  }

  private failOne(scheduleId: string, reason: SqliteScheduleReason): void {
    this.storage.transactionSync(() => {
      const row = this.requireRow(scheduleId);
      if (row.state !== "scheduled") return;
      const time = this.now();
      this.storage.sql.exec(`UPDATE publication_schedules SET version = version + 1, state = 'failed', reason_code = ?,
        updated_at_ms = ? WHERE schedule_id = ? AND state = 'scheduled'`, reason, time, scheduleId);
      this.event(this.requireRow(scheduleId), "fail", "failed", reason, time);
    });
  }

  async dispatchDue(): Promise<number> {
    const rows = this.storage.sql.exec<ScheduleRow>(`SELECT * FROM publication_schedules
      WHERE state = 'scheduled' AND scheduled_at_ms <= ? ORDER BY scheduled_at_ms, sequence LIMIT 10`, this.now()).toArray();
    let dispatched = 0;
    for (const row of rows) {
      if (!this.scope?.ready()) { this.suspendOne(row.schedule_id, "domain_change"); continue; }
      let request: SqliteDirectPublicationRequest;
      try { request = parseSqliteDirectPublicationRequest(JSON.parse(row.request_json)); }
      catch { this.failOne(row.schedule_id, "target_unavailable"); continue; }
      if (!this.queue.admits(request)) { this.suspendOne(row.schedule_id, "runtime_mismatch"); continue; }
      try {
        if (!this.content.matchesScheduledTarget(request)) { this.suspendOne(row.schedule_id, "base_conflict"); continue; }
      } catch { this.failOne(row.schedule_id, "target_unavailable"); continue; }
      try {
        await this.queue.publish(request, (result) => {
          const current = this.requireRow(row.schedule_id);
          if (current.state !== "scheduled" || current.version !== row.version) throw new ScheduleSkipped();
          if (!this.scope?.ready()) throw new ScheduleDeferred("domain_change");
          if (!this.queue.admits(request)) throw new ScheduleDeferred("runtime_mismatch");
          const time = this.now();
          this.storage.sql.exec(`UPDATE publication_schedules SET version = version + 1, state = 'dispatched', reason_code = NULL, revision_id = ?,
            dispatched_at_ms = ?, updated_at_ms = ? WHERE schedule_id = ? AND state = 'scheduled' AND version = ?`,
          result.revision_id, time, time, row.schedule_id, row.version);
          this.event(this.requireRow(row.schedule_id), "dispatch", "dispatched", null, time);
        });
        dispatched++;
      } catch (error) {
        if (error instanceof ScheduleSkipped) continue;
        if (error instanceof ScheduleDeferred) { this.suspendOne(row.schedule_id, error.reason); continue; }
        if (error instanceof SqlitePublicationInputError) {
          if (error.reason === "base_conflict") { this.suspendOne(row.schedule_id, "base_conflict"); continue; }
          this.failOne(row.schedule_id, "target_unavailable");
          continue;
        }
        throw error;
      }
    }
    return dispatched;
  }

  async scheduleNext(): Promise<void> {
    if (!this.scope?.ready()) return;
    const next = this.storage.sql.exec<{ scheduled_at_ms: number }>(`SELECT scheduled_at_ms FROM publication_schedules
      WHERE state = 'scheduled' ORDER BY scheduled_at_ms, sequence LIMIT 1`).toArray()[0];
    if (!next) return;
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > next.scheduled_at_ms) await this.storage.setAlarm(next.scheduled_at_ms);
  }
}
