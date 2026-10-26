import type { SqliteServiceConfig } from "@castloop/shared";
import { readBackupArchive } from "./backup-archive";
import type { BackupExcludedReason, BackupPending, BackupReadSink } from "./backup-archive";
import { protectLocalState } from "./workspace-protection";
import { parseSqliteWorkspaceConfigText } from "./workspace-config";
import { syncLocalJournalDirectory } from "./local-journal-path";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function discardTarget(): { content: () => void; done: () => void } {
  return { content: () => {}, done: () => {} };
}

function configCaptureSink(capture: (text: string) => void): BackupReadSink {
  return (entry) => {
    if (entry.path !== "castloop.toml") return discardTarget();
    let text = "";
    return { content: (chunk) => { text += chunk.toString("utf8"); }, done: () => capture(text) };
  };
}

function parseConfigText(text: string | null): SqliteServiceConfig | null {
  if (text === null) return null;
  try { return parseSqliteWorkspaceConfigText(text); }
  catch { return null; }
}

function excludedCounts(excluded: Array<{ reason: BackupExcludedReason }>): Record<BackupExcludedReason, number> {
  const counts: Record<BackupExcludedReason, number> = { lock: 0, temporary: 0, regenerated: 0, audio_default_excluded: 0, unknown: 0 };
  for (const entry of excluded) counts[entry.reason]++;
  return counts;
}

function pendingSummary(pending: BackupPending): string {
  const parts = [
    pending.drafts_staged.length ? `${pending.drafts_staged.length} staged draft(s)` : "",
    pending.drafts_unresolved.length ? `${pending.drafts_unresolved.length} unresolved publication(s)` : "",
    pending.show_controls ? `${pending.show_controls} show control(s)` : "",
    pending.domain_changes.length ? `${pending.domain_changes.length} domain change(s)` : "",
    pending.service_updates.length ? `${pending.service_updates.length} service update(s)` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "none";
}

export type BackupVerifyResult = {
  archive: string; ok: true; service_id: string; created_at: string; cli_version: string; include_audio: boolean;
  entry_count: number; entry_bytes: number; config_valid: boolean;
  excluded_counts: Record<BackupExcludedReason, number>; retained_locks: string[];
  pending: BackupPending; scan_errors: string[]; source_paths: string[];
};

export type BackupRestorePreviewResult = {
  archive: string; destination: string; destination_exists: boolean;
  service_id: string; created_at: string; include_audio: boolean; config_valid: boolean;
  entries: Array<{ path: string; size: number; kind: string }>; entry_bytes: number;
  excluded_counts: Record<BackupExcludedReason, number>; retained_locks: string[];
  pending: BackupPending; scan_errors: string[]; source_paths: string[]; next_steps: string[];
};

export type BackupRestoreResult = {
  archive: string; restored_to: string; service_id: string; created_at: string;
  entry_count: number; entry_bytes: number;
  pending: BackupPending; scan_errors: string[]; source_paths: string[]; next_steps: string[];
};

export function verifyLocalBackup(file: string, passphrase: string): BackupVerifyResult {
  let configText: string | null = null;
  const { header, manifest } = readBackupArchive(file, passphrase, configCaptureSink((text) => { configText = text; }));
  return { archive: file, ok: true, service_id: manifest.service_id, created_at: manifest.created_at,
    cli_version: header.cli_version, include_audio: manifest.include_audio,
    entry_count: manifest.entries.length, entry_bytes: header.entry_bytes,
    config_valid: parseConfigText(configText) !== null,
    excluded_counts: excludedCounts(manifest.excluded), retained_locks: manifest.retained_locks,
    pending: manifest.pending, scan_errors: manifest.scan_errors, source_paths: manifest.source_paths };
}

export function previewBackupRestore(file: string, destination: string, passphrase: string): BackupRestorePreviewResult {
  const target = resolve(destination);
  let configText: string | null = null;
  const { header, manifest } = readBackupArchive(file, passphrase, configCaptureSink((text) => { configText = text; }));
  const exists = existsSync(target);
  const nextSteps: string[] = [];
  nextSteps.push(exists
    ? "Choose a different destination: backup-restore requires a path that does not exist yet."
    : `Restore with: castloop backup-restore ${file} ${target} confirm`);
  nextSteps.push("After restoration, run castloop doctor --local in the restored workspace.");
  if (manifest.pending.drafts_unresolved.length) nextSteps.push("Unresolved publications: observe them only (operation-status); never replay requests.");
  if (manifest.source_paths.length) nextSteps.push("Unfinished drafts need their original absolute source paths to continue; otherwise observe only and restage.");
  return { archive: file, destination: target, destination_exists: exists,
    service_id: manifest.service_id, created_at: manifest.created_at, include_audio: manifest.include_audio,
    config_valid: parseConfigText(configText) !== null,
    entries: manifest.entries.map(({ path, size, kind }) => ({ path, size, kind })), entry_bytes: header.entry_bytes,
    excluded_counts: excludedCounts(manifest.excluded), retained_locks: manifest.retained_locks,
    pending: manifest.pending, scan_errors: manifest.scan_errors, source_paths: manifest.source_paths, next_steps: nextSteps };
}

export function restoreLocalBackup(file: string, destination: string, passphrase: string): BackupRestoreResult {
  const target = resolve(destination);
  if (existsSync(target)) throw new Error("Restore destination must not exist; choose a new path");
  const parent = dirname(target);
  if (!lstatSync(parent).isDirectory()) throw new Error("Restore destination parent must be an existing directory");
  const openFiles: number[] = [];
  let started = false;
  try {
    const { header, manifest } = readBackupArchive(file, passphrase, (entry) => {
      if (!started) {
        if (entry.path !== "castloop.toml") throw new Error("Backup archive does not start with its service configuration");
        let text = "";
        return { content: (chunk) => { text += chunk.toString("utf8"); }, done: () => {
          parseSqliteWorkspaceConfigText(text);
          mkdirSync(target, { mode: 0o700 });
          syncLocalJournalDirectory(parent);
          started = true;
          writeRestoredFile(target, "castloop.toml", Buffer.from(text, "utf8"));
        } };
      }
      const restorePath = join(target, entry.path);
      const directory = dirname(restorePath);
      mkdirSync(directory, { mode: 0o700, recursive: true });
      const fd = openSync(restorePath, "wx", 0o600);
      openFiles.push(fd);
      return { content: (chunk) => {
        let written = 0;
        while (written < chunk.length) written += writeSync(fd, chunk, written, chunk.length - written);
      }, done: () => {
        fsyncSync(fd);
        closeSync(fd);
        openFiles.splice(openFiles.indexOf(fd), 1);
        syncLocalJournalDirectory(directory);
      } };
    });
    if (!started) throw new Error("Backup archive does not contain castloop.toml");
    protectLocalState(target);
    const nextSteps = ["Run castloop doctor --local in the restored workspace to confirm the administrator key is readable."];
    if (manifest.pending.drafts_unresolved.length) nextSteps.push("Unresolved publications: observe them only (operation-status); never replay requests.");
    if (manifest.source_paths.length) nextSteps.push("Unfinished drafts need their original absolute source paths to continue; otherwise observe only and restage.");
    nextSteps.push("Verification success does not prove server-side recovery, unresolved requests or publication results.");
    return { archive: file, restored_to: target, service_id: manifest.service_id, created_at: manifest.created_at,
      entry_count: manifest.entries.length, entry_bytes: header.entry_bytes,
      pending: manifest.pending, scan_errors: manifest.scan_errors, source_paths: manifest.source_paths, next_steps: nextSteps };
  } catch (error) {
    for (const fd of openFiles.splice(0)) { try { closeSync(fd); } catch { /* the partial file is discarded with the destination */ } }
    if (started) rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function writeRestoredFile(destination: string, path: string, content: Buffer): void {
  const target = join(destination, path);
  const fd = openSync(target, "wx", 0o600);
  try {
    let written = 0;
    while (written < content.length) written += writeSync(fd, content, written, content.length - written);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncLocalJournalDirectory(dirname(target));
}

export function formatBackupVerify(result: BackupVerifyResult): string {
  const lines = [
    `Archive: ${result.archive}`,
    `Service: ${result.service_id}  Created: ${result.created_at}  CLI: ${result.cli_version}`,
    `Verification: OK (${result.entry_count} entries, ${result.entry_bytes} bytes)`,
    `Service configuration: ${result.config_valid ? "valid" : "INVALID"}`,
    `Audio originals: ${result.include_audio ? "included" : "excluded at creation"}`,
    `Excluded: ${Object.entries(result.excluded_counts).filter(([, count]) => count > 0).map(([reason, count]) => `${count} ${reason}`).join(", ") || "none"}`,
    `Retained locks recorded: ${result.retained_locks.length}`,
    `Unfinished local operations: ${pendingSummary(result.pending)}`,
  ];
  if (result.scan_errors.length) lines.push(`Scan errors (archived without inspection): ${result.scan_errors.join(", ")}`);
  if (result.source_paths.length) lines.push(`Frozen source paths: ${result.source_paths.length}`);
  return lines.join("\n");
}

export function formatBackupRestorePreview(result: BackupRestorePreviewResult): string {
  const lines = [
    `Archive: ${result.archive}`,
    `Destination: ${result.destination}${result.destination_exists ? " (ALREADY EXISTS; restore will refuse it)" : " (new)"}`,
    `Service: ${result.service_id}  Created: ${result.created_at}`,
    `Service configuration: ${result.config_valid ? "valid" : "INVALID"}`,
    `Expansion: ${result.entries.length} entries (${result.entry_bytes} bytes)`,
    ...result.entries.slice(0, 20).map((entry) => `  ${entry.size.toString().padStart(10)}  ${entry.kind.padEnd(8)} ${entry.path}`),
    ...(result.entries.length > 20 ? [`  ... and ${result.entries.length - 20} more`] : []),
    `Excluded at creation: ${Object.entries(result.excluded_counts).filter(([, count]) => count > 0).map(([reason, count]) => `${count} ${reason}`).join(", ") || "none"}`,
    `Unfinished local operations: ${pendingSummary(result.pending)}`,
  ];
  if (result.source_paths.length) lines.push(`Frozen source paths: ${result.source_paths.length}`);
  lines.push(...result.next_steps.map((step) => `Next: ${step}`));
  return lines.join("\n");
}

export function formatBackupRestore(result: BackupRestoreResult): string {
  const lines = [
    `Restored: ${result.archive}`,
    `Destination: ${result.restored_to}`,
    `Service: ${result.service_id}  Archive created: ${result.created_at}`,
    `Entries: ${result.entry_count} (${result.entry_bytes} bytes)`,
    `Unfinished local operations: ${pendingSummary(result.pending)}`,
  ];
  if (result.scan_errors.length) lines.push(`Scan errors (archived without inspection): ${result.scan_errors.join(", ")}`);
  if (result.source_paths.length) lines.push(`Frozen source paths: ${result.source_paths.length}`);
  lines.push(...result.next_steps.map((step) => `Next: ${step}`));
  return lines.join("\n");
}
