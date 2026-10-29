import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../packages/shared/src/sqlite-service";
import { sqlitePublicationRuntimeSchema } from "../packages/shared/src/sqlite-publication";
import type { PublicCacheProps } from "./public-assets";
import { serveCachedLifecycleAsset } from "./lifecycle-cache";
import type { LifecyclePurgeTarget } from "./lifecycle-cache";
import { purgeSqliteCache } from "./sqlite-cache-purge";
import { serveSiteGateway } from "./site-gateway";
import { serveCachedSitePage } from "./site-cache";
import type { SiteCacheProps } from "./site-cache";
import { purgeSitePages } from "./site-storage";
import type { SitePurgeTarget } from "./site-storage";
import { parseSitePagePath } from "../packages/shared/src/website";
import type { SitePage } from "../packages/shared/src/website";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import type { SqliteDeliveryDecision } from "./sqlite-publication-content";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { SqliteServiceRuntime } from "./sqlite-service-runtime";
import type { SqliteCachePurgeConfirmation } from "./sqlite-service-runtime";
import { serveSqliteGateway } from "./sqlite-gateway";
import { resolveSqliteRuntime } from "./sqlite-runtime-identity";
import { SqliteShowService } from "./sqlite-show-service";
import type { ShowRegistration } from "./sqlite-show-service";
import type { SqliteDeliveryObservation } from "../packages/shared/src/sqlite-stats";
import { SqliteServiceControl } from "./sqlite-service-control";
import { createSqliteControlHttp } from "./sqlite-control-http";
import { sqliteRegistrationSchema } from "../packages/shared/src/sqlite-service-api";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import type { SqliteCatalogRequest } from "../packages/shared/src/sqlite-catalog";
import { sqliteRequestObjectName, sqliteShowObjectName } from "./sqlite-show-routing";
import type { SqliteDomainCommit, SqliteDomainRequest } from "../packages/shared/src/sqlite-domain";

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
  fetch(request: Request): Promise<Response> {
    return serveCachedLifecycleAsset(request, {
      CASTLOOP_BUCKET: this.env.CASTLOOP_BUCKET,
      renderFeed: (showId, props) =>
        this.env.CASTLOOP_SQLITE.getByName(sqliteShowObjectName(this.env.CASTLOOP_SERVICE_ID, showId)).renderFeed(props),
    }, this.ctx.props);
  }
  async invalidate(target: LifecyclePurgeTarget): Promise<void> { await purgeSqliteCache(this.ctx.cache, target); }
}

export class SiteCachedPages extends WorkerEntrypoint<SqliteWorkerEnv, SiteCacheProps> {
  fetch(request: Request): Promise<Response> {
    return serveCachedSitePage(request,
      (page, props) => this.env.CASTLOOP_SQLITE.getByName(sqliteShowObjectName(this.env.CASTLOOP_SERVICE_ID, page.showId)).renderSitePage(page, props),
      this.ctx.props);
  }
  async invalidate(target: SitePurgeTarget): Promise<void> {
    if (!this.ctx.cache) throw new Error("Site cache is unavailable");
    await purgeSitePages(this.ctx.cache, target);
  }
}

export class SqlitePublicationService extends DurableObject<SqliteWorkerEnv> {
  private readonly initialized: Promise<void>;
  private runtime!: SqliteServiceRuntime;
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
      const queue = new SqlitePublicationQueue(this.ctx.storage, resolveSqliteRuntime(this.ctx.storage, identity)), content = new SqlitePublicationContent(this.ctx.storage);
      const cache = { purge: (showId: string, confirmed?: SqliteCachePurgeConfirmation) => this.purgeCaches(showId, confirmed) };
      this.runtime = new SqliteServiceRuntime(this.ctx.storage, queue, content, config, cache, identity);
      this.control = new SqliteServiceControl(this.ctx.storage, this.runtime, (showId) => {
        const stub = this.env.CASTLOOP_SQLITE.getByName(sqliteShowObjectName(config.service_id, showId));
        return { initialize: (request) => stub.initializeShow(request), health: () => stub.showHealth(),
          catalog: (request) => stub.showCatalog(request),
          prepareDomain: (request) => stub.prepareShowDomain(request), commitDomain: (request) => stub.commitShowDomain(request),
          domainStatus: (id) => stub.showDomainStatus(id) };
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
  async renderFeed(props?: PublicCacheProps) {
    await this.initialized;
    return this.show ? this.show.renderFeed(props) : null;
  }
  async renderSitePage(page: SitePage, props?: SiteCacheProps) {
    await this.initialized;
    return this.show ? this.show.renderSitePage(page, props) : null;
  }
  async recordDeliveryStats(observations: SqliteDeliveryObservation[]): Promise<void> {
    await this.initialized;
    if (!this.show) throw new Error("Show is not initialized");
    this.show.stats.record(observations);
  }
  private async purgeCaches(showId: string, confirmed?: SqliteCachePurgeConfirmation): Promise<void> {
    await this.ctx.exports.SqliteCachedAssets.invalidate({ showId });
    confirmed?.("media");
    await this.ctx.exports.SiteCachedPages.invalidate({ showId });
    confirmed?.("site");
  }
  async alarm(): Promise<void> {
    await this.initialized;
    if (this.show) {
      await this.show.schedules.dispatchDue();
      await this.show.schedules.scheduleNext();
    }
  }
  private openShow(showId: string): SqliteShowService {
    sqliteRegistrationSchema.shape.show_id.parse(showId);
    if (!this.ctx.id.equals(this.env.CASTLOOP_SQLITE.idFromName(sqliteShowObjectName(this.config.service_id, showId)))) throw new Error("Show namespace identity differs");
    if (this.show) { if (this.show.showId !== showId) throw new Error("Show scope differs"); return this.show; }
    this.show = new SqliteShowService(this.ctx.storage, showId, this.identity, this.config, {
      purge: (id, confirmed) => this.purgeCaches(id, confirmed),
      purgeMedia: ({ showId: id, episodeId }) => this.ctx.exports.SqliteCachedAssets.invalidate({ showId: id, ...(episodeId ? { episodeId } : {}) }),
      purgeSite: (target) => this.ctx.exports.SiteCachedPages.invalidate(target),
    }, this.env.CASTLOOP_ADMIN_KEY);
    return this.show;
  }
  async initializeShow(request: ShowRegistration) { await this.initialized; return this.openShow(request.show_id).initialize(request); }
  async showHealth() { await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.health(); }
  async showCatalog(request: SqliteCatalogRequest) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.runtime.catalog(request);
  }
  async prepareShowDomain(request: SqliteDomainRequest) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.prepareDomain(request);
  }
  async commitShowDomain(request: SqliteDomainCommit) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.commitDomain(request);
  }
  async showDomainStatus(id: string) {
    await this.initialized; if (!this.show) throw new Error("Show is not initialized"); return this.show.domainStatus(id);
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
};
