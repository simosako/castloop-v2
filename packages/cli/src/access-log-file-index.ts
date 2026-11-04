import { Database } from "bun:sqlite";
import { assertRealParentDirectories, localJournalEntryExists, syncLocalJournalDirectory } from "./local-journal-path";
import { protectLocalState } from "./workspace-protection";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

export type AccessLogFileRange = { minOccurredAtMs: number | null; maxOccurredAtMs: number | null };

export class AccessLogFileIndex {
  private readonly database: Database;

  constructor(root: string) {
    protectLocalState(root);
    const directory = join(root, ".castloop");
    if (!localJournalEntryExists(directory)) {
      mkdirSync(directory, { mode: 0o700 });
      syncLocalJournalDirectory(root);
    }
    if (!lstatSync(directory).isDirectory()) throw new Error("Access log index directory must be a real directory");
    const path = join(directory, "access-log-files.sqlite");
    assertRealParentDirectories(path, "Access log index");
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Access log index must be a regular file");
    } finally { closeSync(fd); }
    this.database = new Database(path, { create: false, strict: true });
    try {
      this.database.transaction(() => {
        this.database.exec(`CREATE TABLE IF NOT EXISTS access_log_files_schema (
          id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)`);
        const schema = this.database.query<{ version: number }, []>("SELECT version FROM access_log_files_schema WHERE id = 1").get();
        if (schema && schema.version !== 1) throw new Error("Unsupported access log file index schema");
        this.database.exec("INSERT OR IGNORE INTO access_log_files_schema (id, version) VALUES (1, 1)");
        this.database.exec(`CREATE TABLE IF NOT EXISTS access_log_files (
          account_id TEXT NOT NULL, bucket_name TEXT NOT NULL, object_key TEXT NOT NULL, etag TEXT NOT NULL,
          min_occurred_at_ms INTEGER, max_occurred_at_ms INTEGER,
          CHECK ((min_occurred_at_ms IS NULL AND max_occurred_at_ms IS NULL) OR
            (min_occurred_at_ms IS NOT NULL AND max_occurred_at_ms IS NOT NULL AND
             min_occurred_at_ms >= 0 AND max_occurred_at_ms >= min_occurred_at_ms)),
          PRIMARY KEY (account_id, bucket_name, object_key)
        ) WITHOUT ROWID`);
      })();
      syncLocalJournalDirectory(directory);
    } catch (error) { this.database.close(); throw error; }
  }

  get(location: { accountId: string; bucketName: string }, file: { key: string; etag: string }): AccessLogFileRange | null {
    return this.database.query<AccessLogFileRange, [string, string, string, string]>(
      `SELECT min_occurred_at_ms AS minOccurredAtMs, max_occurred_at_ms AS maxOccurredAtMs
       FROM access_log_files WHERE account_id = ? AND bucket_name = ? AND object_key = ? AND etag = ?`)
      .get(location.accountId, location.bucketName, file.key, file.etag);
  }

  put(location: { accountId: string; bucketName: string }, file: { key: string; etag: string }, range: AccessLogFileRange): void {
    this.database.query(`INSERT INTO access_log_files
      (account_id, bucket_name, object_key, etag, min_occurred_at_ms, max_occurred_at_ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, bucket_name, object_key) DO UPDATE SET etag = excluded.etag,
      min_occurred_at_ms = excluded.min_occurred_at_ms, max_occurred_at_ms = excluded.max_occurred_at_ms`)
      .run(location.accountId, location.bucketName, file.key, file.etag, range.minOccurredAtMs, range.maxOccurredAtMs);
  }

  close(): void { this.database.close(); }
}
