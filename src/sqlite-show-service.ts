import { sqliteRegistrationSchema } from "../packages/shared/src/sqlite-service-api";
import type { SqliteHealth } from "../packages/shared/src/sqlite-service-api";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { parsePublicAssetPath } from "../packages/shared/src/public-assets";
import { adminReply } from "./admin-reply";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import { createSqlitePublicationHttp } from "./sqlite-publication-http";
import { createSqliteScheduleHttp } from "./sqlite-schedule-http";
import { SqlitePublicationSchedules } from "./sqlite-publication-schedules";
import { createSqliteServiceHttp } from "./sqlite-service-http";
import { SqliteDeliveryStats } from "./sqlite-delivery-stats";
import { createSqliteStatsHttp } from "./sqlite-stats-http";
import { SqliteServiceRuntime } from "./sqlite-service-runtime";
import type { SqliteRuntimeCache } from "./sqlite-service-runtime";
import { createSqlitePublicationExecutor } from "./sqlite-publication-executor";
import { resolveSqliteRuntime } from "./sqlite-runtime-identity";
import type { SqliteDomainCommit, SqliteDomainRequest } from "../packages/shared/src/sqlite-domain";
import type { SitePage } from "../packages/shared/src/website";
import type { SiteDeliveryDecision } from "./site-gateway";
import type { PublicCacheProps } from "./public-assets";
import type { SiteCacheProps } from "./site-cache";

export type ShowRegistration = ReturnType<typeof sqliteRegistrationSchema.parse>;
type Binding = { show_id: string; reservation_id: string };

export class SqliteShowService {
  readonly queue: SqlitePublicationQueue;
  readonly content: SqlitePublicationContent;
  readonly schedules: SqlitePublicationSchedules;
  readonly runtime: SqliteServiceRuntime;
  readonly stats: SqliteDeliveryStats;
  private readonly publicationHttp: (request: Request) => Promise<Response>;
  private readonly scheduleHttp: (request: Request) => Promise<Response>;
  private readonly serviceHttp: (request: Request) => Promise<Response>;
  private readonly statsHttp: (request: Request) => Promise<Response>;

  constructor(private readonly storage: PublicationQueueStorage, readonly showId: string,
    private readonly actual: SqlitePublicationRuntime, private readonly config: SqliteServiceConfig, private readonly cache: SqliteRuntimeCache,
    private readonly key: string) {
    sqliteRegistrationSchema.shape.show_id.parse(showId);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_show_binding (id INTEGER PRIMARY KEY CHECK(id = 1),
      show_id TEXT NOT NULL, reservation_id TEXT NOT NULL, registration_json TEXT NOT NULL)`);
    if (this.binding()?.show_id && this.binding()!.show_id !== showId) throw new Error("Show storage identity differs");
    this.queue = new SqlitePublicationQueue(storage, resolveSqliteRuntime(storage, actual), Date.now, { showId, ready: () => this.ready() });
    this.content = new SqlitePublicationContent(storage);
    this.queue.executor = createSqlitePublicationExecutor(this.content, config, {
      purge: ({ showId: id, episodeId }) => cache.purgeMedia ? cache.purgeMedia({ showId: id, ...(episodeId ? { episodeId } : {}) }) : cache.purge(id),
      purgeSite: (target) => cache.purgeSite ? cache.purgeSite(target) : Promise.resolve(),
    });
    this.schedules = new SqlitePublicationSchedules(storage, this.queue, this.content, Date.now, { showId, ready: () => this.ready() });
    this.runtime = new SqliteServiceRuntime(storage, this.queue, this.content, config, cache, actual, showId);
    const ready = () => this.ready();
    this.publicationHttp = createSqlitePublicationHttp(this.queue, key, ready);
    this.scheduleHttp = createSqliteScheduleHttp(this.schedules, key, showId);
    this.serviceHttp = createSqliteServiceHttp(this.runtime, key);
    this.stats = new SqliteDeliveryStats(storage, showId,
      { service_id: actual.service_id, service_config_sha256: actual.service_config_sha256 }, Date.now);
    this.statsHttp = createSqliteStatsHttp(this.stats, key, showId, () => this.health());
  }

  private binding(): Binding | null {
    return this.storage.sql.exec<Binding>("SELECT show_id, reservation_id FROM publication_show_binding WHERE id = 1").toArray()[0] ?? null;
  }
  ready(): boolean { return !!this.binding() && this.runtime.ready(); }
  health(): SqliteHealth { return { ...this.runtime.health(), scope: "show", show_id: this.showId,
    publication_ready: this.ready(), schedules: this.schedules.summary() }; }

  async initialize(input: ShowRegistration): Promise<SqliteHealth> {
    const request = sqliteRegistrationSchema.parse(input);
    this.runtime.requireTarget({ service_id: request.service_id, service_config_sha256: request.service_config_sha256,
      operation_id: request.operation_id });
    if (request.show_id !== this.showId) throw new Error("Show registration target differs");
    this.storage.transactionSync(() => {
      const existing = this.binding();
      if (existing) {
        if (existing.show_id !== this.showId || existing.reservation_id !== request.reservation_id) {
          throw new Error("Show initialization already bound to a different reservation");
        }
        return;
      }
      this.storage.sql.exec("INSERT INTO publication_show_binding (id, show_id, reservation_id, registration_json) VALUES (1, ?, ?, ?)", this.showId, request.reservation_id, JSON.stringify(request));
      this.content.registerShow(this.showId, request.reservation_id, true);
    });
    await this.storage.sync();
    return this.health();
  }

  async prepareDomain(request: SqliteDomainRequest) {
    return this.runtime.domains.prepare(request, () => this.schedules.suspendOpen("domain_change"));
  }
  async commitDomain(request: SqliteDomainCommit) {
    return this.runtime.domains.commit(request);
  }
  async domainStatus(id: string) {
    return this.runtime.domains.status(id);
  }

  delivery(path: string) {
    if (parsePublicAssetPath(path)?.showId !== this.showId) return { status: 404 as const };
    return this.storage.transactionSync(() => this.ready() ? this.content.delivery(path) : { status: 503 as const });
  }
  siteDelivery(page: SitePage): SiteDeliveryDecision {
    if (page.showId !== this.showId) return { status: 404 };
    return this.storage.transactionSync(() => this.ready() ? this.content.siteDelivery(page) : { status: 503 });
  }
  renderFeed(props?: PublicCacheProps) {
    return this.storage.transactionSync(() =>
      this.ready() ? this.content.renderFeed(this.showId, this.config.public_base_url, props) : null);
  }
  renderSitePage(page: SitePage, props?: SiteCacheProps) {
    if (page.showId !== this.showId) return null;
    return this.storage.transactionSync(() =>
      this.ready() ? this.content.renderSitePage(page, this.config.public_base_url, props) : null);
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.headers.get("X-Castloop-Show-Id") !== this.showId) return adminReply({ error: "show_required" }, 400);
    if (path === "/admin/sqlite-service/health") {
      const response = await this.serviceHttp(request);
      if (!response.ok) return response;
      await response.body?.cancel();
      return adminReply(this.health());
    }
    if ((path.startsWith("/admin/sqlite-service/targets/") || path.startsWith("/admin/sqlite-service/content/") || path.startsWith("/admin/sqlite-service/content-inventory/") ||
      path.startsWith("/admin/sqlite-service/revisions/")) && path.split("/")[4] !== this.showId) return adminReply({ error: "target_differs" }, 409);
    if (request.method === "POST") {
      if (!this.ready()) return adminReply({ error: "show_not_ready" }, 503);
    }
    if (path.startsWith("/admin/sqlite-stats/")) return this.statsHttp(request);
    if (path === "/admin/sqlite-schedules" || path.startsWith("/admin/sqlite-schedules/")) return this.scheduleHttp(request);
    return path.startsWith("/admin/sqlite-service/") ? this.serviceHttp(request) : this.publicationHttp(request);
  }
}
