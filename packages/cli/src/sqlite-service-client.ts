import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteHealthSchema, sqliteInspectionSchema } from "../../shared/src/sqlite-service-api";
import type { SqliteHealth, SqliteInspection, SqliteRuntimeRequest } from "../../shared/src/sqlite-service-api";
import { readSqliteManagementJson } from "./sqlite-publication-client";
import type { R2RestTransport } from "./verified-r2-put";
import { sqliteCatalogRequestSchema, sqliteCatalogResponseSchema } from "../../shared/src/sqlite-catalog";
import type { SqliteCatalogRequest, SqliteCatalogResponse } from "../../shared/src/sqlite-catalog";
import { sqliteUpdateActivateSchema, sqliteUpdatePrepareSchema, sqliteUpdateResultSchema } from "../../shared/src/sqlite-runtime-update";
import type { SqliteUpdateActivate, SqliteUpdatePrepare, SqliteUpdateResult } from "../../shared/src/sqlite-runtime-update";

export class SqliteServiceClient {
  readonly config: SqliteServiceConfig;
  constructor(config: SqliteServiceConfig, private readonly key: string, private readonly transport: R2RestTransport = fetch) {
    this.config = sqliteServiceConfigSchema.parse(config);
    if (!key || /[^\x21-\x7e]/.test(key) || key.length > 1024) throw new Error("Missing SQLite administrator key");
  }
  private async call(path: string, body?: object): Promise<unknown> {
    try {
      const response = await this.transport(new URL(`/admin/sqlite-service/${path}`, this.config.workers_dev_base_url), {
        method: body ? "POST" : "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000),
        headers: { "X-Castloop-Key": this.key, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status !== (path === "prepare" ? 202 : 200)) {
        await response.body?.cancel(); throw new Error("Unverified service response");
      }
      return await readSqliteManagementJson(response, path === "catalog" ? 65536 : 16384);
    } catch { throw new Error("SQLite service request was not verified; preserve its journal without automatic replay"); }
  }
  private async identity(value: { service_id: string; service_config_sha256: string }): Promise<void> {
    if (value.service_id !== this.config.service_id || value.service_config_sha256 !== await sqliteServiceConfigHash(this.config)) throw new Error("SQLite service response belongs to another configuration");
  }
  async health(): Promise<SqliteHealth> {
    const value = sqliteHealthSchema.parse(await this.call("health")); await this.identity(value); return value;
  }
  async update(action: "prepare" | "activate" | "status", input: SqliteUpdatePrepare | SqliteUpdateActivate): Promise<SqliteUpdateResult> {
    const request = action === "activate" ? sqliteUpdateActivateSchema.parse(input) : sqliteUpdatePrepareSchema.parse(input);
    let prepared: SqliteUpdatePrepare;
    if (action === "activate") {
      const { new_worker_version_id, deployment_id, script_etag, ...base } = sqliteUpdateActivateSchema.parse(input); prepared = base;
    } else prepared = sqliteUpdatePrepareSchema.parse(input);
    const value = sqliteUpdateResultSchema.parse(await this.call(action === "status" ? `update-status/${request.operation_id}` : `update-${action}`, action === "status" ? undefined : request)); await this.identity(value);
    if (JSON.stringify(value.request) !== JSON.stringify(prepared) || value.update.operation_id !== request.operation_id ||
      value.update.previous_worker_version_id !== request.worker_version_id || action === "activate" &&
      (value.worker_version_id !== sqliteUpdateActivateSchema.parse(input).new_worker_version_id || value.update.new_worker_version_id !== value.worker_version_id)) throw new Error("SQLite update result differs from its frozen request");
    return value;
  }
  async catalog(input: SqliteCatalogRequest): Promise<SqliteCatalogResponse> {
    const request = sqliteCatalogRequestSchema.parse(input), value = sqliteCatalogResponseSchema.parse(await this.call("catalog", request));
    await this.identity(value);
    if (JSON.stringify(value.request) !== JSON.stringify(request)) throw new Error("SQLite catalog response differs from its exact request");
    return value;
  }
  async prepare(request: SqliteRuntimeRequest): Promise<SqliteHealth> {
    const value = sqliteHealthSchema.parse(await this.call("prepare", request)); await this.identity(value);
    if (value.worker_version_id !== request.worker_version_id || value.setup?.operation_id !== request.operation_id) throw new Error("Runtime setup response differs");
    return value;
  }
  async inspect(showId: string, episodeId?: string): Promise<SqliteInspection> {
    sqliteInspectionSchema.shape.show_id.parse(showId);
    if (episodeId !== undefined) sqliteInspectionSchema.shape.episode_id.unwrap().parse(episodeId);
    const value = sqliteInspectionSchema.parse(await this.call(`targets/${showId}${episodeId === undefined ? "" : `/${episodeId}`}`));
    await this.identity(value);
    if (value.show_id !== showId || value.episode_id !== episodeId) throw new Error("SQLite target response differs"); return value;
  }
  async control(action: "pause" | "resume", request: SqliteRuntimeRequest, window?: string): Promise<SqliteHealth> {
    const value = sqliteHealthSchema.parse(await this.call(action, { ...request, ...(window ? { admission_window_id: window } : {}) }));
    await this.identity(value);
    if (value.worker_version_id !== request.worker_version_id || value.state !== (action === "pause" ? "paused" : "open") ||
      action === "resume" && value.admission_window_id !== window) throw new Error("SQLite service control result differs");
    return value;
  }
  async register(request: SqliteRuntimeRequest, window: string, showId: string, reservationId: string): Promise<SqliteInspection> {
    const value = sqliteInspectionSchema.parse(await this.call("register-show", { ...request, admission_window_id: window,
      show_id: showId, reservation_id: reservationId })); await this.identity(value);
    if (value.worker_version_id !== request.worker_version_id || value.show_id !== showId || value.episode_id !== undefined || value.reservation_id !== reservationId) throw new Error("SQLite registration result differs");
    return value;
  }
}
