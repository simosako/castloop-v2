import { syncLocalJournalDirectory } from "./local-journal-path";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function protectLocalState(root: string): void {
  if (!lstatSync(root).isDirectory()) throw new Error("Workspace must be a real directory");
  const fd = openSync(join(root, ".gitignore"), constants.O_CREAT | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1_000_000) throw new Error("Workspace gitignore must be a bounded regular file");
    const source = readFileSync(fd, "utf8"), lines = source.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const rules = [".castloop/", "*.mp3"];
    if (JSON.stringify(lines.slice(-2)) !== JSON.stringify(rules)) {
      const addition = `${source && !source.endsWith("\n") ? "\n" : ""}${rules.join("\n")}\n`;
      if (Buffer.byteLength(source) + Buffer.byteLength(addition) > 1_000_000) throw new Error("Workspace gitignore protection exceeds its size limit");
      writeFileSync(fd, addition);
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncLocalJournalDirectory(root);
}
