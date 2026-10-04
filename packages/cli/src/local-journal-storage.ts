import { ensureLocalJournalParents, localJournalEntryExists, releaseLocalJournalLock, syncLocalJournalDirectory } from "./local-journal-path";
import type { JournalFamily } from "./local-journal-path";
import { readBoundedLocalJournal } from "./local-journal-read";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type LocalJournalStorage = {
  path: string;
  initialize: (value: unknown) => void;
  read: () => unknown;
  requireLock: (message?: string) => void;
  replace: (value: unknown) => void;
  exclusively: <T>(callback: () => Promise<T>) => Promise<T>;
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
  const lock = `${file}.lock`;
  const checkParents = (create = false) => ensureLocalJournalParents(root, family, serviceId, create);
  let locked = false;
  const requireLock = (message = "Local journal writes require its exclusive client lock") => {
    if (!locked) throw new Error(message);
  };
  return {
    path: file,
    initialize: (value) => {
      checkParents(true);
      if (localJournalEntryExists(file)) return;
      if (localJournalEntryExists(lock)) throw new Error("Preserve the retained client lock without recreating its missing journal");
      createLocalJournalRecord(file, value);
    },
    read: () => { checkParents(); return readBoundedLocalJournal(file); },
    requireLock,
    replace: (value) => {
      requireLock();
      checkParents();
      const temp = `${file}.${crypto.randomUUID()}.tmp`;
      writeRecord(temp, value);
      renameSync(temp, file);
      syncLocalJournalDirectory(dirname(file));
    },
    exclusively: async (callback) => {
      checkParents();
      const fd = openSync(lock, "wx", 0o600);
      locked = true;
      try { fsyncSync(fd); syncLocalJournalDirectory(dirname(file)); return await callback(); }
      finally { locked = false; releaseLocalJournalLock(root, family, serviceId, lock, fd); }
    },
  };
}
