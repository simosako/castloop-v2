import { AgentError } from "./agent-output";
import { assertValidPassphrase, BACKUP_PASSPHRASE_MAX_BYTES, BACKUP_PASSPHRASE_MIN_BYTES } from "./backup-archive";
import { decodeUtf8Strict } from "./utf8";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const BACKUP_PASSPHRASE_FILE_LIMIT_BYTES = 4096;

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
    const source = decodeUtf8Strict(buffer.subarray(0, size));
    const passphrase = source.replace(/\r?\n$/, "");
    assertValidPassphrase(passphrase);
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
  assertValidPassphrase(first);
  return first;
}
