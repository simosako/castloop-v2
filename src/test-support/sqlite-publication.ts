import { Database } from "bun:sqlite";
import type { SqlitePublicationRuntime } from "../../packages/shared/src/sqlite-publication";
import { SqlitePublicationQueue } from "../sqlite-publication-queue";
import type { PublicationQueueStorage } from "../sqlite-publication-queue";

export function sqlitePublicationFixture(options: { path?: string; runtime?: SqlitePublicationRuntime; resume?: boolean } = {}) {
  const database = new Database(options.path ?? ":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  const runtime = options.runtime ?? { service_id: "test-service", worker_version_id: crypto.randomUUID(), service_config_sha256: "a".repeat(64) };
  let alarm: number | null = null;
  let alarmFailures = 0;
  let syncFailures = 0;
  let tail = Promise.resolve();
  const storage: PublicationQueueStorage = {
    sql: { get databaseSize() {
      return Number(database.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count) *
        Number(database.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size);
    }, exec<Row extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>) {
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
    close: () => database.close(),
  };
}
