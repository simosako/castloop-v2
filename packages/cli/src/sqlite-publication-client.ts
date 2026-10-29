import { sqliteServiceConfigHash, sqliteServiceConfigSchema, sqliteServiceStatusSchema } from "@castloop/shared";
import type { SqliteServiceConfig, SqliteServiceStatus } from "@castloop/shared";
import { parseSqliteDirectPublicationRequest, sqliteDirectPublicationResultSchema } from "../../shared/src/sqlite-direct-publication";
import type { SqliteDirectPublicationRequest, SqliteDirectPublicationResult } from "../../shared/src/sqlite-direct-publication";
import type { R2RestTransport } from "./verified-r2-put";
import { readSqliteManagementGet, readSqliteManagementJson } from "./sqlite-management-http";
import type { SqliteManagementReadOptions } from "./sqlite-management-http";

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
  async describe(showId?: string): Promise<SqliteServiceStatus> {
    const status = sqliteServiceStatusSchema.parse(await readSqliteManagementGet(new URL("/admin/sqlite-publication/status", this.config.workers_dev_base_url), {
      "X-Castloop-Key": this.administratorKey, ...(showId ? { "X-Castloop-Show-Id": showId } : {}),
    }, { ...this.readOptions, transport: this.transport, timeoutMs: this.timeoutMs }));
    if (status.show_id !== showId || status.service_id !== this.config.service_id || status.service_config_sha256 !== await sqliteServiceConfigHash(this.config)) throw new Error("Publication status target differs");
    return status;
  }
  async submit(input: SqliteDirectPublicationRequest): Promise<SqliteDirectPublicationResult> {
    const request = parseSqliteDirectPublicationRequest(input);
    if (request.service_id !== this.config.service_id || request.service_config_sha256 !== await sqliteServiceConfigHash(this.config)) throw new Error("Publication belongs to another service configuration");
    let response: Response;
    try { response = await this.transport(new URL("/admin/sqlite-publication/publish", this.config.workers_dev_base_url), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
      headers: { "X-Castloop-Key": this.administratorKey, "X-Castloop-Show-Id": request.show_id, "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }); } catch { throw new Error("Publication outcome is unknown; review the current content before retrying"); }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Publication failed or its outcome is unknown (HTTP ${response.status}); review the current content before retrying`);
    }
    const result = sqliteDirectPublicationResultSchema.parse(await readSqliteManagementJson(response));
    if (result.service_id !== request.service_id || result.service_config_sha256 !== request.service_config_sha256 ||
      result.show_id !== request.show_id || result.episode_id !== request.episode_id) throw new Error("Publication response target differs");
    return result;
  }
}
