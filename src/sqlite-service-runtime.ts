import { episodeDraftFromRevision } from "../packages/shared/src/index";
import { sqliteRuntimeRequestSchema, sqliteHealthSchema, sqliteInspectionSchema } from "../packages/shared/src/sqlite-service-api";
import type { SqliteHealth, SqliteInspection, SqliteRuntimeRequest } from "../packages/shared/src/sqlite-service-api";
import { parseSqliteServiceConfig, sqliteServiceConfigHash } from "../packages/shared/src/sqlite-service";
import type { SqliteServiceConfig } from "../packages/shared/src/sqlite-service";
import { SqlitePublicationQueue } from "./sqlite-publication-queue";
import type { PublicationQueueStorage } from "./sqlite-publication-queue";
import { SqlitePublicationContent } from "./sqlite-publication-content";
import type { SqlitePublicationBucket } from "./sqlite-publication-executor";
import { publicationChecksum } from "./publication-inputs";

type SetupRow = { operation_id: string; state: "scheduled" | "running" | "ready" | "blocked"; request_json: string };
export type SqliteCacheRuntime = { worker_version_id: string; service_config_sha256: string; cache_enabled: boolean };
export type SqliteRuntimeCache = { describe: () => Promise<SqliteCacheRuntime>; purge: (showId: string) => Promise<void> };

export class SqliteServiceRuntime {
  private probing = false;
  constructor(private readonly storage: PublicationQueueStorage, readonly queue: SqlitePublicationQueue,
    readonly content: SqlitePublicationContent, private readonly bucket: SqlitePublicationBucket,
    private readonly config: SqliteServiceConfig, private readonly cache: SqliteRuntimeCache) {
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS publication_runtime_setup (id INTEGER PRIMARY KEY CHECK(id = 1),
      operation_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('scheduled', 'running', 'ready', 'blocked')), request_json TEXT NOT NULL)`);
  }
  private setup(): SetupRow | null {
    return this.storage.sql.exec<SetupRow>("SELECT operation_id, state, request_json FROM publication_runtime_setup WHERE id = 1").toArray()[0] ?? null;
  }
  ready(): boolean { return this.setup()?.state === "ready"; }
  requireTarget(input: SqliteRuntimeRequest): SqliteRuntimeRequest {
    const request = sqliteRuntimeRequestSchema.parse(input), identity = this.queue.identity();
    if (request.service_id !== identity.service_id || request.worker_version_id !== identity.worker_version_id ||
      request.service_config_sha256 !== identity.service_config_sha256) throw new Error("SQLite runtime request has a stale target");
    return request;
  }
  health(): SqliteHealth {
    const snapshot = this.queue.snapshot(), setup = this.setup();
    return sqliteHealthSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", invocation_id: crypto.randomUUID(),
      publication_ready: this.ready(), state: snapshot.state, admission_window_id: snapshot.admission_window_id,
      queued: snapshot.queued, active: snapshot.active?.state ?? null, drained: snapshot.drained,
      setup: setup ? { operation_id: setup.operation_id, state: setup.state } : null });
  }
  async prepare(input: SqliteRuntimeRequest): Promise<SqliteHealth> {
    const request = this.requireTarget(input), source = JSON.stringify(request);
    await this.storage.transaction(async () => {
      const existing = this.setup();
      if (existing) {
        if (existing.request_json !== source) throw new Error("Keep the retained SQLite runtime setup");
        return;
      }
      const snapshot = this.queue.snapshot();
      if (snapshot.state !== "paused" || !snapshot.drained) throw new Error("Runtime preparation requires a drained paused service");
      this.storage.sql.exec("INSERT INTO publication_runtime_setup (id, operation_id, state, request_json) VALUES (1, ?, 'scheduled', ?)", request.operation_id, source);
      await this.storage.setAlarm(Date.now());
    });
    return this.health();
  }
  async alarm(): Promise<boolean> {
    const setup = this.setup();
    if (setup?.state === "ready") return false;
    if (!setup || this.probing) return true;
    if (setup.state === "blocked") return true;
    if (setup.state === "running") {
      this.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'blocked' WHERE id = 1");
      await this.storage.sync();
      console.error(JSON.stringify({ event: "sqlite_runtime_setup", operation_id: setup.operation_id, reason_code: "execution_interrupted" }));
      return true;
    }
    this.probing = true;
    try {
      this.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'running' WHERE id = 1");
      await this.storage.sync();
      try {
        this.requireTarget(JSON.parse(setup.request_json));
        const snapshot = this.queue.snapshot();
        if (snapshot.state !== "paused" || !snapshot.drained) throw new Error("Runtime probe admission changed");
        const object = await this.bucket.get("system/service.toml");
        if (!object?.body || object.size < 1 || object.size > 16384) {
          await object?.body?.cancel(); throw new Error("Runtime config binding probe failed");
        }
        const reader = object.body.getReader(), chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length;
            if (length > 16384) throw new Error("Runtime config probe exceeds its limit"); chunks.push(chunk.value); }
        } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        if (length !== object.size || await sqliteServiceConfigHash(parseSqliteServiceConfig(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))) !==
          await sqliteServiceConfigHash(this.config)) throw new Error("Runtime bucket config differs");
        const cached = await this.cache.describe(), identity = this.queue.identity();
        if (cached.worker_version_id !== identity.worker_version_id || cached.service_config_sha256 !== identity.service_config_sha256 || !cached.cache_enabled) {
          throw new Error("Runtime cache owner differs");
        }
        await this.cache.purge(`probe-${setup.operation_id.slice(0, 8).toLowerCase()}`);
        this.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'ready' WHERE id = 1");
        await this.storage.sync();
      } catch {
        this.storage.sql.exec("UPDATE publication_runtime_setup SET state = 'blocked' WHERE id = 1");
        await this.storage.sync();
        console.error(JSON.stringify({ event: "sqlite_runtime_setup", operation_id: setup.operation_id, reason_code: "runtime_probe_failed" }));
      }
      return true;
    } finally { this.probing = false; }
  }
  async inspect(showId: string, episodeId?: string): Promise<SqliteInspection> {
    if (!this.ready()) throw new Error("SQLite runtime is not ready");
    const snapshot = this.queue.snapshot(), target = this.content.inspect(showId, episodeId);
    const digest = target.base ? await publicationChecksum(new TextEncoder().encode(JSON.stringify(episodeDraftFromRevision(target.base)))) : undefined;
    return sqliteInspectionSchema.parse({ ...this.queue.identity(), protocol: "sqlite-sequential-v1", publication_ready: true,
      state: snapshot.state, admission_window_id: snapshot.admission_window_id, show_id: showId,
      show_lifecycle: target.show?.lifecycle ?? "missing", reservation_id: target.show?.reservation_id ?? null,
      expected_show_state_version: target.show?.state_version ?? null,
      ...(episodeId !== undefined ? { episode_id: episodeId, episode_lifecycle: target.episode?.lifecycle ?? "missing" } : {}),
      ...(target.base ? { base_revision_id: target.base.revision_id, base_metadata_sha256: digest } : {}) });
  }
}
