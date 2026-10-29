import { version } from "../../../package.json";
import type { SqliteServiceConfig } from "@castloop/shared";
import { backupEntryFramedBytes, emitBackupEntry, sealBackupArchive } from "./backup-archive";
import type { BackupExcludedReason, BackupManifest, BackupPending } from "./backup-archive";
import { loadWorkspaceConfig } from "./workspace-config";
import { pendingLocalDomainChanges } from "./sqlite-domain-local";
import { JOURNAL_FAMILIES } from "./local-journal-path";
import { closeSync, constants, existsSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BACKUP_READ_BLOCK_BYTES = 1024 * 1024;
const LOCK_SUFFIX_PATTERN = /\.lock\.sqlite(?:-journal|-wal|-shm)?$/;

type PlannedEntry = { path: string; kind: string; absolute: string; size: number };
type ExcludedEntry = { path: string; reason: BackupExcludedReason };
type PlannedBackup = { entries: PlannedEntry[]; excluded: ExcludedEntry[] };

export type BackupCreateResult = {
  archive: string; service_id: string; created_at: string; include_audio: boolean;
  entry_count: number; entry_bytes: number;
  excluded_counts: Record<BackupExcludedReason, number>;
  pending: BackupPending; scan_errors: string[];
};

function planRegularFile(entries: PlannedEntry[], path: string, absolute: string, kind: string): void {
  const stat = lstatSync(absolute);
  if (!stat.isFile()) throw new Error(`Backup target must be a regular file, not a symbolic link: ${path}`);
  entries.push({ path, kind, absolute, size: stat.size });
}

function isLockFile(name: string): boolean {
  return name.endsWith(".lock") || LOCK_SUFFIX_PATTERN.test(name);
}

function walkJournalFamily(entries: PlannedEntry[], excluded: ExcludedEntry[], directory: string, prefix: string): void {
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    const path = `${prefix}/${child.name}`;
    if (child.isSymbolicLink()) throw new Error(`Backup target must be a regular file, not a symbolic link: ${path}`);
    if (child.isDirectory()) { walkJournalFamily(entries, excluded, join(directory, child.name), path); continue; }
    if (child.name.endsWith(".tmp")) { excluded.push({ path, reason: "temporary" }); continue; }
    if (isLockFile(child.name)) { excluded.push({ path, reason: "lock" }); continue; }
    if (!child.isFile()) { excluded.push({ path, reason: "unknown" }); continue; }
    planRegularFile(entries, path, join(directory, child.name), "journal");
  }
}

function walkShowDirectory(entries: PlannedEntry[], excluded: ExcludedEntry[], root: string, showId: string, includeAudio: boolean): void {
  const directory = join(root, showId);
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    const path = `${showId}/${child.name}`;
    if (child.isSymbolicLink()) throw new Error(`Backup target must be a regular file, not a symbolic link: ${path}`);
    if (child.name.endsWith(".tmp")) { excluded.push({ path, reason: "temporary" }); continue; }
    if (isLockFile(child.name)) { excluded.push({ path, reason: "lock" }); continue; }
    if (child.name.endsWith(".mp3")) {
      if (includeAudio) planRegularFile(entries, path, join(directory, child.name), "audio");
      else excluded.push({ path, reason: "audio_default_excluded" });
      continue;
    }
    if (!child.isFile()) { excluded.push({ path, reason: "unknown" }); continue; }
    planRegularFile(entries, path, join(directory, child.name), child.name.endsWith(".toml") ? "metadata" : "asset");
  }
}

function enumerateBackupTargets(root: string, includeAudio: boolean): PlannedBackup {
  const entries: PlannedEntry[] = [];
  const excluded: ExcludedEntry[] = [];
  const config = join(root, "castloop.toml");
  if (existsSync(config)) planRegularFile(entries, "castloop.toml", config, "config");
  const adminConfig = join(root, "castloop-admin.toml");
  if (existsSync(adminConfig)) planRegularFile(entries, "castloop-admin.toml", adminConfig, "config");
  if (existsSync(join(root, ".gitignore"))) excluded.push({ path: ".gitignore", reason: "regenerated" });
  const state = join(root, ".castloop");
  if (existsSync(state)) {
    const stat = lstatSync(state);
    if (!stat.isDirectory()) throw new Error("Local state directory .castloop must be a real directory");
    for (const child of readdirSync(state, { withFileTypes: true })) {
      if (child.name === "secrets.json" && child.isFile() && !child.isSymbolicLink()) {
        planRegularFile(entries, ".castloop/secrets.json", join(state, "secrets.json"), "secret");
        continue;
      }
      if (child.isDirectory() && !child.isSymbolicLink() && (JOURNAL_FAMILIES as readonly string[]).includes(child.name)) {
        walkJournalFamily(entries, excluded, join(state, child.name), `.castloop/${child.name}`);
        continue;
      }
      excluded.push({ path: `.castloop/${child.name}`, reason: "unknown" });
    }
  }
  for (const child of readdirSync(root, { withFileTypes: true })) {
    if (["castloop.toml", "castloop-admin.toml", ".gitignore", ".castloop"].includes(child.name)) continue;
    if (child.isDirectory() && !child.isSymbolicLink() && existsSync(join(root, child.name, "show.toml")) &&
      lstatSync(join(root, child.name, "show.toml")).isFile()) {
      walkShowDirectory(entries, excluded, root, child.name, includeAudio);
      continue;
    }
    excluded.push({ path: child.name, reason: "unknown" });
  }
  const configs = entries.filter((entry) => entry.kind === "config")
    .sort((left, right) => left.path === "castloop.toml" ? -1 : right.path === "castloop.toml" ? 1 : left.path.localeCompare(right.path));
  const rest = entries.filter((entry) => entry.kind !== "config").sort((left, right) => left.path.localeCompare(right.path));
  return { entries: [...configs, ...rest], excluded: excluded.sort((left, right) => left.path.localeCompare(right.path)) };
}

function scanLocalOperations(root: string, config: SqliteServiceConfig):
  { pending: BackupPending; scanErrors: string[] } {
  const pending: BackupPending = { domain_changes: [] };
  const scanErrors: string[] = [];
  try { pending.domain_changes = pendingLocalDomainChanges(root, config); } catch { scanErrors.push("domain_changes"); }
  return { pending, scanErrors };
}

function emitFileContent(absolute: string, emit: (chunk: Buffer) => void): void {
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const block = Buffer.alloc(BACKUP_READ_BLOCK_BYTES);
    for (;;) {
      const read = readSync(fd, block, 0, block.length, null);
      if (!read) break;
      emit(Buffer.from(block.subarray(0, read)));
    }
  } finally { closeSync(fd); }
}

function excludedCounts(excluded: ExcludedEntry[]): Record<BackupExcludedReason, number> {
  const counts: Record<BackupExcludedReason, number> = { lock: 0, temporary: 0, regenerated: 0, audio_default_excluded: 0, unknown: 0 };
  for (const entry of excluded) counts[entry.reason]++;
  return counts;
}

export async function createLocalBackup(root: string, output: string,
  options: { includeAudio: boolean; passphrase: string }): Promise<BackupCreateResult> {
  const config = await loadWorkspaceConfig(root);
  const { entries, excluded } = enumerateBackupTargets(root, options.includeAudio);
  const entryBytes = entries.reduce((total, entry) => total + backupEntryFramedBytes(entry), 0);
  const { pending, scanErrors } = scanLocalOperations(root, config);
  const manifest = sealBackupArchive(output, options.passphrase,
    { serviceId: config.service_id, includeAudio: options.includeAudio, entryCount: entries.length, entryBytes },
    (emit, createdAt) => {
      const summaries: BackupManifest["entries"] = [];
      for (const entry of entries) {
        const sha256 = emitBackupEntry(emit, entry, (emitContent) => emitFileContent(entry.absolute, emitContent));
        summaries.push({ path: entry.path, size: entry.size, sha256, kind: entry.kind });
      }
      return { schema_version: 1 as const, cli_version: version, created_at: createdAt, service_id: config.service_id,
        include_audio: options.includeAudio, entries: summaries, excluded,
        retained_locks: excluded.filter((entry) => entry.reason === "lock").map((entry) => entry.path),
        pending, scan_errors: scanErrors };
    });
  return { archive: output, service_id: manifest.service_id, created_at: manifest.created_at, include_audio: manifest.include_audio,
    entry_count: manifest.entries.length, entry_bytes: entryBytes, excluded_counts: excludedCounts(manifest.excluded),
    pending: manifest.pending, scan_errors: manifest.scan_errors };
}

export function formatBackupCreate(result: BackupCreateResult): string {
  const excluded = Object.entries(result.excluded_counts).filter(([, count]) => count > 0).map(([reason, count]) => `${count} ${reason}`).join(", ") || "none";
  const pendingParts = result.pending.domain_changes.length ? `${result.pending.domain_changes.length} domain change(s)` : "none";
  const lines = [
    `Archive: ${result.archive}`,
    `Service: ${result.service_id}  Created: ${result.created_at}`,
    `Entries: ${result.entry_count} (${result.entry_bytes} bytes)`,
    `Audio originals: ${result.include_audio ? "included" : "excluded (use --include-audio for MP3 originals)"}`,
    `Excluded: ${excluded}`,
    `Unfinished local operations: ${pendingParts}`,
  ];
  if (result.scan_errors.length) lines.push(`Scan errors (archived without inspection): ${result.scan_errors.join(", ")}`);
  lines.push("The archive is a point-in-time snapshot; run backups while no other castloop command edits the workspace.");
  return lines.join("\n");
}
