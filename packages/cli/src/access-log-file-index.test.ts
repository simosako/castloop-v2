import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { stringifyToml } from "@castloop/shared";
import { AccessLogFileIndex } from "./access-log-file-index";
import { createLocalBackup } from "./backup-create";
import { logObject, logTarget } from "./test-support/http-logpush";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace(): string {
  const root = mkdtempSync("/tmp/opencode/castloop-access-index-");
  roots.push(root);
  return root;
}
const file = logObject("2026-11-04/a.gz", "").file;
const range = { minOccurredAtMs: Date.parse("2026-11-03T23:59:59Z"), maxOccurredAtMs: Date.parse("2026-11-04T12:00:00Z") };

test("the local file index persists only file identity and its complete occurrence-time range", () => {
  const root = workspace(), index = new AccessLogFileIndex(root);
  expect(index.get(logTarget, file)).toBeNull();
  index.put(logTarget, file, range);
  index.close();
  const reopened = new AccessLogFileIndex(root);
  try {
    expect(reopened.get(logTarget, file)).toEqual(range);
    expect(reopened.get({ ...logTarget, bucketName: "another-bucket" }, file)).toBeNull();
    expect(reopened.get({ ...logTarget, accountId: "c".repeat(32) }, file)).toBeNull();
    expect(reopened.get(logTarget, { ...file, etag: "changed" })).toBeNull();
  } finally { reopened.close(); }
  const database = new Database(join(root, ".castloop", "access-log-files.sqlite"), { readonly: true });
  try {
    expect(database.query("SELECT * FROM access_log_files").get()).toEqual({ account_id: logTarget.accountId,
      bucket_name: logTarget.bucketName, object_key: file.key, etag: file.etag,
      min_occurred_at_ms: range.minOccurredAtMs, max_occurred_at_ms: range.maxOccurredAtMs });
  } finally { database.close(); }
  expect(statSync(join(root, ".castloop")).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, ".castloop", "access-log-files.sqlite")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(".castloop/\n*.mp3\n");
});

test("empty files and replacement ETags are recorded atomically and a missing index can be recreated", () => {
  const root = workspace(), index = new AccessLogFileIndex(root);
  index.put(logTarget, file, { minOccurredAtMs: null, maxOccurredAtMs: null });
  expect(index.get(logTarget, file)).toEqual({ minOccurredAtMs: null, maxOccurredAtMs: null });
  const changed = { ...file, etag: "a".repeat(32) };
  index.put(logTarget, changed, range);
  expect(index.get(logTarget, changed)).toEqual(range);
  expect(index.get(logTarget, file)).toBeNull();
  index.close();
  unlinkSync(join(root, ".castloop", "access-log-files.sqlite"));
  const recreated = new AccessLogFileIndex(root);
  try { expect(recreated.get(logTarget, changed)).toBeNull(); }
  finally { recreated.close(); }
});

test("index paths preserve the existing real-directory and regular-file protections", () => {
  const root = workspace(), outside = workspace();
  symlinkSync(outside, join(root, ".castloop"));
  expect(() => new AccessLogFileIndex(root)).toThrow("real directory");
  const another = workspace();
  mkdirSync(join(another, ".castloop"));
  writeFileSync(join(outside, "original"), "keep this file");
  symlinkSync(join(outside, "original"), join(another, ".castloop", "access-log-files.sqlite"));
  expect(() => new AccessLogFileIndex(another)).toThrow();
  expect(readFileSync(join(outside, "original"), "utf8")).toBe("keep this file");
});

test("unsupported index schemas are preserved rather than reset", () => {
  const root = workspace(), index = new AccessLogFileIndex(root);
  index.put(logTarget, file, range);
  index.close();
  const path = join(root, ".castloop", "access-log-files.sqlite");
  const database = new Database(path);
  database.exec("UPDATE access_log_files_schema SET version = 2 WHERE id = 1");
  database.close();
  expect(() => new AccessLogFileIndex(root)).toThrow("Unsupported access log file index schema");
  const preserved = new Database(path, { readonly: true });
  try {
    expect(preserved.query("SELECT version FROM access_log_files_schema").get()).toEqual({ version: 2 });
    expect(preserved.query("SELECT etag FROM access_log_files").get()).toEqual({ etag: file.etag });
  } finally { preserved.close(); }
});

test("workspace backups keep the rebuildable access log index outside their saved entries", async () => {
  const root = workspace();
  writeFileSync(join(root, "castloop.toml"), stringifyToml({ schema_version: 2, storage_layout: "show-v1",
    publication_protocol: "sqlite-sequential-v1", service_id: "service", account_id: logTarget.accountId,
    bucket_name: "private-media", worker_name: "test-worker", public_base_url: "https://test-worker.example.workers.dev",
    workers_dev_base_url: "https://test-worker.example.workers.dev" }));
  const index = new AccessLogFileIndex(root);
  index.put(logTarget, file, range);
  index.close();
  const result = await createLocalBackup(root, join(root, "backup.clbk"), { includeAudio: false, passphrase: "test backup password" });
  expect(result.entry_count).toBe(1);
  expect(result.excluded_counts.unknown).toBe(1);
});
