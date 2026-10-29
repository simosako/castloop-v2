import { ensureLocalJournalParents, localJournalEntryExists, syncLocalJournalDirectory } from "./local-journal-path";
import type { JournalFamily } from "./local-journal-path";
import { readBoundedLocalJournal } from "./local-journal-read";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LocalJournalStorage = {
  path: string;
  initialize: (value: unknown) => void;
  read: () => unknown;
  replace: (value: unknown) => void;
};

export function writeSyncedLocalFile(file: string, source: () => string): void {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, source()); fsyncSync(fd); } finally { closeSync(fd); }
}

function writeRecord(file: string, value: unknown): void {
  writeSyncedLocalFile(file, () => JSON.stringify(value));
}

export function createLocalJournalRecord(file: string, value: unknown): void {
  writeRecord(file, value);
  syncLocalJournalDirectory(dirname(file));
}

export function createLocalJournalStorage(root: string, family: JournalFamily, serviceId: string | undefined,
  fileName: string): LocalJournalStorage {
  if (!/^[a-z0-9][a-z0-9-]*\.json$/i.test(fileName)) throw new Error("Invalid local journal file identity");
  const file = join(root, ".castloop", family, ...(serviceId === undefined ? [] : [serviceId]), fileName);
  const checkParents = (create = false) => ensureLocalJournalParents(root, family, serviceId, create);
  return {
    path: file,
    initialize: (value) => {
      checkParents(true);
      if (localJournalEntryExists(file)) return;
      createLocalJournalRecord(file, value);
    },
    read: () => { checkParents(); return readBoundedLocalJournal(file); },
    replace: (value) => {
      checkParents();
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      writeRecord(temp, value);
      renameSync(temp, file);
      syncLocalJournalDirectory(dirname(file));
    },
  };
}
