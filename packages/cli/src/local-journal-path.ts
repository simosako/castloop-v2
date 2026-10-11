import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export type JournalFamily = "staging-uploads" | "publication-jobs" | "lifecycle-jobs" | "show-registrations" | "drafts" |
  "bridge-deployments" | "migration-setups" | "migrations" | "service-initializations" | "service-updates" | "domain-changes";

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
  const flat = ["bridge-deployments", "migration-setups", "migrations", "service-initializations"].includes(family);
  if (!["staging-uploads", "publication-jobs", "lifecycle-jobs", "show-registrations", "drafts", "bridge-deployments", "migration-setups", "migrations", "service-initializations", "service-updates", "domain-changes"].includes(family) ||
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
