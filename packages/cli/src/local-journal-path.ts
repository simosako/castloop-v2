import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const JOURNAL_FAMILIES = ["rss-import-downloads",
  "sqlite-drafts", "sqlite-uploads", "sqlite-publications", "sqlite-initializations", "sqlite-registrations", "sqlite-controls",
  "sqlite-lifecycle", "sqlite-rss-imports", "sqlite-service-updates", "sqlite-domain-changes", "sqlite-client", "sqlite-operation-requests"] as const;
export type JournalFamily = typeof JOURNAL_FAMILIES[number];

export function localJournalEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function syncLocalJournalDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function ensureLocalJournalParents(root: string, family: JournalFamily, serviceId: string | undefined, create = false): void {
  const flat = family === "rss-import-downloads";
  if (!JOURNAL_FAMILIES.includes(family) ||
    flat !== (serviceId === undefined) || serviceId !== undefined &&
    (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(serviceId) || serviceId.length > 20)) throw new Error("Invalid local journal directory identity");
  const directories = [root, join(root, ".castloop"), join(root, ".castloop", family),
    ...(serviceId !== undefined ? [join(root, ".castloop", family, serviceId)] : [])];
  for (const directory of directories) {
    if (!localJournalEntryExists(directory)) {
      if (!create) return;
      if (directory === root) throw new Error("Local journal workspace root must already exist");
      mkdirSync(directory, { mode: 0o700 });
      syncLocalJournalDirectory(dirname(directory));
    }
    if (!lstatSync(directory).isDirectory()) throw new Error("Local journal parents must be real directories, not symlinks");
    if (create) syncLocalJournalDirectory(directory);
  }
}

export function releaseLocalJournalLock(root: string, family: JournalFamily, serviceId: string | undefined, path: string, fd: number): void {
  try {
    ensureLocalJournalParents(root, family, serviceId);
    const owned = fstatSync(fd, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino || current.size !== 0n) {
      throw new Error("Preserve the changed client lock; it is not this invocation's empty lock file");
    }
    unlinkSync(path);
    syncLocalJournalDirectory(dirname(path));
  } finally { closeSync(fd); }
}
