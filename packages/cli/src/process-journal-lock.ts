import { constants, Database } from "bun:sqlite";
import { closeSync, lstatSync, openSync } from "node:fs";

export async function withProcessJournalLock<T>(path: string, callback: () => Promise<T>): Promise<T> {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { const fd = openSync(path, "wx", 0o600); closeSync(fd); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const original = lstatSync(path);
  if (!original.isFile()) throw new Error("Invalid process lock file");
  let database: Database | undefined;
  try {
    // Let SQLite own all open descriptors so another close cannot release its POSIX locks.
    database = new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW);
    database.exec("PRAGMA busy_timeout = 0");
    try { database.exec("BEGIN EXCLUSIVE"); }
    catch { throw new Error("Another CLI holds this operation's process lock"); }
    const current = lstatSync(path);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) throw new Error("Process lock file changed");
    return await callback();
  } finally {
    database?.close();
  }
}
