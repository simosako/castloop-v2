import { readBoundedLocalJournal } from "./local-journal-read";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function administratorKey(root: string, create = false): string {
  const directory = join(root, ".castloop");
  const file = join(directory, "secrets.json");
  if (create && !existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("Local state parent must be a real directory");
  if (create && !existsSync(file)) {
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ CASTLOOP_ADMIN_KEY: randomBytes(32).toString("hex") }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const parent = openSync(directory, "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  const secret = readBoundedLocalJournal(file);
  if (!secret || typeof secret !== "object" || !("CASTLOOP_ADMIN_KEY" in secret) ||
    typeof secret.CASTLOOP_ADMIN_KEY !== "string" || !secret.CASTLOOP_ADMIN_KEY) {
    throw new Error("Missing local administrator key");
  }
  return secret.CASTLOOP_ADMIN_KEY;
}
