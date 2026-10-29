import { sqliteRegistrationSchema, sqliteHealthSchema } from "../packages/shared/src/sqlite-service-api";
import type { SqliteHealth } from "../packages/shared/src/sqlite-service-api";
import { sqliteCatalogCursorSchema, sqliteCatalogRequestSchema, sqliteCatalogResponseSchema, SQLITE_CATALOG_PAGE_SIZE } from "../packages/shared/src/sqlite-catalog";
import type { SqliteCatalogRequest, SqliteCatalogResponse } from "../packages/shared/src/sqlite-catalog";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import type { SqliteServiceRuntime } from "./sqlite-service-runtime";
import type { ShowRegistration } from "./sqlite-show-service";
import { parseSqliteDomainRequest, requireSqliteDomainConnection, sqliteDomainCommitSchema,
  sqliteDomainFinalizeSchema, sqliteDomainServiceStatusSchema,
  sqliteDomainStatusSchema, sqliteDomainConnectionSchema, SQLITE_DOMAIN_TARGET_PAGE_SIZE } from "../packages/shared/src/sqlite-domain";
import type { SqliteDomainCommit, SqliteDomainRequest, SqliteDomainStatus, SqliteDomainFinalize } from "../packages/shared/src/sqlite-domain";

export type SqliteShowPeer = {
  initialize: (request: ShowRegistration) => Promise<SqliteHealth>;
  health: () => Promise<SqliteHealth>;
  catalog: (request: SqliteCatalogRequest) => Promise<SqliteCatalogResponse>;
  prepareDomain: (request: SqliteDomainRequest) => Promise<SqliteDomainStatus>;
  commitDomain: (request: SqliteDomainCommit) => Promise<SqliteDomainStatus>;
  domainStatus: (operationId: string) => Promise<SqliteDomainStatus>;
};
type RegistryRow = { show_id: string; reservation_id: string; request_json: string; state: string };

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
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS service_domain_connection (id INTEGER PRIMARY KEY CHECK(id = 1), connection_json TEXT NOT NULL)`);
    });
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
    return { ...this.runtime.health(), scope: "service", publication_ready: this.runtime.ready() };
  }
  private verifyHealth(input: SqliteHealth, showId: string, identity = this.runtime.health()): SqliteHealth {
    const health = sqliteHealthSchema.parse(input);
    if (health.show_id !== showId || health.scope !== "show" || health.service_id !== identity.service_id ||
      health.service_config_sha256 !== identity.service_config_sha256) throw new Error("Show runtime evidence differs");
    return health;
  }
  async register(input: ShowRegistration): Promise<SqliteHealth> {
    const request = sqliteRegistrationSchema.parse(input);
    this.runtime.requireTarget({ service_id: request.service_id, service_config_sha256: request.service_config_sha256,
      operation_id: request.operation_id });
    this.storage.transactionSync(() => {
      if (!this.runtime.ready()) throw new Error("Service runtime is not ready");
      const existing = this.storage.sql.exec<RegistryRow>("SELECT * FROM service_show_registry WHERE show_id = ?", request.show_id).toArray()[0];
      if (existing) {
        if (existing.reservation_id !== request.reservation_id) throw new Error("Show ID is already reserved by another registration");
        return;
      }
      this.storage.sql.exec("INSERT INTO service_show_registry (show_id, reservation_id, request_json, state) VALUES (?, ?, ?, 'requested')",
        request.show_id, request.reservation_id, JSON.stringify(request));
    });
    await this.storage.sync();
    const result = this.verifyHealth(await this.peer(request.show_id).initialize(request), request.show_id);
    if (!result.publication_ready) throw new Error("Show initialization evidence differs");
    this.storage.sql.exec("UPDATE service_show_registry SET state = 'registered' WHERE show_id = ?", request.show_id);
    await this.storage.sync();
    return result;
  }
  async health(): Promise<SqliteHealth> {
    const own = this.runtime.health(), rows = this.registry();
    if (rows.length > 10000) throw new Error("Service status exceeds its Show budget");
    const health = await readShowSnapshots(rows, async (row) =>
      this.verifyHealth(await this.peer(row.show_id).health(), row.show_id, own));
    return { ...own, scope: "service",
      show_count: rows.length,
      publication_ready: own.publication_ready && rows.every((row) => row.state === "registered") && health.every((item) => item.publication_ready) };
  }
  async catalog(input: SqliteCatalogRequest): Promise<SqliteCatalogResponse> {
    const request = sqliteCatalogRequestSchema.parse(input);
    if (request.kind !== "show") throw new Error("Episode catalog requires its Show");
    const identity = this.runtime.queue.identity(), { cursor, ...options } = request,
      scope = { service_id: identity.service_id, service_config_sha256: identity.service_config_sha256, ...options };
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
        if (result.service_id !== identity.service_id || result.service_config_sha256 !== identity.service_config_sha256 ||
          result.shows?.length !== 1 && (request.include_deleted || result.shows?.length !== 0) ||
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
    return sqliteCatalogResponseSchema.parse({ ...identity, protocol: "sqlite-sequential-v1", request,
      snapshot_only: true, authorizes_recovery: false, shows: shows.slice(0, SQLITE_CATALOG_PAGE_SIZE),
      next_cursor: shows.length > SQLITE_CATALOG_PAGE_SIZE ? btoa(JSON.stringify({ ...scope, last_id: shows[SQLITE_CATALOG_PAGE_SIZE - 1]!.show_id })) : null });
  }

  domainState() {
    const row = this.storage.sql.exec<{ connection_json: string }>("SELECT connection_json FROM service_domain_connection WHERE id = 1").toArray()[0];
    const pending = this.storage.sql.exec<{ operation_id: string }>(
      "SELECT operation_id FROM publication_domain_changes WHERE state != 'completed'").toArray()[0];
    return { runtime: this.runtime.queue.identity(), connection: row ? sqliteDomainConnectionSchema.parse(JSON.parse(row.connection_json)) : null,
      pending: pending ?? null };
  }
  private verifyDomainStatus(input: SqliteDomainStatus, own: SqliteDomainStatus, showId: string): SqliteDomainStatus {
    const result = sqliteDomainStatusSchema.parse(input);
    if (result.show_id !== showId || result.request_sha256 !== own.request_sha256 ||
      JSON.stringify(result.request) !== JSON.stringify(own.request)) throw new Error("Show domain evidence differs");
    return result;
  }
  private async settledRegistry(): Promise<RegistryRow[]> {
    const rows = this.registry();
    if (rows.length > 10000 || rows.some((row) => row.state !== "registered")) throw new Error("Domain membership is not settled");
    return rows;
  }
  async prepareDomain(input: SqliteDomainRequest) {
    const request = await parseSqliteDomainRequest(input);
    const rows = await this.settledRegistry();
    const connection = this.domainState().connection;
    if (request.action === "add" ? connection !== null : JSON.stringify(connection) !== JSON.stringify(request.connection)) {
      throw new Error("Domain known connection is not settled");
    }
    const own = await this.runtime.domains.prepare(request);
    for (const row of rows) {
      const result = this.verifyDomainStatus(await this.peer(row.show_id).prepareDomain(request), own, row.show_id);
      if (result.phase !== "prepared") throw new Error("Show domain preparation differs");
    }
    return this.domainStatus(request.operation_id);
  }
  async domainStatus(id: string, after = "") {
    const own = await this.runtime.domains.status(id);
    if (after) sqliteRegistrationSchema.shape.show_id.parse(after);
    const rows = this.registry(), page = rows.filter((row) => row.show_id > after).slice(0, SQLITE_DOMAIN_TARGET_PAGE_SIZE + 1);
    const statuses = new Map((await readShowSnapshots(rows, async (row) => {
      const status = this.verifyDomainStatus(await this.peer(row.show_id).domainStatus(id), own, row.show_id);
      return [row.show_id, status.phase] as const;
    })).map(([showId, phase]) => [showId, phase]));
    const targets = page.slice(0, SQLITE_DOMAIN_TARGET_PAGE_SIZE)
      .map((row) => ({ show_id: row.show_id, phase: statuses.get(row.show_id)! }));
    return sqliteDomainServiceStatusSchema.parse({ request: own.request, request_sha256: own.request_sha256, phase: own.phase,
      targets, target_count: rows.length,
      next_cursor: page.length > SQLITE_DOMAIN_TARGET_PAGE_SIZE ? page[SQLITE_DOMAIN_TARGET_PAGE_SIZE - 1]!.show_id : null,
      all_completed: own.phase === "completed" && rows.every((row) => statuses.get(row.show_id) === "completed") });
  }
  async commitDomain(input: SqliteDomainCommit) {
    const commit = sqliteDomainCommitSchema.parse(input);
    const rows = await this.settledRegistry();
    const own = await this.runtime.domains.status(commit.operation_id);
    if (own.commit && JSON.stringify(own.commit) !== JSON.stringify(commit)) throw new Error("Keep the frozen domain commit receipt");
    for (const row of rows) {
      const result = this.verifyDomainStatus(await this.peer(row.show_id).commitDomain(commit), own, row.show_id);
      if (result.phase !== "completed") throw new Error("Show domain commit differs");
    }
    const completed = await this.runtime.domains.commit(commit);
    if (completed.phase !== "completed") throw new Error("Service domain commit differs");
    return this.domainStatus(commit.operation_id);
  }
  async finalizeDomain(input: SqliteDomainFinalize) {
    const request = sqliteDomainFinalizeSchema.parse(input), status = await this.domainStatus(request.operation_id);
    const own = await this.runtime.domains.status(request.operation_id);
    requireSqliteDomainConnection(request.connection, status.request);
    if (!status.all_completed || status.phase !== "completed" || status.request_sha256 !== request.request_sha256 ||
      request.detached !== (status.request.action === "remove") ||
      !own.commit || JSON.stringify(request.connection) !== JSON.stringify(own.commit.connection)) {
      throw new Error("Domain finalization has no exact complete evidence");
    }
    this.storage.transactionSync(() => {
      if (request.detached) this.storage.sql.exec("DELETE FROM service_domain_connection WHERE id = 1");
      else this.storage.sql.exec("INSERT INTO service_domain_connection (id, connection_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET connection_json = excluded.connection_json", JSON.stringify(request.connection));
    });
    await this.storage.sync();
    return this.domainStatus(request.operation_id);
  }
}
