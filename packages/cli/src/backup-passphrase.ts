import { AgentError } from "./agent-output";
import { BACKUP_PASSPHRASE_MAX_BYTES, BACKUP_PASSPHRASE_MIN_BYTES } from "./backup-archive";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const BACKUP_PASSPHRASE_FILE_LIMIT_BYTES = 4096;

function validatePassphrase(passphrase: string): void {
  const bytes = Buffer.byteLength(passphrase, "utf8");
  if (bytes < BACKUP_PASSPHRASE_MIN_BYTES || bytes > BACKUP_PASSPHRASE_MAX_BYTES) {
    throw new Error(`Backup passphrase must be ${BACKUP_PASSPHRASE_MIN_BYTES} to ${BACKUP_PASSPHRASE_MAX_BYTES} bytes`);
  }
}

function readPassphraseFile(file: string): string {
  const fd = openSync(resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > BACKUP_PASSPHRASE_FILE_LIMIT_BYTES) throw new Error("Passphrase file must be a bounded regular file");
    const buffer = Buffer.alloc(stat.size);
    let size = 0;
    while (size < stat.size) {
      const read = readSync(fd, buffer, size, stat.size - size, null);
      if (!read) break;
      size += read;
    }
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
    const passphrase = source.replace(/\r?\n$/, "");
    validatePassphrase(passphrase);
    return passphrase;
  } finally { closeSync(fd); }
}

async function askHidden(label: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const writable = terminal as unknown as { _writeToOutput?: (chunk: string) => void };
  const original = writable._writeToOutput?.bind(terminal);
  writable._writeToOutput = (chunk: string) => { if (/[\r\n]/.test(chunk)) process.stdout.write("\n"); };
  try {
    const answer = (await terminal.question(`${label}: `)).trim();
    return answer;
  } finally {
    writable._writeToOutput = original;
    terminal.close();
  }
}

export async function backupPassphrase(flags: Record<string, string>, confirm: boolean): Promise<string> {
  if (flags["passphrase-file"]) return readPassphraseFile(flags["passphrase-file"]);
  if (!process.stdin.isTTY || process.argv.includes("--non-interactive") || process.argv.includes("--json")) {
    throw new AgentError("missing_input", "Missing --passphrase-file");
  }
  const first = await askHidden("Backup passphrase");
  if (confirm) {
    const second = await askHidden("Repeat backup passphrase");
    if (first !== second) throw new Error("Backup passphrases differ");
  }
  validatePassphrase(first);
  return first;
}
