import { parseSqliteDomainRequest, requireSqliteDomainConnection, sqliteDomainCommitSchema,
  sqliteDomainRequestHash, sqliteDomainRequestSchema, sqliteDomainStatusSchema } from "../packages/shared/src/sqlite-domain";
import type { SqliteDomainCommit, SqliteDomainRequest, SqliteDomainStatus } from "../packages/shared/src/sqlite-domain";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { sqliteServiceConfigHash } from "../packages/shared/src/sqlite-service";
import type { SqlitePublicationRuntime } from "../packages/shared/src/sqlite-publication";
import type { PublicationQueueStorage, SqlitePublicationQueue } from "./sqlite-publication-queue";
import type { SqlitePublicationContent } from "./sqlite-publication-content";
import type { SqliteRuntimeCache } from "./sqlite-service-runtime";

type DomainRow = { operation_id: string; request_json: string; request_sha256: string; commit_json: string | null;
  state: "prepared" | "completed" };

export function initializeSqliteDomains(storage: PublicationQueueStorage): void {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_domain_changes (operation_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL, request_sha256 TEXT NOT NULL, commit_json TEXT,
    state TEXT NOT NULL CHECK(state IN ('prepared', 'completed')))`);
  storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS publication_one_domain_change ON publication_domain_changes ((1)) WHERE state != 'completed'");
}

export function pendingSqliteDomain(storage: PublicationQueueStorage): boolean {
  return storage.sql.exec("SELECT operation_id FROM publication_domain_changes WHERE state != 'completed'").toArray().length !== 0;
}

export class SqliteDomainRuntime {
  constructor(private readonly storage: PublicationQueueStorage, readonly queue: SqlitePublicationQueue,
    private readonly content: SqlitePublicationContent, private readonly config: SqliteServiceConfig,
    private readonly cache: SqliteRuntimeCache, private readonly actual: SqlitePublicationRuntime, readonly showId?: string) {
    initializeSqliteDomains(storage);
  }
  private row(id: string): DomainRow {
    sqliteDomainRequestSchema.shape.operation_id.parse(id);
    const row = this.storage.sql.exec<DomainRow>("SELECT * FROM publication_domain_changes WHERE operation_id = ?", id).toArray()[0];
    if (!row) throw new Error("Domain change is missing");
    return row;
  }
  async status(id: string): Promise<SqliteDomainStatus> {
    const row = this.row(id), request = await parseSqliteDomainRequest(JSON.parse(row.request_json));
    if (await sqliteDomainRequestHash(request) !== row.request_sha256) throw new Error("Stored domain request differs");
    return sqliteDomainStatusSchema.parse({ request, request_sha256: row.request_sha256, phase: row.state,
      commit: row.commit_json ? sqliteDomainCommitSchema.parse(JSON.parse(row.commit_json)) : null,
      ...(this.showId ? { show_id: this.showId } : {}) });
  }
  async prepare(input: SqliteDomainRequest, suspendSchedules?: () => void): Promise<SqliteDomainStatus> {
    const request = await parseSqliteDomainRequest(input), digest = await sqliteDomainRequestHash(request);
    if (this.storage.sql.exec("SELECT operation_id FROM publication_domain_changes WHERE operation_id = ?", request.operation_id).toArray().length) {
      return this.status(request.operation_id);
    }
    this.storage.transactionSync(() => {
      const identity = this.queue.identity();
      if (pendingSqliteDomain(this.storage) || identity.service_id !== request.previous_config.service_id ||
        identity.service_config_sha256 !== request.previous_config_sha256) throw new Error("Domain preparation requires the exact current configuration");
      suspendSchedules?.();
      this.storage.sql.exec(`INSERT INTO publication_domain_changes (operation_id, request_json, request_sha256, state)
        VALUES (?, ?, ?, 'prepared')`, request.operation_id, JSON.stringify(request), digest);
    });
    await this.storage.sync();
    return this.status(request.operation_id);
  }
  async commit(input: SqliteDomainCommit): Promise<SqliteDomainStatus> {
    const commit = sqliteDomainCommitSchema.parse(input), row = this.row(commit.operation_id);
    if (row.commit_json) {
      if (row.commit_json !== JSON.stringify(commit)) throw new Error("Keep the frozen domain commit receipt");
      return this.status(commit.operation_id);
    }
    const status = await this.status(commit.operation_id), request = status.request;
    requireSqliteDomainConnection(commit.connection, request);
    if (commit.request_sha256 !== row.request_sha256) throw new Error("Domain commit differs from its prepared request");
    if (await sqliteServiceConfigHash(this.config) !== request.target_config_sha256) throw new Error("Domain commit requires its deployed target configuration");
    const identity = this.queue.identity();
    if (identity.service_id !== request.previous_config.service_id || identity.service_config_sha256 !== request.previous_config_sha256) {
      throw new Error("Domain commit differs from its prepared configuration");
    }
    if (this.showId) await this.cache.purge(this.showId);
    await this.queue.changeConfiguration(this.actual, () => {
      if (this.row(request.operation_id).state !== "prepared") throw new Error("Domain commit already started");
      if (this.showId) {
        const generation = this.content.nextFeedGeneration(this.showId);
        this.storage.sql.exec("UPDATE publication_shows SET feed_generation = ? WHERE show_id = ? AND lifecycle = 'published'",
          generation, this.showId);
      }
      this.storage.sql.exec("UPDATE publication_domain_changes SET state = 'completed', commit_json = ? WHERE operation_id = ?",
        JSON.stringify(commit), request.operation_id);
    });
    return this.status(request.operation_id);
  }
}
