import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../packages/shared/src/sqlite-service";
import { sqlitePublicationRuntimeSchema } from "../packages/shared/src/sqlite-publication";
import type { PublicCacheProps } from "./public-assets";
import { purgeLifecycleCache, serveCachedLifecycleAsset } from "./lifecycle-cache";
import type { LifecyclePurgeTarget } from "./lifecycle-cache";
import { SqlitePublicationAlarm } from "./sqlite-publication-alarm";
import type { SqlitePublicationExecutor } from "./sqlite-publication-alarm";
import type { PreparedSqlitePublication } from "./sqlite-publication-executor";
import { createSqlitePublicationExecutor } from "./sqlite-publication-executor";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import type { SqliteDeliveryDecision } from "./sqlite-publication-content";
import { createSqlitePublicationHttp } from "./sqlite-publication-http";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import { SqliteServiceRuntime } from "./sqlite-service-runtime";
import type { SqliteCacheRuntime } from "./sqlite-service-runtime";
import { createSqliteServiceHttp } from "./sqlite-service-http";
import { serveSqliteGateway } from "./sqlite-gateway";
import { selectSqliteRuntime } from "./sqlite-runtime-update";

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
  async invalidate(target: LifecyclePurgeTarget): Promise<void> { await purgeLifecycleCache(this.ctx.cache, target); }
}

export class SqlitePublicationService extends DurableObject<SqliteWorkerEnv> {
  private readonly initialized: Promise<void>;
  private runtime!: SqliteServiceRuntime;
  private executor!: SqlitePublicationExecutor<PreparedSqlitePublication>;
  private alarmRuntime!: () => SqliteServiceRuntime;
  private publicationHttp!: (request: Request) => Promise<Response>;
  private serviceHttp!: (request: Request) => Promise<Response>;
  constructor(ctx: DurableObjectState, env: SqliteWorkerEnv) {
    super(ctx, env);
    this.initialized = this.ctx.blockConcurrencyWhile(async () => {
      const config = sqliteServiceConfigSchema.parse(JSON.parse(this.env.CASTLOOP_SQLITE_CONFIG));
      if (config.service_id !== this.env.CASTLOOP_SERVICE_ID || config.public_base_url !== config.workers_dev_base_url || config.workers_dev_base_url !== this.env.CASTLOOP_MANAGEMENT_ORIGIN ||
        !this.ctx.id.equals(this.env.CASTLOOP_SQLITE.idFromName(`service/${config.service_id}`))) throw new Error("SQLite namespace identity differs");
      const identity = sqlitePublicationRuntimeSchema.parse({ service_id: config.service_id,
        worker_version_id: this.env.CASTLOOP_VERSION_METADATA.id, service_config_sha256: await sqliteServiceConfigHash(config) });
      const queue = new SqlitePublicationQueue(this.ctx.storage, selectSqliteRuntime(this.ctx.storage, identity)), content = new SqlitePublicationContent(this.ctx.storage);
      const cache = { describe: () => this.ctx.exports.SqliteCachedAssets.describeRuntime(),
        purge: (showId: string) => this.ctx.exports.SqliteCachedAssets.invalidate({ showId }) };
      this.alarmRuntime = () => new SqliteServiceRuntime(this.ctx.storage, queue, content, this.env.CASTLOOP_BUCKET, config, cache, identity);
      this.runtime = this.alarmRuntime();
      this.executor = createSqlitePublicationExecutor(content, this.env.CASTLOOP_BUCKET, config,
        { purge: ({ showId, episodeId }) => this.ctx.exports.SqliteCachedAssets.invalidate({ showId, ...(episodeId ? { episodeId } : {}) }) });
      this.publicationHttp = createSqlitePublicationHttp(queue, this.env.CASTLOOP_ADMIN_KEY, () => this.runtime.ready());
      this.serviceHttp = createSqliteServiceHttp(this.runtime, this.env.CASTLOOP_ADMIN_KEY);
    });
  }
  async fetch(request: Request): Promise<Response> {
    await this.initialized;
    return new URL(request.url).pathname.startsWith("/admin/sqlite-service/") ? this.serviceHttp(request) : this.publicationHttp(request);
  }
  async delivery(path: string): Promise<SqliteDeliveryDecision> {
    await this.initialized;
    return this.runtime.ready() ? this.runtime.content.delivery(path) : { status: 503 };
  }
  async alarm(): Promise<void> {
    await this.initialized;
    const runtime = this.alarmRuntime();
    if (!await runtime.alarm()) await new SqlitePublicationAlarm(runtime.queue, this.executor).alarm();
  }
}

export default {
  async fetch(request: Request, env: SqliteWorkerEnv, ctx: ExecutionContext): Promise<Response> {
    return serveSqliteGateway(request, env.CASTLOOP_MANAGEMENT_ORIGIN,
      env.CASTLOOP_SQLITE.getByName(`service/${env.CASTLOOP_SERVICE_ID}`),
      (input, props) => ctx.exports.SqliteCachedAssets({ props }).fetch(input));
  },
} satisfies ExportedHandler<SqliteWorkerEnv>;
