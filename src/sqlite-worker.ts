import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../packages/shared/src/sqlite-service";
import { sqlitePublicationRuntimeSchema } from "../packages/shared/src/sqlite-publication";
import type { PublicCacheProps } from "./public-assets";
import { serveCachedLifecycleAsset } from "./lifecycle-cache";
import type { LifecyclePurgeTarget } from "./lifecycle-cache";
import { purgeSqliteCache } from "./sqlite-cache-purge";
import { SqlitePublicationAlarm } from "./sqlite-publication-alarm";
import type { SqlitePublicationExecutor } from "./sqlite-publication-alarm";
import { withSitePublication } from "./site-publication";
import type { SitePublication } from "./site-publication";
import { serveSiteGateway } from "./site-gateway";
import { serveCachedSitePage } from "./site-cache";
import type { SiteCacheProps } from "./site-cache";
import { purgeSitePages } from "./site-storage";
import type { SitePurgeTarget } from "./site-storage";
import { parseSitePagePath } from "../packages/shared/src/website";
import type { SitePage } from "../packages/shared/src/website";
import { createSqlitePublicationExecutor } from "./sqlite-publication-executor";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import type { SqliteDeliveryDecision } from "./sqlite-publication-content";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { SqliteServiceRuntime } from "./sqlite-service-runtime";
import type { SqliteCachePurgeConfirmation, SqliteCacheRuntime } from "./sqlite-service-runtime";
import { serveSqliteGateway } from "./sqlite-gateway";
import { selectSqliteRuntime } from "./sqlite-runtime-update";
import { SqliteShowService } from "./sqlite-show-service";
import type { ShowRegistration } from "./sqlite-show-service";
import type { SqliteDeliveryObservation } from "../packages/shared/src/sqlite-stats";
import { SqliteServiceControl } from "./sqlite-service-control";
import { createSqliteControlHttp } from "./sqlite-control-http";
import { sqliteRegistrationSchema } from "../packages/shared/src/sqlite-service-api";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import type { SqliteCatalogRequest } from "../packages/shared/src/sqlite-catalog";
import type { SqliteUpdateActivate, SqliteUpdatePrepare } from "../packages/shared/src/sqlite-runtime-update";
import { sqliteRequestObjectName, sqliteShowObjectName } from "./sqlite-show-routing";
import type { SqliteDomainRequest, SqliteDomainActivation } from "../packages/shared/src/sqlite-domain";

declare global {
  namespace Cloudflare {
    interface GlobalProps { mainModule: typeof import("./sqlite-worker"); }
  }
}

export type SqliteWorkerEnv = { CASTLOOP_BUCKET: R2Bucket; CASTLOOP_ADMIN_KEY: string;
  CASTLOOP_VERSION_METADATA: WorkerVersionMetadata; CASTLOOP_SQLITE_CONFIG: string;
  CASTLOOP_SERVICE_ID: string; CASTLOOP_MANAGEMENT_ORIGIN: string;
  CASTLOOP_SQLITE: DurableObjectNamespace<SqlitePublicationService> };

export class SqliteCachedAssets extends WorkerEntrypoint<SqliteWorkerEnv, PublicCacheProps> {
  fetch(request: Request): Promise<Response> { return serveCachedLifecycleAsset(request, this.env, this.ctx.props); }
  async describeRuntime(): Promise<SqliteCacheRuntime> {
    return { worker_version_id: this.env.CASTLOOP_VERSION_METADATA.id,
      service_config_sha256: await sqliteServiceConfigHash(sqliteServiceConfigSchema.parse(JSON.parse(this.env.CASTLOOP_SQLITE_CONFIG))),
      cache_enabled: this.ctx.cache !== undefined };
  }
  async invalidate(target: LifecyclePurgeTarget): Promise<void> { await purgeSqliteCache(this.ctx.cache, target); }
}

export class SiteCachedPages extends WorkerEntrypoint<SqliteWorkerEnv, SiteCacheProps> {
  fetch(request: Request): Promise<Response> { return serveCachedSitePage(request, this.env.CASTLOOP_BUCKET, this.ctx.props); }
  async describeRuntime(): Promise<SqliteCacheRuntime> {
    return { worker_version_id: this.env.CASTLOOP_VERSION_METADATA.id,
      service_config_sha256: await sqliteServiceConfigHash(sqliteServiceConfigSchema.parse(JSON.parse(this.env.CASTLOOP_SQLITE_CONFIG))),
      cache_enabled: this.ctx.cache !== undefined };
  }
  async invalidate(target: SitePurgeTarget): Promise<void> {
    if (!this.ctx.cache) throw new Error("Site cache is unavailable");
    await purgeSitePages(this.ctx.cache, target);
  }
}

export class SqlitePublicationService extends DurableObject<SqliteWorkerEnv> {
  private readonly initialized: Promise<void>;
  private runtime!: SqliteServiceRuntime;
  private executor!: SqlitePublicationExecutor<SitePublication>;
  private alarmRuntime!: () => SqliteServiceRuntime;
  private serviceHttp!: (request: Request) => Promise<Response>;
  private control?: SqliteServiceControl;
  private show?: SqliteShowService;
  private config!: SqliteServiceConfig;
  private identity!: SqlitePublicationRuntime;
  constructor(ctx: DurableObjectState, env: SqliteWorkerEnv) {
    super(ctx, env);
    this.initialized = this.ctx.blockConcurrencyWhile(async () => {
      const config = sqliteServiceConfigSchema.parse(JSON.parse(this.env.CASTLOOP_SQLITE_CONFIG));
      if (config.service_id !== this.env.CASTLOOP_SERVICE_ID || config.workers_dev_base_url !== this.env.CASTLOOP_MANAGEMENT_ORIGIN ||
        config.storage_layout !== "show-v1") throw new Error("SQLite namespace identity differs");
      const identity = sqlitePublicationRuntimeSchema.parse({ service_id: config.service_id,
        worker_version_id: this.env.CASTLOOP_VERSION_METADATA.id, service_config_sha256: await sqliteServiceConfigHash(config) });
      this.config = config; this.identity = identity;
      if (!this.ctx.id.equals(this.env.CASTLOOP_SQLITE.idFromName(`service/${config.service_id}`))) {
        const exists = this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'publication_show_binding'").toArray().length;
        const binding = exists ? this.ctx.storage.sql.exec<{ show_id: string }>("SELECT show_id FROM publication_show_binding WHERE id = 1").toArray()[0] : null;
        if (binding) this.openShow(binding.show_id);
        return;
      }
      if (config.public_base_url !== config.workers_dev_base_url && !this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'publication_service'").toArray().length) throw new Error("Fresh initialization requires workers.dev");
      const queue = new SqlitePublicationQueue(this.ctx.storage, selectSqliteRuntime(this.ctx.storage, identity)), content = new SqlitePublicationContent(this.ctx.storage);
      const cache = { describe: () => this.describeCaches(),
        purge: (showId: string, confirmed?: SqliteCachePurgeConfirmation) => this.purgeCaches(showId, confirmed) };
      this.alarmRuntime = () => new SqliteServiceRuntime(this.ctx.storage, queue, content, this.env.CASTLOOP_BUCKET, config, cache, identity);
      this.runtime = this.alarmRuntime();
      this.control = new SqliteServiceControl(this.ctx.storage, this.runtime, (showId) => {
        const stub = this.env.CASTLOOP_SQLITE.getByName(sqliteShowObjectName(config.service_id, showId));
        return { initialize: (request) => stub.initializeShow(request), health: () => stub.showMaintenanceHealth(),
          catalog: (request) => stub.showCatalog(request),
          prepare: (request) => stub.prepareShowUpdate(request), activate: (request) => stub.activateShowUpdate(request), release: (id) => stub.releaseShowUpdate(id),
          prepareDomain: (request) => stub.prepareShowDomain(request), activateDomain: (request) => stub.activateShowDomain(request),
          domainStatus: (id) => stub.showDomainStatus(id), releaseDomain: (id) => stub.releaseShowDomain(id) };
      });
      this.serviceHttp = createSqliteControlHttp(this.control, this.env.CASTLOOP_ADMIN_KEY);
    });
  }
  async fetch(request: Request): Promise<Response> {
    await this.initialized;
    if (this.show) return this.show.fetch(request);
    if (this.control) return this.serviceHttp(request);
    return new Response(null, { status: 404 });
  }
  async delivery(path: string): Promise<SqliteDeliveryDecision> {
    await this.initialized;
    return this.show ? this.show.delivery(path) : { status: 404 };
  }
  async siteDelivery(page: SitePage) {
    await this.initialized;
    return this.show ? this.show.siteDelivery(page) : { status: 404 as const };
  }
  async recordDeliveryStats(observations: SqliteDeliveryObservation[]): Promise<void> {
    await this.initialized;
    if (!this.show) throw new Error("Show is not initialized");
    this.show.stats.record(observations);
  }
  private async describeCaches(): Promise<SqliteCacheRuntime> {
    const media = await this.ctx.exports.SqliteCachedAssets.describeRuntime();
    const site = await this.ctx.exports.SiteCachedPages.describeRuntime();
    if (media.worker_version_id !== site.worker_version_id || media.service_config_sha256 !== site.service_config_sha256 ||
      !site.cache_enabled) throw new Error("Site cache runtime differs");
    return media;
  }
  private async purgeCaches(showId: string, confirmed?: SqliteCachePurgeConfirmation): Promise<void> {
    await this.ctx.exports.SqliteCachedAssets.invalidate({ showId });
    confirmed?.("media");
    await this.ctx.exports.SiteCachedPages.invalidate({ showId });
    confirmed?.("site");
  }
  async alarm(): Promise<void> {
    await this.initialized;
    if (this.control) {
      await this.runtime.domains.alarm();
      await this.alarmRuntime().alarm();
      await this.control.progress();
    } else if (this.show) {
      await this.show.runtime.domains.alarm();
      if (!await this.show.alarmRuntime().alarm()) {
        await this.show.schedules.dispatchDue();
        await new SqlitePublicationAlarm(this.show.queue, this.executor).alarm();
        await this.show.schedules.scheduleNext();
      }
    }
  }
  private openShow(showId: string): SqliteShowService {
    sqliteRegistrationSchema.shape.show_id.parse(showId);
    if (!this.ctx.id.equals(this.env.CASTLOOP_SQLITE.idFromName(sqliteShowObjectName(this.config.service_id, showId)))) throw new Error("Show namespace identity differs");
    if (this.show) { if (this.show.showId !== showId) throw new Error("Show scope differs"); return this.show; }
    this.show = new SqliteShowService(this.ctx.storage, showId, this.identity, this.config, {
      describe: () => this.describeCaches(), purge: (id, confirmed) => this.purgeCaches(id, confirmed),
    }, this.env.CASTLOOP_BUCKET, this.env.CASTLOOP_ADMIN_KEY);
    this.executor = withSitePublication(createSqlitePublicationExecutor(this.show.content, this.env.CASTLOOP_BUCKET, this.config,
      { purge: ({ showId, episodeId }) => this.ctx.exports.SqliteCachedAssets.invalidate({ showId, ...(episodeId ? { episodeId } : {}) }) }),
      this.show.content, this.env.CASTLOOP_BUCKET, this.config, (target) => this.ctx.exports.SiteCachedPages.invalidate(target));
    return this.show;
  }
  async initializeShow(request: ShowRegistration) { await this.initialized; return this.openShow(request.show_id).initialize(request); }
  async showMaintenanceHealth() { await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.maintenanceHealth(); }
  async showCatalog(request: SqliteCatalogRequest) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.runtime.catalog(request);
  }
  async prepareShowUpdate(request: SqliteUpdatePrepare) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.prepareUpdate(request);
  }
  async activateShowUpdate(request: SqliteUpdateActivate) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.activateUpdate(request);
  }
  async releaseShowUpdate(operationId: string) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.releaseUpdate(operationId);
  }
  async prepareShowDomain(request: SqliteDomainRequest) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.prepareDomain(request);
  }
  async activateShowDomain(request: SqliteDomainActivation) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.activateDomain(request);
  }
  async showDomainStatus(id: string) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.domainStatus(id);
  }
  async releaseShowDomain(id: string) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.releaseDomain(id);
  }
}

export default {
  async fetch(request: Request, env: SqliteWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    let name: string;
    try { name = sqliteRequestObjectName(request, env.CASTLOOP_SERVICE_ID); }
    catch { return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } }); }
    let publicOrigin: string;
    try {
      const config = sqliteServiceConfigSchema.parse(JSON.parse(env.CASTLOOP_SQLITE_CONFIG));
      if (config.service_id !== env.CASTLOOP_SERVICE_ID || config.workers_dev_base_url !== env.CASTLOOP_MANAGEMENT_ORIGIN) throw new Error("Gateway identity differs");
      publicOrigin = config.public_base_url;
    } catch { return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } }); }
    if (parseSitePagePath(new URL(request.url).pathname)) return serveSiteGateway(request, {
      managementOrigin: env.CASTLOOP_MANAGEMENT_ORIGIN, publicOrigin,
      delivery: (page) => env.CASTLOOP_SQLITE.getByName(name).siteDelivery(page),
      cachedFetch: (input, props) => ctx.exports.SiteCachedPages({ props }).fetch(input),
    });
    return serveSqliteGateway(request, env.CASTLOOP_MANAGEMENT_ORIGIN,
      env.CASTLOOP_SQLITE.getByName(name),
      (input, props) => ctx.exports.SqliteCachedAssets({ props }).fetch(input), publicOrigin,
      (observation) => {
        // Statistics recording never blocks the audio response; failures only count as recording errors.
        ctx.waitUntil(env.CASTLOOP_SQLITE.getByName(name).recordDeliveryStats([observation]).catch(() => {
          console.error(JSON.stringify({ event: "sqlite_delivery_stats", show_id: name.startsWith("show/") ? name.split("/")[2] : undefined,
            reason_code: "stats_record_failed" }));
        }));
      });
  },
} satisfies ExportedHandler<SqliteWorkerEnv>;
