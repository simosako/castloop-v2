import { expect, test } from "bun:test";
import { createLocalJournalRecord, createLocalJournalStorage } from "./local-journal-storage";
import { closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

test("journal storage creates private records and atomically replaces them without rewriting an open predecessor", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-journal-storage-");
  try {
    const storage = createLocalJournalStorage(root, "sqlite-domain-changes", "service", "operation.json");
    storage.initialize({ phase: "prepared" });
    storage.initialize({ phase: "must-not-overwrite" });
    expect(storage.read()).toEqual({ phase: "prepared" });
    for (const directory of [join(root, ".castloop"), join(root, ".castloop", "sqlite-domain-changes"), dirname(storage.path)]) {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(lstatSync(storage.path).mode & 0o777).toBe(0o600);
    const fd = openSync(storage.path, "r");
    try {
      storage.replace({ phase: "requested" });
      expect(storage.read()).toEqual({ phase: "requested" });
      expect(JSON.parse(readFileSync(fd, "utf8"))).toEqual({ phase: "prepared" });
      expect(lstatSync(storage.path).ino).not.toBe(fstatSync(fd).ino);
      expect(lstatSync(storage.path).mode & 0o777).toBe(0o600);
      expect(readdirSync(dirname(storage.path))).toEqual(["operation.json"]);
    } finally { closeSync(fd); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed record serialization preserves the predecessor and leaves its private temporary file for inspection", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-journal-storage-failure-");
  try {
    const storage = createLocalJournalStorage(root, "rss-import-downloads", undefined, "operation.json");
    storage.initialize({ phase: "prepared" });
    expect(() => storage.replace({ invalid: 1n })).toThrow();
    expect(storage.read()).toEqual({ phase: "prepared" });
    expect(existsSync(`${storage.path}.lock`)).toBe(false);
    const temporary = readdirSync(dirname(storage.path)).filter((name) => name.endsWith(".tmp"));
    expect(temporary).toHaveLength(1);
    expect(lstatSync(join(dirname(storage.path), temporary[0]!)).mode & 0o777).toBe(0o600);
    const archive = join(dirname(storage.path), "archive.json");
    createLocalJournalRecord(archive, { phase: "retained" });
    expect(() => createLocalJournalRecord(archive, {})).toThrow();
    expect(JSON.parse(readFileSync(archive, "utf8"))).toEqual({ phase: "retained" });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("journal storage rejects filenames that could escape the selected journal directory", () => {
  const root = mkdtempSync("/tmp/opencode/castloop-journal-storage-identity-");
  try {
    for (const name of ["../outside.json", "/outside.json", "history/entry.json", ".json", "operation.json.lock"]) {
      expect(() => createLocalJournalStorage(root, "rss-import-downloads", undefined, name)).toThrow("file identity");
    }
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
