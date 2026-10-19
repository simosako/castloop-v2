import { MAX_SQLITE_PUBLICATION_BYTES, parseSqlitePublicationRequest, sqlitePublicationRequestHash,
  sqlitePublicationStatusSchema, sqliteServiceConfigHash, sqliteServiceConfigSchema, sqliteServiceStatusSchema } from "@castloop/shared";
import type { SqlitePublicationRequest, SqlitePublicationStatus, SqliteServiceConfig, SqliteServiceStatus } from "@castloop/shared";
import type { R2RestTransport } from "./verified-r2-put";
import { readSqliteManagementGet, readSqliteManagementJson } from "./sqlite-management-http";
import type { SqliteManagementReadBudget, SqliteManagementReadOptions } from "./sqlite-management-http";
import type { OperationClient } from "../../shared/src/sqlite-operations";

export { readSqliteManagementJson } from "./sqlite-management-http";

export class SqlitePublicationClient {
  readonly config: SqliteServiceConfig;
  constructor(input: SqliteServiceConfig, private readonly administratorKey: string,
    private readonly transport: R2RestTransport = fetch, private readonly timeoutMs = 30000,
    private readonly readOptions: SqliteManagementReadOptions = {}) {
    this.config = sqliteServiceConfigSchema.parse(input);
    if (!administratorKey || administratorKey.length > 1024 || /[^\x21-\x7e]/.test(administratorKey) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("Invalid SQLite management credentials or timeout");
  }

  private async call(path: string, input?: SqlitePublicationRequest, budget: SqliteManagementReadBudget = {}, trace?: OperationClient): Promise<unknown | null> {
    if (!input) {
      return readSqliteManagementGet(new URL(`/admin/sqlite-publication/${path}`, this.config.workers_dev_base_url), {
        "X-Castloop-Key": this.administratorKey, Accept: "application/json",
        ...(path.startsWith("jobs/") ? { "X-Castloop-Status-Request": path.slice(5) } : {}),
      }, { ...this.readOptions, ...budget, transport: this.transport, timeoutMs: this.timeoutMs, maximumBytes: MAX_SQLITE_PUBLICATION_BYTES, allowMissing: path.startsWith("jobs/") });
    }
    let response: Response;
    try {
      response = await this.transport(new URL(`/admin/sqlite-publication/${path}`, this.config.workers_dev_base_url), {
        method: input ? "POST" : "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "X-Castloop-Key": this.administratorKey, "Accept": "application/json",
          ...(input ? { "Content-Type": "application/json" } : {}),
          ...(trace ? { "X-Castloop-Client-Id": trace.client_id, "X-Castloop-Cli-Version": trace.cli_version } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}),
      });
    } catch { throw new Error("SQLite management response is unknown; preserve the request without automatic retry"); }
    if (response.status !== (input ? 202 : 200)) {
      await response.body?.cancel();
      throw new Error(`SQLite management request was not verified (HTTP ${response.status}); no automatic retry`);
    }
    try { return await readSqliteManagementJson(response); }
    catch { throw new Error("SQLite management response body was not verified; preserve the request without automatic retry"); }
  }

  async describe(): Promise<SqliteServiceStatus> {
    const parsed = sqliteServiceStatusSchema.safeParse(await this.call("status"));
    if (!parsed.success) throw new Error("SQLite management capability was not verified");
    const status = parsed.data;
    if (status.service_id !== this.config.service_id || status.service_config_sha256 !== await sqliteServiceConfigHash(this.config)) {
      throw new Error("SQLite management runtime belongs to another service configuration");
    }
    return status;
  }

  private async requireRequest(input: SqlitePublicationRequest): Promise<SqlitePublicationRequest> {
    const request = parseSqlitePublicationRequest(input);
    if (request.service_id !== this.config.service_id || request.service_config_sha256 !== await sqliteServiceConfigHash(this.config)) {
      throw new Error("SQLite publication request belongs to another service configuration");
    }
    return request;
  }

  private async result(value: unknown, request: SqlitePublicationRequest): Promise<SqlitePublicationStatus> {
    const parsed = sqlitePublicationStatusSchema.safeParse(value);
    if (!parsed.success) throw new Error("SQLite publication result schema was not verified");
    const status = parsed.data;
    if (status.service_id !== request.service_id || status.request_id !== request.request_id || status.job_id !== request.job_id ||
      status.request_sha256 !== await sqlitePublicationRequestHash(request)) throw new Error("SQLite publication result differs from its frozen request");
    return status;
  }

  async submit(input: SqlitePublicationRequest, trace?: OperationClient): Promise<SqlitePublicationStatus> {
    const request = await this.requireRequest(input);
    return this.result(await this.call("jobs", request, {}, trace), request);
  }

  async observe(input: SqlitePublicationRequest, budget: SqliteManagementReadBudget = {}): Promise<SqlitePublicationStatus | null> {
    const request = await this.requireRequest(input);
    const value = await this.call(`jobs/${request.request_id}`, undefined, budget);
    return value === null ? null : this.result(value, request);
  }
}
