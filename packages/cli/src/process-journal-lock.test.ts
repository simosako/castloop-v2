import { expect, test } from "bun:test";
import { withProcessJournalLock } from "./process-journal-lock";
import { createLocalJournalStorage } from "./local-journal-storage";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("new-format process locks reject concurrent writers and are released after SIGKILL", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-process-lock-");
  const path = join(root, "process.sqlite");
  const module = import.meta.resolve("./process-journal-lock.ts");
  const child = Bun.spawn([process.execPath, "-e", `import {withProcessJournalLock} from ${JSON.stringify(module)};
    await withProcessJournalLock(${JSON.stringify(path)}, async () => { console.log("locked"); setInterval(() => {}, 1000); await new Promise(() => {}); });`],
  { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader(), first = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    await expect(withProcessJournalLock(path, async () => {})).rejects.toThrow("Another CLI");
    child.kill("SIGKILL"); await child.exited;
    expect(await withProcessJournalLock(path, async () => "resumed")).toBe("resumed");
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } rmSync(root, { recursive: true, force: true }); }
}, 10000);

test("new format never bypasses or removes a retained legacy lock", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-legacy-lock-");
  try {
    const journal = createLocalJournalStorage(root, "sqlite-rss-imports", "service", "operation.json");
    journal.initialize({ schema_version: 2 }); writeFileSync(`${journal.path}.lock`, "");
    await expect(journal.exclusively(async () => { throw new Error("must not run"); })).rejects.toThrow("legacy client lock");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a rejected same-process acquisition cannot release the owner's OS lock for another process", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-process-lock-contention-"), path = join(root, "process.sqlite");
  try {
    await withProcessJournalLock(path, async () => {
      await expect(withProcessJournalLock(path, async () => {})).rejects.toThrow("Another CLI");
      const child = Bun.spawn([process.execPath, "-e", `import {withProcessJournalLock} from ${JSON.stringify(import.meta.resolve("./process-journal-lock.ts"))};
        await withProcessJournalLock(${JSON.stringify(path)}, async () => { throw new Error("owner lock was lost"); });`], { stdout: "pipe", stderr: "pipe" });
      const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(code).not.toBe(0); expect(error).toContain("Another CLI"); expect(error).not.toContain("owner lock was lost");
    });
    expect(await withProcessJournalLock(path, async () => "released")).toBe("released");
    symlinkSync(path, join(root, "link.sqlite"));
    await expect(withProcessJournalLock(join(root, "link.sqlite"), async () => {})).rejects.toThrow("Invalid process lock");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10000);
