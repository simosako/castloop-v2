import { sqliteRegistrationSchema, sqliteAvailabilityResponseSchema } from "../packages/shared/src/sqlite-service-api";
import { sqliteAvailabilityRequestSchema, sqliteAvailabilityActionSchema } from "../packages/shared/src/sqlite-availability";
import { authenticated } from "./admin-auth";
import { readBoundedAdminJson } from "./admin-body";
import type { SqliteHealth } from "../packages/shared/src/sqlite-service-api";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import type { SqliteUpdateActivate, SqliteUpdatePrepare } from "../packages/shared/src/sqlite-runtime-update";
import { parsePublicAssetPath } from "../packages/shared/src/public-assets";
import { adminReply } from "./admin-reply";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { createSqlitePublicationHttp } from "./sqlite-publication-http";
import { createSqliteServiceHttp } from "./sqlite-service-http";
import { createSqliteOperationHttp } from "./sqlite-operation-http";
import { createSqliteOperationRecords } from "./sqlite-operation-runtime";
import { SqliteServiceRuntime } from "./sqlite-service-runtime";
import type { SqliteRuntimeCache } from "./sqlite-service-runtime";
import type { SqlitePublicationBucket } from "./sqlite-publication-executor";
import type { OperationCleanupBucket } from "./sqlite-operation-records";
import { selectSqliteRuntime } from "./sqlite-runtime-update";
import type { SqliteDomainRequest, SqliteDomainActivation } from "../packages/shared/src/sqlite-domain";

export type ShowRegistration = ReturnType<typeof sqliteRegistrationSchema.parse>;
type Binding = { show_id: string; maintenance_id: string | null };

export class SqliteShowService {
  readonly queue: SqlitePublicationQueue;
  readonly content: SqlitePublicationContent;
  readonly runtime: SqliteServiceRuntime;
  private readonly publicationHttp: (request: Request) => Promise<Response>;
  private readonly serviceHttp: (request: Request) => Promise<Response>;
  private readonly operationHttp: (request: Request) => Promise<Response>;

  constructor(private readonly storage: PublicationQueueStorage, readonly showId: string,
    private readonly actual: SqlitePublicationRuntime, private readonly config: SqliteServiceConfig, private readonly cache: SqliteRuntimeCache,
    private readonly bucket: SqlitePublicationBucket & OperationCleanupBucket, private readonly key: string) {
    sqliteRegistrationSchema.shape.show_id.parse(showId);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_show_binding (id INTEGER PRIMARY KEY CHECK(id = 1),
      show_id TEXT NOT NULL, reservation_id TEXT NOT NULL, registration_json TEXT NOT NULL, maintenance_id TEXT)`);
    if (this.binding()?.show_id && this.binding()!.show_id !== showId) throw new Error("Show storage identity differs");
    this.queue = new SqlitePublicationQueue(storage, selectSqliteRuntime(storage, actual), Date.now, { showId, ready: () => this.ready() });
    this.content = new SqlitePublicationContent(storage);
    this.runtime = new SqliteServiceRuntime(storage, this.queue, this.content, bucket, config, cache, actual, showId);
    const ready = () => this.ready();
    const records = createSqliteOperationRecords(storage, this.queue, this.content, ready, showId);
    this.publicationHttp = createSqlitePublicationHttp(this.queue, key, ready, showId);
    this.serviceHttp = createSqliteServiceHttp(this.runtime, key);
    this.operationHttp = createSqliteOperationHttp(records, key, ready, bucket);
  }

  private binding(): Binding | null {
    return this.storage.sql.exec<Binding>("SELECT show_id, maintenance_id FROM publication_show_binding WHERE id = 1").toArray()[0] ?? null;
  }
  ready(): boolean { const binding = this.binding(); return !!binding && !binding.maintenance_id && this.runtime.ready(); }
  alarmRuntime(): SqliteServiceRuntime {
    return new SqliteServiceRuntime(this.storage, this.queue, this.content, this.bucket, this.config, this.cache, this.actual, this.showId);
  }
  health(): SqliteHealth { return { ...this.runtime.health(), scope: "show", show_id: this.showId,
    maintenance_operation_id: this.binding()?.maintenance_id ?? null, publication_ready: this.ready() }; }

  async initialize(input: ShowRegistration): Promise<SqliteHealth> {
    const request = sqliteRegistrationSchema.parse(input);
    this.runtime.requireTarget({ service_id: request.service_id, worker_version_id: request.worker_version_id,
      service_config_sha256: request.service_config_sha256, operation_id: request.operation_id });
    if (request.show_id !== this.showId) throw new Error("Show registration target differs");
    this.storage.transactionSync(() => {
      if (this.binding()) throw new Error("Show initialization already started; inspect without replay");
      this.storage.sql.exec("INSERT INTO publication_show_binding (id, show_id, reservation_id, registration_json) VALUES (1, ?, ?, ?)", this.showId, request.reservation_id, JSON.stringify(request));
      this.content.registerShow(this.showId, request.reservation_id, true);
    });
    await this.runtime.prepare({ service_id: request.service_id, worker_version_id: request.worker_version_id,
      service_config_sha256: request.service_config_sha256, operation_id: request.operation_id });
    return this.health();
  }

  prepareUpdate(request: SqliteUpdatePrepare) {
    return this.storage.transactionSync(() => {
      const binding = this.binding();
      if (!binding || binding.maintenance_id) throw new Error("Show maintenance already started");
      const result = this.runtime.updates.prepare(request);
      this.storage.sql.exec("UPDATE publication_show_binding SET maintenance_id = ? WHERE id = 1", request.operation_id);
      return result;
    });
  }
  async activateUpdate(request: SqliteUpdateActivate) {
    if (this.binding()?.maintenance_id !== request.operation_id) throw new Error("Show maintenance identity differs");
    return this.runtime.updates.activate(request);
  }
  releaseUpdate(operationId: string): SqliteHealth {
    return this.storage.transactionSync(() => {
      const health = this.runtime.health();
      if (this.binding()?.maintenance_id !== operationId || !health.publication_ready || health.runtime_update?.operation_id !== operationId ||
        health.runtime_update.state !== "completed" || health.state !== "paused" || !health.drained) throw new Error("Show probe is not complete");
      this.storage.sql.exec("UPDATE publication_show_binding SET maintenance_id = NULL WHERE id = 1");
      return this.health();
    });
  }
  maintenanceHealth(): SqliteHealth { return { ...this.health(), publication_ready: this.runtime.ready() }; }

  async prepareDomain(request: SqliteDomainRequest) {
    return this.runtime.domains.prepare(request, () => {
      if (!this.binding() || this.binding()!.maintenance_id) throw new Error("Show maintenance already started");
      this.storage.sql.exec("UPDATE publication_show_binding SET maintenance_id = ? WHERE id = 1", request.operation_id);
    });
  }
  async activateDomain(request: SqliteDomainActivation) {
    if (this.binding()?.maintenance_id !== request.operation_id) throw new Error("Show domain maintenance differs");
    return this.runtime.domains.activate(request);
  }
  async domainStatus(id: string) {
    const status = await this.runtime.domains.status(id);
    if (status.phase !== "completed" && this.binding()?.maintenance_id !== id) throw new Error("Domain Show maintenance was lost");
    return status;
  }
  async releaseDomain(id: string): Promise<SqliteHealth> {
    const domain = await this.domainStatus(id);
    return this.storage.transactionSync(() => {
      if (domain.phase !== "completed" || !this.runtime.ready() || this.binding()?.maintenance_id !== id ||
        this.queue.snapshot().state !== "paused" || !this.queue.snapshot().drained) throw new Error("Domain Show probe is not complete");
      this.storage.sql.exec("UPDATE publication_show_binding SET maintenance_id = NULL WHERE id = 1");
      return this.health();
    });
  }

  delivery(path: string) {
    if (parsePublicAssetPath(path)?.showId !== this.showId) return { status: 404 as const };
    return this.storage.transactionSync(() => this.ready() ? this.content.delivery(path) : { status: 503 as const });
  }
  private async controlHttp(request: Request): Promise<Response> {
    if (!await authenticated(request, this.key)) return adminReply({ error: "unauthorized" }, 401);
    const url = new URL(request.url), action = url.pathname.slice("/admin/sqlite-service/".length);
    if (url.search || url.hash) return adminReply({ error: "invalid_route" }, 400);
    try {
      if (!this.binding()) throw new Error("Show binding is missing");
      if (action.startsWith("controls/") && request.method === "GET") {
        const control = this.queue.controlRecord(action.slice(9));
        return control ? adminReply(sqliteAvailabilityResponseSchema.parse({ ...this.health(), control })) : adminReply({ error: "not_found" }, 404);
      }
      if (action.startsWith("controls/")) return adminReply({ error: "method_not_allowed" }, 405);
      if (request.method !== "POST") return adminReply({ error: "method_not_allowed" }, 405);
      if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json" || request.headers.has("Content-Encoding")) {
        return adminReply({ error: "invalid_input" }, 400);
      }
      const input = sqliteAvailabilityRequestSchema.parse(await readBoundedAdminJson(request));
      if (input.action !== sqliteAvailabilityActionSchema.parse(action) || input.show_id !== this.showId) throw new Error("Show control differs");
      const control = await this.queue.applyControl(input, this.actual);
      return adminReply(sqliteAvailabilityResponseSchema.parse({ ...this.health(), control }));
    } catch {
      console.error(JSON.stringify({ event: "sqlite_service_http", reason_code: "service_request_unverified" }));
      return adminReply({ error: "control_unverified" }, 409);
    }
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.headers.get("X-Castloop-Show-Id") !== this.showId) return adminReply({ error: "show_required" }, 400);
    if (["pause", "resume", "admission-pause", "delivery-resume"].some((action) => path === `/admin/sqlite-service/${action}`) ||
      path.startsWith("/admin/sqlite-service/controls/")) return this.controlHttp(request);
    if (path === "/admin/sqlite-service/health") {
      const response = await this.serviceHttp(request);
      if (!response.ok) return response;
      await response.body?.cancel();
      return adminReply(this.health());
    }
    if (path.startsWith("/admin/sqlite-service/targets/") && path.split("/")[4] !== this.showId) return adminReply({ error: "target_differs" }, 409);
    if (["/admin/sqlite-service/register-show", "/admin/sqlite-service/prepare", "/admin/sqlite-service/update-prepare", "/admin/sqlite-service/update-activate"].includes(path)) return adminReply({ error: "not_found" }, 404);
    if (request.method === "POST") {
      if (!this.ready()) return adminReply({ error: "show_not_ready" }, 503);
    }
    return path.startsWith("/admin/sqlite-operations/") ? this.operationHttp(request) :
      path.startsWith("/admin/sqlite-service/") ? this.serviceHttp(request) : this.publicationHttp(request);
  }
}
