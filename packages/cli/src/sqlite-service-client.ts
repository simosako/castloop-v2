import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../../shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../../shared/src/sqlite-service";
import { sqliteHealthSchema, sqliteInspectionSchema, sqliteRegistryStatusSchema, sqliteAvailabilityResponseSchema } from "../../shared/src/sqlite-service-api";
import type { SqliteAvailabilityResponse } from "../../shared/src/sqlite-service-api";
import { sqliteAvailabilityRequestSchema } from "../../shared/src/sqlite-availability";
import type { SqliteAvailabilityRequest } from "../../shared/src/sqlite-availability";
import { sha256Hex } from "../../shared/src/sha256";
import type { SqliteHealth, SqliteInspection, SqliteRuntimeRequest } from "../../shared/src/sqlite-service-api";
import { readSqliteManagementGet, readSqliteManagementJson } from "./sqlite-management-http";
import type { SqliteManagementReadOptions } from "./sqlite-management-http";
import type { R2RestTransport } from "./verified-r2-put";
import { sqliteCatalogRequestSchema, sqliteCatalogResponseSchema } from "../../shared/src/sqlite-catalog";
import type { SqliteCatalogRequest, SqliteCatalogResponse } from "../../shared/src/sqlite-catalog";
import { sqliteUpdateActivateSchema, sqliteUpdatePrepareSchema, sqliteUpdateResultSchema } from "../../shared/src/sqlite-runtime-update";
import type { SqliteUpdateActivate, SqliteUpdatePrepare, SqliteUpdateResult } from "../../shared/src/sqlite-runtime-update";
import { sqliteContentSnapshotSchema, sqliteRevisionDetailResponseSchema, sqliteRevisionListResponseSchema, sqlitePreviewInventorySchema } from "../../shared/src/sqlite-revisions";
import type { SqliteShowRevisionRecord, SqliteEpisodeRevisionRecord } from "../../shared/src/sqlite-revisions";

export class SqliteServiceClient {
  readonly config: SqliteServiceConfig;
  constructor(config: SqliteServiceConfig, private readonly key: string, private readonly transport: R2RestTransport = fetch,
    private readonly readOptions: SqliteManagementReadOptions = {}) {
    this.config = sqliteServiceConfigSchema.parse(config);
    if (!key || /[^\x21-\x7e]/.test(key) || key.length > 1024) throw new Error("Missing SQLite administrator key");
  }
  private async call(path: string, body?: object, showId?: string): Promise<unknown> {
    const scope: Record<string, string> = showId ? { "X-Castloop-Show-Id": sqliteInspectionSchema.shape.show_id.parse(showId) } : {};
    try {
      if (!body) return await readSqliteManagementGet(new URL(`/admin/sqlite-service/${path}`, this.config.workers_dev_base_url),
        { "X-Castloop-Key": this.key, ...scope }, { ...this.readOptions, transport: this.transport });
      const response = await this.transport(new URL(`/admin/sqlite-service/${path}`, this.config.workers_dev_base_url), {
        method: body ? "POST" : "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30000),
        headers: { "X-Castloop-Key": this.key, ...scope, ...(body ? { "Content-Type": "application/json" } : {}) },
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
  async health(showId?: string): Promise<SqliteHealth> {
    const value = sqliteHealthSchema.parse(await this.call("health", undefined, showId)); await this.identity(value);
    if (showId && value.show_id !== showId) throw new Error("Show health response target differs");
    return value;
  }
  async registration(showId: string) {
    sqliteInspectionSchema.shape.show_id.parse(showId);
    const result = sqliteRegistryStatusSchema.parse(await this.call(`registrations/${showId}`));
    if (result.show_id !== showId) throw new Error("Registry response target differs");
    return result;
  }
  async registrationHealth(): Promise<SqliteHealth> {
    const value = sqliteHealthSchema.parse(await this.call("registration-health")); await this.identity(value);
    if (value.scope !== "service") throw new Error("Registration runtime scope differs");
    return value;
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
    const request = sqliteCatalogRequestSchema.parse(input), value = sqliteCatalogResponseSchema.parse(await this.call("catalog", request, request.show_id));
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
    const value = sqliteInspectionSchema.parse(await this.call(`targets/${showId}${episodeId === undefined ? "" : `/${episodeId}`}`, undefined, showId));
    await this.identity(value);
    if (value.show_id !== showId || value.episode_id !== episodeId) throw new Error("SQLite target response differs"); return value;
  }
  private async contentRead(path: string, showId: string) {
    sqliteInspectionSchema.shape.show_id.parse(showId);
    return readSqliteManagementGet(new URL(`/admin/sqlite-service/${path}`, this.config.workers_dev_base_url),
      { "X-Castloop-Key": this.key, "X-Castloop-Show-Id": showId },
      { ...this.readOptions, transport: this.transport, maximumBytes: 8_388_608 });
  }
  private async checkRevisionContent(content: SqliteShowRevisionRecord | SqliteEpisodeRevisionRecord | null | undefined) {
    if (!content) return;
    if (await sha256Hex(JSON.stringify(content.metadata)) !== content.metadata_sha256) throw new Error("Revision metadata hash differs");
    if ("audio" in content) {
      const expected = `${this.config.public_base_url}/podcasts/${content.show_id}/episodes/${content.episode_id}/${content.audio.audio_revision_id}.mp3`;
      if (content.audio.enclosure_url !== expected) throw new Error("Revision audio target differs");
    } else if (content.cover.public_url !== `${this.config.public_base_url}/podcasts/${content.show_id}/cover.${content.cover.extension}`) {
      throw new Error("Revision cover target differs");
    }
  }
  async content(showId: string, episodeId?: string) {
    if (episodeId !== undefined) sqliteInspectionSchema.shape.episode_id.unwrap().parse(episodeId);
    const value = sqliteContentSnapshotSchema.parse(await this.contentRead(`content/${showId}${episodeId === undefined ? "" : `/${episodeId}`}`, showId));
    await this.identity(value);
    if (value.show_id !== showId || value.episode_id !== episodeId) throw new Error("Content response target differs");
    await this.checkRevisionContent(value.show_content);
    await this.checkRevisionContent(value.episode_content);
    return value;
  }
  async revisions(showId: string, episodeId?: string, cursor?: string) {
    if (episodeId !== undefined) sqliteInspectionSchema.shape.episode_id.unwrap().parse(episodeId);
    if (cursor !== undefined && (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw new Error("Invalid revision cursor");
    const path = `revisions/${showId}${episodeId === undefined ? "" : `/episodes/${episodeId}`}${cursor ? `/after/${cursor}` : ""}`;
    const value = sqliteRevisionListResponseSchema.parse(await this.contentRead(path, showId));
    await this.identity(value);
    if (value.show_id !== showId || value.episode_id !== episodeId) throw new Error("History response target differs");
    return value;
  }
  async previewInventory(showId: string, feedGeneration: number, after?: string) {
    if (!Number.isSafeInteger(feedGeneration) || feedGeneration < 0) throw new Error("Invalid Feed generation");
    if (after !== undefined) sqliteInspectionSchema.shape.episode_id.unwrap().parse(after);
    const value = sqlitePreviewInventorySchema.parse(await this.contentRead(
      `content-inventory/${showId}/${feedGeneration}${after ? `/after/${after}` : ""}`, showId));
    await this.identity(value);
    if (value.show_id !== showId || value.feed_generation !== feedGeneration || value.after !== (after ?? null) ||
      value.episodes.some((episode, index, all) => episode.episode_id <= (index ? all[index - 1]!.episode_id : after ?? "")) ||
      value.next_cursor !== null && (value.episodes.length !== 20 || value.next_cursor !== value.episodes.at(-1)?.episode_id)) throw new Error("Preview inventory page differs");
    return value;
  }
  async revision(showId: string, revisionId: string, episodeId?: string) {
    sqliteAvailabilityRequestSchema.shape.operation_id.parse(revisionId);
    if (episodeId !== undefined) sqliteInspectionSchema.shape.episode_id.unwrap().parse(episodeId);
    const value = sqliteRevisionDetailResponseSchema.parse(await this.contentRead(
      `revisions/${showId}${episodeId === undefined ? "" : `/episodes/${episodeId}`}/item/${revisionId}`, showId));
    await this.identity(value);
    const selected = episodeId === undefined ? value.target_show_revision : value.target_episode_revision;
    if (value.show_id !== showId || value.episode_id !== episodeId || selected?.revision_id !== revisionId) throw new Error("Revision response target differs");
    for (const record of [value.current_show, value.current_episode, value.target_show_revision, value.target_episode_revision]) await this.checkRevisionContent(record);
    return value;
  }
  private async checkedControl(input: unknown, showId: string): Promise<SqliteAvailabilityResponse> {
    const value = sqliteAvailabilityResponseSchema.parse(input); await this.identity(value);
    if (value.scope !== "show" || value.show_id !== showId || value.control.request.show_id !== showId ||
      value.control.request.service_id !== this.config.service_id ||
      value.control.request_sha256 !== await sha256Hex(JSON.stringify(value.control.request))) throw new Error("Show control result differs");
    return value;
  }
  async control(input: SqliteAvailabilityRequest): Promise<SqliteAvailabilityResponse> {
    const request = sqliteAvailabilityRequestSchema.parse(input);
    const value = await this.checkedControl(await this.call(request.action, request, request.show_id), request.show_id);
    if (JSON.stringify(value.control.request) !== JSON.stringify(request)) throw new Error("Show control frozen request differs");
    return value;
  }
  async controlStatus(showId: string, operationId: string): Promise<SqliteAvailabilityResponse> {
    sqliteAvailabilityRequestSchema.shape.operation_id.parse(operationId);
    const value = await this.checkedControl(await this.call(`controls/${operationId}`, undefined, showId), showId);
    if (value.control.request.operation_id !== operationId) throw new Error("Show control operation differs");
    return value;
  }
  async register(request: SqliteRuntimeRequest, showId: string, reservationId: string): Promise<SqliteInspection> {
    const initial = sqliteHealthSchema.parse(await this.call("register-show", { ...request, show_id: showId, reservation_id: reservationId }));
    await this.identity(initial);
    if (initial.show_id !== showId || initial.worker_version_id !== request.worker_version_id || initial.setup?.operation_id !== request.operation_id) throw new Error("Show registration evidence differs");
    let ready = initial.publication_ready;
    for (let attempt = 0; !ready && attempt < 120; attempt++) {
      await Bun.sleep(250);
      const health = await this.health(showId);
      if (health.worker_version_id !== request.worker_version_id || health.setup?.operation_id !== request.operation_id || health.setup.state === "blocked") throw new Error("Show initialization is unverified; never replay registration");
      ready = health.publication_ready;
    }
    if (!ready) throw new Error("Show initialization remains pending; inspect without replay");
    const value = await this.inspect(showId);
    if (value.worker_version_id !== request.worker_version_id || value.show_id !== showId || value.episode_id !== undefined || value.reservation_id !== reservationId) throw new Error("SQLite registration result differs");
    return value;
  }
}
