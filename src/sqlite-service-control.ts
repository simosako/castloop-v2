import { sqliteRegistrationSchema, sqliteHealthSchema } from "../packages/shared/src/sqlite-service-api";
import type { SqliteHealth } from "../packages/shared/src/sqlite-service-api";
import { sqliteCatalogCursorSchema, sqliteCatalogRequestSchema, sqliteCatalogResponseSchema, SQLITE_CATALOG_PAGE_SIZE } from "../packages/shared/src/sqlite-catalog";
import type { SqliteCatalogRequest, SqliteCatalogResponse } from "../packages/shared/src/sqlite-catalog";
import { sqliteUpdateActivateSchema, sqliteUpdatePrepareSchema, sqliteUpdateResultSchema } from "../packages/shared/src/sqlite-runtime-update";
import type { SqliteUpdateActivate, SqliteUpdatePrepare, SqliteUpdateResult } from "../packages/shared/src/sqlite-runtime-update";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import type { SqliteServiceRuntime } from "./sqlite-service-runtime";
import type { ShowRegistration } from "./sqlite-show-service";

export type SqliteShowPeer = {
  initialize: (request: ShowRegistration) => Promise<SqliteHealth>;
  health: () => Promise<SqliteHealth>;
  catalog: (request: SqliteCatalogRequest) => Promise<SqliteCatalogResponse>;
  prepare: (request: SqliteUpdatePrepare) => Promise<SqliteUpdateResult>;
  activate: (request: SqliteUpdateActivate) => Promise<SqliteUpdateResult>;
  release: (operationId: string) => Promise<SqliteHealth>;
};
type RegistryRow = { show_id: string; reservation_id: string; request_json: string; state: string };
type MaintenanceRow = { operation_id: string; request_json: string; phase: "preparing" | "prepared" | "activating" | "probing" | "releasing" | "completed" };
type TargetRow = { show_id: string; prepare_state: string; activate_state: string; release_state: string };

async function readShowSnapshots<T, R>(rows: T[], read: (row: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < rows.length; offset += 4) {
    const batch = await Promise.allSettled(rows.slice(offset, offset + 4).map(async (row) => read(row)));
    for (const item of batch) {
      if (item.status === "rejected") throw item.reason;
      result.push(item.value);
    }
  }
  return result;
}

export class SqliteServiceControl {
  constructor(private readonly storage: PublicationQueueStorage, readonly runtime: SqliteServiceRuntime,
    private readonly peer: (showId: string) => SqliteShowPeer) {
    storage.transactionSync(() => {
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS service_show_registry (show_id TEXT PRIMARY KEY,
        reservation_id TEXT UNIQUE NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('requested', 'registered')))`);
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS service_show_maintenance (operation_id TEXT PRIMARY KEY, request_json TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('preparing', 'prepared', 'activating', 'probing', 'releasing', 'completed')))`);
      storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS service_one_show_maintenance ON service_show_maintenance ((1)) WHERE phase != 'completed'");
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS service_show_update_targets (operation_id TEXT NOT NULL, show_id TEXT NOT NULL,
        prepare_state TEXT NOT NULL DEFAULT 'pending' CHECK(prepare_state IN ('pending', 'requested', 'confirmed')),
        activate_state TEXT NOT NULL DEFAULT 'pending' CHECK(activate_state IN ('pending', 'requested', 'confirmed')),
        release_state TEXT NOT NULL DEFAULT 'pending' CHECK(release_state IN ('pending', 'requested', 'confirmed')),
        PRIMARY KEY(operation_id, show_id))`);
    });
  }
  private pending(): MaintenanceRow | null {
    return this.storage.sql.exec<MaintenanceRow>("SELECT * FROM service_show_maintenance WHERE phase != 'completed'").toArray()[0] ?? null;
  }
  private maintenance(): SqliteHealth["maintenance"] {
    const row = this.pending();
    return row && row.phase !== "completed" ? { operation_id: row.operation_id, phase: row.phase } : null;
  }
  private targets(operationId: string): TargetRow[] {
    return this.storage.sql.exec<TargetRow>("SELECT show_id, prepare_state, activate_state, release_state FROM service_show_update_targets WHERE operation_id = ? ORDER BY show_id", operationId).toArray();
  }
  private registry(after = "", limit = 10001): RegistryRow[] {
    return this.storage.sql.exec<RegistryRow>("SELECT * FROM service_show_registry WHERE show_id > ? ORDER BY show_id LIMIT ?", after, limit).toArray();
  }
  registrationStatus(showId: string) {
    sqliteRegistrationSchema.shape.show_id.parse(showId);
    const row = this.storage.sql.exec<RegistryRow>("SELECT * FROM service_show_registry WHERE show_id = ?", showId).toArray()[0];
    return { show_id: showId, reservation_id: row?.reservation_id ?? null, state: row?.state ?? "missing" };
  }
  registrationHealth(): SqliteHealth {
    return { ...this.runtime.health(), scope: "service", maintenance: this.maintenance(), publication_ready: this.runtime.ready() && !this.pending() };
  }
  private verifyHealth(input: SqliteHealth, showId: string, version?: string, identity = this.runtime.health()): SqliteHealth {
    const health = sqliteHealthSchema.parse(input);
    if (health.show_id !== showId || health.scope !== "show" || health.service_id !== identity.service_id ||
      health.service_config_sha256 !== identity.service_config_sha256 || health.worker_version_id !== (version ?? identity.worker_version_id)) throw new Error("Show runtime evidence differs");
    return health;
  }
  async register(input: ShowRegistration): Promise<SqliteHealth> {
    const request = sqliteRegistrationSchema.parse(input);
    this.runtime.requireTarget({ service_id: request.service_id, worker_version_id: request.worker_version_id,
      service_config_sha256: request.service_config_sha256, operation_id: request.operation_id });
    this.storage.transactionSync(() => {
      if (!this.runtime.ready() || this.pending()) throw new Error("Service registration is in maintenance");
      if (this.storage.sql.exec("SELECT show_id FROM service_show_registry WHERE show_id = ?", request.show_id).toArray().length) throw new Error("Show ID permanently reserved; inspect without replay");
      this.storage.sql.exec("INSERT INTO service_show_registry (show_id, reservation_id, request_json, state) VALUES (?, ?, ?, 'requested')",
        request.show_id, request.reservation_id, JSON.stringify(request));
    });
    await this.storage.sync();
    const result = this.verifyHealth(await this.peer(request.show_id).initialize(request), request.show_id);
    if (result.setup?.operation_id !== request.operation_id || result.state !== "paused" || !result.drained) throw new Error("Show initialization evidence differs");
    this.storage.sql.exec("UPDATE service_show_registry SET state = 'registered' WHERE show_id = ?", request.show_id);
    await this.storage.sync();
    return result;
  }
  async health(): Promise<SqliteHealth> {
    const own = this.runtime.health(), rows = this.registry();
    if (rows.length > 10000) throw new Error("Service status exceeds its Show budget");
    const health = await readShowSnapshots(rows, async (row) =>
      this.verifyHealth(await this.peer(row.show_id).health(), row.show_id, undefined, own));
    return { ...own, scope: "service", maintenance: this.maintenance(), state: health.some((item) => item.state === "open") ? "open" : "paused",
      admission_window_id: null, show_count: rows.length, paused_shows: health.filter((item) => item.state === "paused").length,
      publication_ready: own.publication_ready && !this.pending() && rows.every((row) => row.state === "registered") && health.every((item) => item.publication_ready),
      queued: health.reduce((sum, item) => sum + item.queued, 0), active: health.some((item) => item.active === "blocked") ? "blocked" :
        health.some((item) => item.active === "running") ? "running" : null,
      drained: rows.every((row) => row.state === "registered") && health.every((item) => item.drained) };
  }
  async catalog(input: SqliteCatalogRequest): Promise<SqliteCatalogResponse> {
    const request = sqliteCatalogRequestSchema.parse(input);
    if (request.kind !== "show") throw new Error("Episode catalog requires its Show");
    const identity = this.runtime.queue.identity(), { cursor, ...options } = request, scope = { ...identity, ...options };
    let after = "";
    if (cursor) {
      const { last_id, ...bound } = sqliteCatalogCursorSchema.parse(JSON.parse(atob(cursor)));
      if (JSON.stringify(bound) !== JSON.stringify(sqliteCatalogCursorSchema.omit({ last_id: true }).parse(scope))) throw new Error("Registry cursor differs");
      after = last_id;
    }
    const shows: NonNullable<SqliteCatalogResponse["shows"]> = [];
    let last = after;
    for (;;) {
      const rows = this.registry(last, SQLITE_CATALOG_PAGE_SIZE + 1);
      if (!rows.length) break;
      const pages = await readShowSnapshots(rows, async (row) => {
        if (row.state !== "registered") throw new Error("Show registration remains unconfirmed");
        const result = sqliteCatalogResponseSchema.parse(await this.peer(row.show_id).catalog({ kind: "show", include_deleted: request.include_deleted }));
        if (result.service_id !== identity.service_id || result.worker_version_id !== identity.worker_version_id ||
          result.service_config_sha256 !== identity.service_config_sha256 || result.shows?.length !== 1 && (request.include_deleted || result.shows?.length !== 0) ||
          result.shows?.some((show) => show.show_id !== row.show_id)) throw new Error("Show catalog evidence differs");
        return result.shows?.[0];
      });
      for (const [index, row] of rows.entries()) {
        if (pages[index]) shows.push(pages[index]!);
        last = row.show_id;
        if (shows.length > SQLITE_CATALOG_PAGE_SIZE) break;
      }
      if (shows.length > SQLITE_CATALOG_PAGE_SIZE || rows.length < SQLITE_CATALOG_PAGE_SIZE + 1) break;
    }
    return sqliteCatalogResponseSchema.parse({ ...identity, protocol: "sqlite-sequential-v1", request, state: null,
      snapshot_only: true, authorizes_recovery: false, shows: shows.slice(0, SQLITE_CATALOG_PAGE_SIZE),
      next_cursor: shows.length > SQLITE_CATALOG_PAGE_SIZE ? btoa(JSON.stringify({ ...scope, last_id: shows[SQLITE_CATALOG_PAGE_SIZE - 1]!.show_id })) : null });
  }

  async prepareUpdate(input: SqliteUpdatePrepare): Promise<SqliteUpdateResult> {
    const request = sqliteUpdatePrepareSchema.parse(input);
    this.storage.transactionSync(() => {
      this.runtime.requireTarget({ service_id: request.service_id, worker_version_id: request.worker_version_id,
        service_config_sha256: request.service_config_sha256, operation_id: request.operation_id });
      const rows = this.registry();
      if (!this.runtime.ready() || this.pending() || rows.length > 10000 || rows.some((row) => row.state !== "registered")) throw new Error("Shared update membership is not settled");
      this.storage.sql.exec("INSERT INTO service_show_maintenance (operation_id, request_json, phase) VALUES (?, ?, 'preparing')", request.operation_id, JSON.stringify(request));
      for (const row of rows) this.storage.sql.exec("INSERT INTO service_show_update_targets (operation_id, show_id) VALUES (?, ?)", request.operation_id, row.show_id);
    });
    await this.storage.sync();
    for (const target of this.targets(request.operation_id)) {
      this.storage.sql.exec("UPDATE service_show_update_targets SET prepare_state = 'requested' WHERE operation_id = ? AND show_id = ?", request.operation_id, target.show_id);
      await this.storage.sync();
      const result = sqliteUpdateResultSchema.parse(await this.peer(target.show_id).prepare(request));
      if (result.worker_version_id !== request.worker_version_id || result.service_id !== request.service_id || result.service_config_sha256 !== request.service_config_sha256 ||
        JSON.stringify(result.request) !== JSON.stringify(request) || result.update.state !== "prepared" || result.update.operation_id !== request.operation_id || !result.paused || !result.drained) throw new Error("Show update preparation differs");
      this.storage.sql.exec("UPDATE service_show_update_targets SET prepare_state = 'confirmed' WHERE operation_id = ? AND show_id = ?", request.operation_id, target.show_id);
    }
    return this.storage.transactionSync(() => {
      const result = this.runtime.updates.prepare(request);
      this.storage.sql.exec("UPDATE service_show_maintenance SET phase = 'prepared' WHERE operation_id = ?", request.operation_id);
      return result;
    });
  }
  async updateStatus(operationId: string): Promise<SqliteUpdateResult> {
    const row = this.storage.sql.exec<MaintenanceRow>("SELECT * FROM service_show_maintenance WHERE operation_id = ?", operationId).toArray()[0];
    if (!row || !["prepared", "probing", "releasing", "completed"].includes(row.phase)) throw new Error("Shared update is incomplete or uncertain");
    const result = this.runtime.updates.statusById(operationId);
    if (row.phase === "prepared") {
      let nativeReady = true;
      for (const target of this.targets(operationId)) {
        const health = sqliteHealthSchema.parse(await this.peer(target.show_id).health());
        if (![result.worker_version_id, result.request.worker_version_id].includes(health.worker_version_id)) throw new Error("Unknown Show native runtime");
        this.verifyHealth(health, target.show_id, health.worker_version_id);
        if (health.maintenance_operation_id !== operationId || health.runtime_update?.operation_id !== operationId || health.runtime_update.state !== "prepared" ||
          health.runtime_update.previous_worker_version_id !== result.request.worker_version_id || health.runtime_update.new_worker_version_id !== null ||
          health.state !== "paused" || !health.drained) throw new Error("Show prepared native runtime differs");
        if (health.worker_version_id !== result.worker_version_id) nativeReady = false;
      }
      return { ...result, targets_native_ready: nativeReady };
    }
    if (row.phase !== "completed" && result.update.state === "completed") return { ...result, update: { ...result.update, state: "activated" } };
    return result;
  }
  async activateUpdate(input: SqliteUpdateActivate): Promise<SqliteUpdateResult> {
    const request = sqliteUpdateActivateSchema.parse(input), { new_worker_version_id, deployment_id, script_etag, ...base } = request;
    const row = this.pending();
    if (row?.operation_id !== request.operation_id || row.request_json !== JSON.stringify(base) || row.phase !== "prepared") throw new Error("Shared activation already started or differs");
    const native = await this.updateStatus(request.operation_id);
    if (!native.targets_native_ready || native.worker_version_id !== new_worker_version_id) throw new Error("Shared activation requires every exact new native runtime");
    this.storage.transactionSync(() => {
      const current = this.pending();
      if (current?.operation_id !== request.operation_id || current.phase !== "prepared" || current.request_json !== JSON.stringify(base)) throw new Error("Shared activation changed during verification");
      this.storage.sql.exec("UPDATE service_show_maintenance SET phase = 'activating' WHERE operation_id = ?", request.operation_id);
    });
    await this.storage.sync();
    for (const target of this.targets(request.operation_id)) {
      if (target.prepare_state !== "confirmed" || target.activate_state !== "pending") throw new Error("Show activation is uncertain");
      this.storage.sql.exec("UPDATE service_show_update_targets SET activate_state = 'requested' WHERE operation_id = ? AND show_id = ?", request.operation_id, target.show_id);
      await this.storage.sync();
      const result = sqliteUpdateResultSchema.parse(await this.peer(target.show_id).activate(request));
      if (result.worker_version_id !== new_worker_version_id || result.update.operation_id !== request.operation_id || result.update.new_worker_version_id !== new_worker_version_id ||
        JSON.stringify(result.request) !== JSON.stringify(base) || result.update.state !== "activated") throw new Error("Show activation evidence differs");
      this.storage.sql.exec("UPDATE service_show_update_targets SET activate_state = 'confirmed' WHERE operation_id = ? AND show_id = ?", request.operation_id, target.show_id);
    }
    await this.runtime.updates.activate(request);
    this.storage.sql.exec("UPDATE service_show_maintenance SET phase = 'probing' WHERE operation_id = ?", request.operation_id);
    await this.storage.sync();
    return this.updateStatus(request.operation_id);
  }
  async progress(): Promise<void> {
    const row = this.pending();
    if (!row || row.phase !== "probing") return;
    // Polling is read-only; mutating fan-out steps are never replayed by an Alarm.
    const own = this.runtime.health();
    if (own.setup?.state === "blocked" || own.runtime_update?.state === "blocked") return;
    let waiting = !own.publication_ready || own.runtime_update?.operation_id !== row.operation_id || own.runtime_update.state !== "completed";
    for (const target of this.targets(row.operation_id)) {
      const health = this.verifyHealth(await this.peer(target.show_id).health(), target.show_id);
      if (health.maintenance_operation_id !== row.operation_id) throw new Error("Show maintenance binding differs");
      if (health.setup?.state === "blocked" || health.runtime_update?.state === "blocked") return;
      if (!health.publication_ready || health.runtime_update?.operation_id !== row.operation_id || health.runtime_update.state !== "completed" || health.state !== "paused" || !health.drained) waiting = true;
    }
    if (waiting) { await this.storage.setAlarm(Date.now() + 1000); return; }
    const claimed = this.storage.transactionSync(() => {
      const current = this.pending();
      if (current?.operation_id !== row.operation_id || current.phase !== "probing") return false;
      this.storage.sql.exec("UPDATE service_show_maintenance SET phase = 'releasing' WHERE operation_id = ?", row.operation_id);
      return true;
    });
    if (!claimed) return;
    await this.storage.sync();
    for (const target of this.targets(row.operation_id)) {
      if (target.release_state !== "pending") throw new Error("Show release is uncertain");
      this.storage.sql.exec("UPDATE service_show_update_targets SET release_state = 'requested' WHERE operation_id = ? AND show_id = ?", row.operation_id, target.show_id);
      await this.storage.sync();
      const health = this.verifyHealth(await this.peer(target.show_id).release(row.operation_id), target.show_id);
      if (!health.publication_ready || health.runtime_update?.operation_id !== row.operation_id || health.runtime_update.state !== "completed") throw new Error("Show release evidence differs");
      this.storage.sql.exec("UPDATE service_show_update_targets SET release_state = 'confirmed' WHERE operation_id = ? AND show_id = ?", row.operation_id, target.show_id);
    }
    this.storage.sql.exec("UPDATE service_show_maintenance SET phase = 'completed' WHERE operation_id = ?", row.operation_id);
    await this.storage.sync();
  }
}
