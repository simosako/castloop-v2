import { Database } from "bun:sqlite";
import { parseSqlitePublicationRequest, sqliteUploadKey } from "../../packages/shared/src/sqlite-publication";
import type { SqlitePublicationRequest, SqlitePublicationRuntime, SqliteVerifiedUpload } from "../../packages/shared/src/sqlite-publication";
import { SqlitePublicationQueue } from "../sqlite-publication-queue";
import type { PublicationQueueStorage } from "../sqlite-publication-queue";

export function sqlitePublicationFixture(options: { path?: string; runtime?: SqlitePublicationRuntime; resume?: boolean } = {}) {
  const database = new Database(options.path ?? ":memory:", { strict: true });
  const runtime = options.runtime ?? { service_id: "test-service", worker_version_id: crypto.randomUUID(), service_config_sha256: "a".repeat(64) };
  let alarm: number | null = null;
  let alarmFailures = 0;
  let syncFailures = 0;
  let tail = Promise.resolve();
  const storage: PublicationQueueStorage = {
    sql: { exec<Row extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>) {
      const rows = database.query<Row, Array<string | number | null>>(query).all(...bindings);
      return { toArray: () => rows };
    } },
    transactionSync: (callback) => database.transaction(callback)(),
    async transaction<T>(callback: () => Promise<T>): Promise<T> {
      const before = tail;
      let unlock!: () => void;
      tail = new Promise<void>((resolve) => { unlock = resolve; });
      await before;
      const oldAlarm = alarm;
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = await callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        alarm = oldAlarm;
        throw error;
      } finally { unlock(); }
    },
    async getAlarm() { return alarm; },
    async setAlarm(time) {
      if (alarmFailures) { alarmFailures--; throw new Error("Injected alarm scheduling failure"); }
      alarm = time;
    },
    async sync() {
      if (syncFailures) { syncFailures--; throw new Error("Injected durability confirmation failure"); }
    },
  };
  const queue = new SqlitePublicationQueue(storage, runtime, () => 1000);
  const windowId = options.resume === false ? null : crypto.randomUUID();
  if (windowId) queue.resume(windowId);
  return { database, storage, runtime, queue, windowId,
    alarm: () => alarm, clearAlarm: () => { alarm = null; },
    failAlarm: () => { alarmFailures++; }, failSync: () => { syncFailures++; },
    request: (overrides: Partial<SqlitePublicationRequest> = {}) => sqlitePublicationRequest(runtime, windowId!, overrides),
    close: () => database.close(),
  };
}

export function sqlitePublicationRequest(runtime: SqlitePublicationRuntime, windowId: string,
  overrides: Partial<SqlitePublicationRequest> = {}): SqlitePublicationRequest {
  const jobId = overrides.job_id ?? crypto.randomUUID();
  const showId = overrides.show_id ?? "daily";
  const assets = overrides.kind === "show" ? ["show_metadata", "cover_jpg"] as const : ["episode_metadata", "audio"] as const;
  const payloads: SqliteVerifiedUpload[] = assets.map((asset) => {
    const uploadId = crypto.randomUUID();
    return { upload_id: uploadId, asset, key: sqliteUploadKey({ show_id: showId, draft_job_id: jobId, upload_id: uploadId, asset }),
      length_bytes: 100, sha256: "b".repeat(64), etag: "verified-etag", verified: true,
      ...(asset === "audio" ? { duration_seconds: 1 } : {}) };
  });
  return parseSqlitePublicationRequest({ schema_version: 1, protocol: "sqlite-sequential-v1", ...runtime,
    admission_window_id: windowId, request_id: crypto.randomUUID(), job_id: jobId, action: "publish", kind: "episode",
    show_id: showId, episode_id: "first", expected_show_state_version: 0, payloads,
    ...overrides, ...(overrides.kind === "show" ? { episode_id: undefined } : {}) });
}
