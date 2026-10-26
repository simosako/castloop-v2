import { parseSqliteDomainRequest, requireSqliteDomainConnection, sqliteDomainActivationSchema,
  sqliteDomainRequestHash, sqliteDomainRequestSchema, sqliteDomainStatusSchema } from "../packages/shared/src/sqlite-domain";
import type { SqliteDomainActivation, SqliteDomainRequest, SqliteDomainStatus } from "../packages/shared/src/sqlite-domain";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { sqliteServiceConfigHash, sqliteServiceConfigSchema } from "../packages/shared/src/sqlite-service";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import type { PublicationQueueStorage, SqlitePublicationQueue } from "./sqlite-publication-queue";
import type { SqlitePublicationContent } from "./sqlite-publication-content";
import type { SqlitePublicationBucket } from "./sqlite-publication-executor";
import { persistSqliteFeedSnapshot, verifyCover } from "./sqlite-publication-executor";
import type { SqliteRuntimeCache } from "./sqlite-service-runtime";
import { publicationChecksum, renderPublicationFeed } from "./publication-inputs";
import { reserveSqliteFeedGeneration } from "./sqlite-feed-generations";

type DomainRow = { operation_id: string; request_json: string; request_sha256: string; activation_json: string | null; continuation_ready: number;
  state: SqliteDomainStatus["phase"]; snapshot_sha256: string; feed_generation: number | null; reason_code: string | null };

export function initializeSqliteDomains(storage: PublicationQueueStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_domain_changes (operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL, request_sha256 TEXT NOT NULL, activation_json TEXT,
    state TEXT NOT NULL CHECK(state IN ('prepared', 'activated', 'running', 'feed_ready', 'completed', 'blocked')),
     snapshot_sha256 TEXT NOT NULL, feed_generation INTEGER, reason_code TEXT, continuation_ready INTEGER NOT NULL DEFAULT 0)`);
  storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS publication_one_domain_change ON publication_domain_changes ((1)) WHERE state != 'completed'");
}
export function pendingSqliteDomain(storage: PublicationQueueStorage): boolean {
  return storage.sql.exec("SELECT operation_id FROM publication_domain_changes WHERE state != 'completed'").toArray().length !== 0;
}
export function selectPreparedDomainRuntime(storage: PublicationQueueStorage, saved: SqlitePublicationRuntime,
  actual: SqlitePublicationRuntime): boolean {
  const row = storage.sql.exec<DomainRow>("SELECT * FROM publication_domain_changes WHERE state = 'prepared'").toArray()[0];
  if (!row) return false;
  const request = sqliteDomainRequestSchema.parse(JSON.parse(row.request_json));
  const service = storage.sql.exec<{ state: string }>("SELECT state FROM publication_service WHERE id = 1").toArray()[0];
  const unfinished = storage.sql.exec("SELECT job_id FROM publication_jobs WHERE state IN ('queued', 'running', 'blocked') LIMIT 1").toArray();
  return JSON.stringify(saved) === JSON.stringify(request.previous_runtime) && actual.service_id === saved.service_id &&
    actual.service_config_sha256 === request.target_config_sha256 && actual.worker_version_id !== saved.worker_version_id &&
    service?.state === "paused" && !unfinished.length;
}

export class SqliteDomainRuntime {
  private executing = false;
  constructor(private readonly storage: PublicationQueueStorage, private readonly queue: SqlitePublicationQueue,
    private readonly content: SqlitePublicationContent, private readonly bucket: SqlitePublicationBucket,
    private readonly config: SqliteServiceConfig, private readonly cache: SqliteRuntimeCache,
    private readonly actual: SqlitePublicationRuntime, private readonly ready: () => boolean, readonly showId?: string) {
    initializeSqliteDomains(storage);
  }
  private row(id: string): DomainRow {
    sqliteDomainRequestSchema.shape.operation_id.parse(id);
    const row = this.storage.sql.exec<DomainRow>("SELECT * FROM publication_domain_changes WHERE operation_id = ?", id).toArray()[0];
    if (!row) throw new Error("Domain change is missing");
    return row;
  }
  private snapshot(): string { return JSON.stringify(this.showId ? this.content.domainSnapshot(this.showId) : null); }
  async status(id: string): Promise<SqliteDomainStatus> {
    const row = this.row(id), request = await parseSqliteDomainRequest(JSON.parse(row.request_json));
    if (await sqliteDomainRequestHash(request) !== row.request_sha256) throw new Error("Stored domain request differs");
    const snapshot = this.queue.snapshot();
    if (row.state !== "completed" && (snapshot.state !== "paused" || !snapshot.drained)) throw new Error("Domain change requires retained paused maintenance");
    return sqliteDomainStatusSchema.parse({ request, request_sha256: row.request_sha256, actual_runtime: this.actual,
      saved_runtime: this.queue.identity(), phase: row.state, feed_generation: row.feed_generation,
      activation: row.activation_json ? JSON.parse(row.activation_json) : null, paused: snapshot.state === "paused", drained: snapshot.drained, reason_code: row.reason_code,
      ...(this.showId ? { show_id: this.showId } : {}) });
  }
  async prepare(input: SqliteDomainRequest, bindMaintenance: () => void): Promise<SqliteDomainStatus> {
    const request = await parseSqliteDomainRequest(input), digest = await sqliteDomainRequestHash(request);
    const snapshot = this.snapshot(), snapshotHash = await publicationChecksum(new TextEncoder().encode(snapshot));
    if (this.showId) {
      const target = this.content.domainSnapshot(this.showId);
      if (target.metadata && target.cover) renderPublicationFeed(target.metadata, target.episodes, request.target_config.public_base_url, target.cover.extension);
    }
    this.storage.transactionSync(() => {
      const queue = this.queue.snapshot();
      if (!this.ready() || JSON.stringify(this.queue.identity()) !== JSON.stringify(request.previous_runtime) ||
        JSON.stringify(this.actual) !== JSON.stringify(request.previous_runtime) ||
        JSON.stringify(sqliteServiceConfigSchema.parse(this.config)) !== JSON.stringify(request.previous_config) || queue.state !== "paused" || !queue.drained ||
        this.snapshot() !== snapshot || pendingSqliteDomain(this.storage)) throw new Error("Domain preparation requires exact ready paused maintenance");
      bindMaintenance();
      const target = this.showId ? this.content.domainSnapshot(this.showId) : null;
      const generation = target?.metadata ? reserveSqliteFeedGeneration(this.storage,
        { kind: "domain", id: request.operation_id, showId: this.showId!, requestSha256: digest }) : null;
      this.storage.sql.exec(`INSERT INTO publication_domain_changes (operation_id, request_json, request_sha256,
        state, snapshot_sha256, feed_generation) VALUES (?, ?, ?, 'prepared', ?, ?)`,
      request.operation_id, JSON.stringify(request), digest, snapshotHash, generation);
    });
    await this.storage.sync();
    return this.status(request.operation_id);
  }
  async activate(input: SqliteDomainActivation): Promise<SqliteDomainStatus> {
    const activation = sqliteDomainActivationSchema.parse(input), status = await this.status(activation.operation_id);
    const request = status.request;
    requireSqliteDomainConnection(activation.connection, request);
    if (status.phase !== "prepared" || status.activation || activation.request_sha256 !== status.request_sha256 ||
      activation.worker_version_id !== this.actual.worker_version_id || activation.worker_version_id === request.previous_runtime.worker_version_id ||
      this.actual.service_config_sha256 !== request.target_config_sha256 ||
      await sqliteServiceConfigHash(this.config) !== request.target_config_sha256) throw new Error("Domain activation differs or was already requested");
    await this.queue.changeConfiguration(this.actual, request.previous_runtime, () => {
      if (this.row(request.operation_id).state !== "prepared") throw new Error("Domain activation already started");
      this.storage.sql.exec("UPDATE publication_domain_changes SET state = 'activated', activation_json = ? WHERE operation_id = ?",
        JSON.stringify(activation), request.operation_id);
    });
    return this.status(request.operation_id);
  }
  async alarm(): Promise<boolean> {
    const row = this.storage.sql.exec<DomainRow>("SELECT * FROM publication_domain_changes WHERE state != 'completed'").toArray()[0];
    if (!row) return false;
    if (this.executing || ["prepared", "feed_ready", "blocked"].includes(row.state)) return true;
    if (row.state === "running" && row.continuation_ready !== 1) { this.block(row.operation_id, "execution_interrupted"); await this.storage.sync(); return true; }
    this.executing = true;
    try {
      this.storage.sql.exec("UPDATE publication_domain_changes SET state = 'running', continuation_ready = 0 WHERE operation_id = ?", row.operation_id);
      await this.storage.sync();
      const status = await this.status(row.operation_id);
      if (!status.activation ||
        status.saved_runtime.worker_version_id !== status.activation.worker_version_id ||
        status.saved_runtime.service_config_sha256 !== status.request.target_config_sha256) throw new Error("Domain execution evidence differs");
      const retained = this.content.sites.build(row.operation_id);
      if (retained) {
        if (retained.show_id !== this.showId || retained.generation !== row.feed_generation) throw new Error("Retained domain site identity differs");
        if (!await this.content.sites.batch(row.operation_id, this.bucket)) {
          await this.continueAfterBatch(row.operation_id); return true;
        }
      }
      const snapshot = this.snapshot();
      if (await publicationChecksum(new TextEncoder().encode(snapshot)) !== row.snapshot_sha256) throw new Error("Domain content snapshot differs");
      if (this.showId) {
        const target = this.content.domainSnapshot(this.showId);
        if (target.metadata && target.cover && row.feed_generation !== null) {
          if (!this.content.sites.build(row.operation_id)) {
            const metadata = target.metadata;
            this.content.sites.prepare(row.operation_id, row.feed_generation, this.showId,
              metadata.site_mode === "builtin" ? { origin: this.config.public_base_url, coverExtension: target.cover.extension,
                show: { show_id: metadata.show_id, title: metadata.title, description: metadata.description,
                  language: metadata.language, author: metadata.author,
                  ...(metadata.site_css !== undefined ? { site_css: metadata.site_css } : {}),
                  ...(metadata.copyright ? { copyright: metadata.copyright } : {}) } } : null,
              target.episodes);
          }
          if (!await this.content.sites.batch(row.operation_id, this.bucket)) {
            await this.continueAfterBatch(row.operation_id); return true;
          }
          await verifyCover(this.bucket, this.showId, target.cover.extension, target.cover);
          const feed = renderPublicationFeed(target.metadata, target.episodes, this.config.public_base_url, target.cover.extension);
          await persistSqliteFeedSnapshot(this.bucket, this.showId, row.feed_generation, feed);
          await this.cache.purge(this.showId, (entrypoint) => this.content.sites.confirmPurge(row.operation_id, entrypoint));
        } else if (row.feed_generation !== null || target.metadata) throw new Error("Domain Feed reservation differs");
      }
      await this.storage.transaction(async () => {
        if (this.row(row.operation_id).state !== "running" || this.snapshot() !== snapshot) throw new Error("Domain execution changed before commit");
        if (this.showId && row.feed_generation !== null) {
          this.content.commitDomainFeed(this.showId, snapshot, row.feed_generation);
          this.content.sites.commit(row.operation_id);
        }
        this.storage.sql.exec("UPDATE publication_domain_changes SET state = 'feed_ready' WHERE operation_id = ?", row.operation_id);
        this.storage.sql.exec("UPDATE publication_runtime_setup SET operation_id = ?, state = 'scheduled', request_json = ? WHERE id = 1",
          row.operation_id, JSON.stringify({ ...this.actual, operation_id: row.operation_id }));
        await this.storage.setAlarm(Date.now());
      });
    } catch {
      this.block(row.operation_id, "domain_effect_unverified"); await this.storage.sync();
      console.error(JSON.stringify({ event: "sqlite_domain_change", operation_id: row.operation_id, reason_code: "domain_effect_unverified" }));
    } finally { this.executing = false; }
    return true;
  }
  private async continueAfterBatch(id: string): Promise<void> {
    await this.storage.transaction(async () => {
      this.storage.sql.exec("UPDATE publication_domain_changes SET continuation_ready = 1 WHERE operation_id = ? AND state = 'running'", id);
      await this.storage.setAlarm(Date.now());
    });
    await this.storage.sync();
  }
  private block(id: string, reason: "execution_interrupted" | "domain_effect_unverified"): void {
    this.storage.sql.exec("UPDATE publication_domain_changes SET state = 'blocked', reason_code = ? WHERE operation_id = ?", reason, id);
  }
}
