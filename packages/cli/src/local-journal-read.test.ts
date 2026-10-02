import { expect, test } from "bun:test";
import { readBoundedLocalJournal } from "./local-journal-read";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("local journal reader is bounded, strict UTF-8 and refuses symlinks/non-files without modifying them", () => {
  const root = mkdtempSync("/tmp/opencode/castloop-journal-read-");
  const file = join(root, "record.json");
  writeFileSync(file, '{"phase":"prepared"}');
  expect(readBoundedLocalJournal(file)).toEqual({ phase: "prepared" });
  const link = join(root, "link.json");
  symlinkSync(file, link);
  expect(() => readBoundedLocalJournal(link)).toThrow();
  expect(() => readBoundedLocalJournal(root)).toThrow("size/type");
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(16385, 32), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]), Buffer.from("invalid")]) {
    writeFileSync(file, bytes);
    expect(() => readBoundedLocalJournal(file)).toThrow();
    expect(readFileSync(file)).toEqual(bytes);
  }
});
