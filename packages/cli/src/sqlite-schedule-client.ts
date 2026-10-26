import { sqlitePublicationRequestHash, sqliteScheduleCancelSchema, sqliteScheduleCreateSchema, sqliteScheduleListSchema,
  sqliteScheduleReapproveSchema, sqliteScheduleRescheduleSchema, sqliteScheduleStatusSchema, sqliteServiceConfigHash,
  sqliteServiceConfigSchema } from "@castloop/shared";
import type { SqliteScheduleCancel, SqliteScheduleCreate, SqliteScheduleList, SqliteScheduleReapprove,
  SqliteScheduleReschedule, SqliteScheduleStatus, SqliteServiceConfig } from "@castloop/shared";
import type { OperationClient } from "../../shared/src/sqlite-operations";
import { readSqliteManagementGet, readSqliteManagementJson } from "./sqlite-management-http";
import type { SqliteManagementReadBudget, SqliteManagementReadOptions } from "./sqlite-management-http";
import type { R2RestTransport } from "./verified-r2-put";

export class SqliteScheduleClient {
  readonly config: SqliteServiceConfig;
  constructor(input: SqliteServiceConfig, private readonly administratorKey: string,
    private readonly transport: R2RestTransport = fetch, private readonly timeoutMs = 30000,
    private readonly readOptions: SqliteManagementReadOptions = {}) {
    this.config = sqliteServiceConfigSchema.parse(input);
    if (!administratorKey || administratorKey.length > 1024 || /[^\x21-\x7e]/.test(administratorKey) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Invalid SQLite management credentials or timeout");
  }

  private async identity(value: { service_id: string; service_config_sha256: string }): Promise<void> {
    if (value.service_id !== this.config.service_id || value.service_config_sha256 !== await sqliteServiceConfigHash(this.config)) {
      throw new Error("SQLite schedule response belongs to another service configuration");
    }
  }

  private async get(path: string, showId: string, budget: SqliteManagementReadBudget = {}): Promise<unknown> {
    return readSqliteManagementGet(new URL(`/admin/sqlite-schedules${path}`, this.config.workers_dev_base_url), {
      "X-Castloop-Key": this.administratorKey, "X-Castloop-Show-Id": showId, Accept: "application/json",
    }, { ...this.readOptions, ...budget, transport: this.transport, timeoutMs: this.timeoutMs, maximumBytes: 32768 });
  }

  private async post(path: string, input: SqliteScheduleCreate | SqliteScheduleReschedule | SqliteScheduleCancel | SqliteScheduleReapprove,
    trace?: OperationClient): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(new URL(`/admin/sqlite-schedules${path}`, this.config.workers_dev_base_url), {
        method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "X-Castloop-Key": this.administratorKey, "X-Castloop-Show-Id": input.show_id, Accept: "application/json",
          "Content-Type": "application/json", ...(trace ? { "X-Castloop-Client-Id": trace.client_id, "X-Castloop-Cli-Version": trace.cli_version } : {}) },
        body: JSON.stringify(input),
      });
    } catch { throw new Error("SQLite schedule response is unknown; preserve the request without automatic retry"); }
    if (response.status !== 202) {
      await response.body?.cancel();
      throw new Error(`SQLite schedule request was not verified (HTTP ${response.status}); no automatic retry`);
    }
    try { return await readSqliteManagementJson(response, 32768); }
    catch { throw new Error("SQLite schedule response body was not verified; preserve the request without automatic retry"); }
  }

  private async checked(value: unknown, scheduleId: string): Promise<SqliteScheduleStatus> {
    const parsed = sqliteScheduleStatusSchema.safeParse(value);
    if (!parsed.success) throw new Error("SQLite schedule response schema was not verified");
    await this.identity(parsed.data);
    if (parsed.data.schedule.schedule_id !== scheduleId || parsed.data.show_id !== parsed.data.schedule.show_id) {
      throw new Error("SQLite schedule response target differs");
    }
    return parsed.data;
  }

  async create(input: SqliteScheduleCreate, trace?: OperationClient): Promise<SqliteScheduleStatus> {
    const request = sqliteScheduleCreateSchema.parse(input);
    const result = await this.checked(await this.post("", request, trace), request.schedule_id);
    if (result.schedule.request_sha256 !== await sqlitePublicationRequestHash(request.publication) || result.schedule.preview_sha256 !== request.preview_sha256 ||
      JSON.stringify(result.schedule.scheduled_at) !== JSON.stringify(request.scheduled_at)) {
      throw new Error("SQLite schedule result differs from its frozen request");
    }
    return result;
  }

  async list(showId: string, cursor?: string): Promise<SqliteScheduleList> {
    const query = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
    const parsed = sqliteScheduleListSchema.safeParse(await this.get(query, showId));
    if (!parsed.success) throw new Error("SQLite schedule list was not verified");
    await this.identity(parsed.data);
    if (parsed.data.show_id !== showId) throw new Error("SQLite schedule list target differs");
    return parsed.data;
  }

  async status(showId: string, scheduleId: string, budget: SqliteManagementReadBudget = {}): Promise<SqliteScheduleStatus> {
    sqliteScheduleCancelSchema.shape.schedule_id.parse(scheduleId);
    const result = await this.checked(await this.get(`/${scheduleId}`, showId, budget), scheduleId);
    if (result.show_id !== showId) throw new Error("SQLite schedule status target differs");
    return result;
  }

  async reschedule(input: SqliteScheduleReschedule): Promise<SqliteScheduleStatus> {
    const request = sqliteScheduleRescheduleSchema.parse(input);
    const result = await this.checked(await this.post(`/${request.schedule_id}/reschedule`, request), request.schedule_id);
    if (result.schedule.state !== "scheduled" || JSON.stringify(result.schedule.scheduled_at) !== JSON.stringify(request.scheduled_at)) {
      throw new Error("SQLite schedule reschedule result differs from its frozen request");
    }
    return result;
  }

  async cancel(input: SqliteScheduleCancel): Promise<SqliteScheduleStatus> {
    const request = sqliteScheduleCancelSchema.parse(input);
    const result = await this.checked(await this.post(`/${request.schedule_id}/cancel`, request), request.schedule_id);
    if (result.schedule.state !== "cancelled") throw new Error("SQLite schedule cancellation result differs");
    return result;
  }

  async reapprove(input: SqliteScheduleReapprove): Promise<SqliteScheduleStatus> {
    const request = sqliteScheduleReapproveSchema.parse(input);
    const result = await this.checked(await this.post(`/${request.schedule_id}/reapprove`, request), request.schedule_id);
    if (result.schedule.request_sha256 !== await sqlitePublicationRequestHash(request.publication) ||
      JSON.stringify(result.schedule.scheduled_at) !== JSON.stringify(request.scheduled_at)) {
      throw new Error("SQLite schedule reapproval result differs from its frozen request");
    }
    return result;
  }
}
