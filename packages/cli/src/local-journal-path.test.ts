import { expect, test } from "bun:test";
import { ensureLocalJournalParents } from "./local-journal-path";
import { createLocalJournalStorage } from "./local-journal-storage";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

for (const family of ["sqlite-drafts", "sqlite-uploads", "sqlite-publications", "sqlite-initializations", "sqlite-registrations",
  "sqlite-controls", "sqlite-lifecycle", "sqlite-rss-imports", "sqlite-service-updates", "rss-import-downloads"] as const) {
  const service = family === "rss-import-downloads" ? undefined : "service";
  const storage = (root: string) => createLocalJournalStorage(root, family, service, "operation.json");
  test(`${family} rejects symlink parents without reads or writes outside the workspace`, () => {
    for (const level of ["root", "state", "family", ...(service ? ["service"] : [])]) {
      const base = mkdtempSync("/tmp/opencode/castloop-journal-parent-");
      const root = join(base, "workspace"), outside = join(base, "outside");
      mkdirSync(outside); writeFileSync(join(outside, "sentinel"), "unchanged");
      try {
        if (level !== "root") mkdirSync(root);
        if (["family", "service"].includes(level)) mkdirSync(join(root, ".castloop"));
        if (level === "service") mkdirSync(join(root, ".castloop", family));
        const target = level === "root" ? root : level === "state" ? join(root, ".castloop") : level === "family" ?
          join(root, ".castloop", family) : join(root, ".castloop", family, service!);
        symlinkSync(outside, target);
        expect(() => storage(root).read()).toThrow("real directories");
        expect(() => storage(root).initialize({})).toThrow("real directories");
        expect(readdirSync(outside)).toEqual(["sentinel"]);
        expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("unchanged");
      } finally { rmSync(base, { recursive: true, force: true }); }
    }
  });

  test(`${family} preserves dangling locks and cannot recreate a missing journal`, () => {
    const root = mkdtempSync("/tmp/opencode/castloop-journal-dangling-");
    try {
      const journal = storage(root); journal.initialize({}); rmSync(journal.path);
      symlinkSync(join(root, "missing-target"), `${journal.path}.lock`);
      expect(() => journal.initialize({})).toThrow("retained");
      expect(existsSync(journal.path)).toBe(false);
      expect(lstatSync(`${journal.path}.lock`).isSymbolicLink()).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test(`${family} rechecks parents and refuses to remove another owner's replacement lock`, async () => {
    const root = mkdtempSync("/tmp/opencode/castloop-journal-replaced-");
    try {
      const journal = storage(root); journal.initialize({});
      const directory = dirname(journal.path), outside = join(root, "outside");
      renameSync(directory, `${directory}-saved`); mkdirSync(outside); symlinkSync(outside, directory);
      expect(() => journal.read()).toThrow("real directories");
      await expect(journal.exclusively(async () => {})).rejects.toThrow("real directories");
      expect(readdirSync(outside)).toEqual([]);
      rmSync(directory); renameSync(`${directory}-saved`, directory);
      await expect(journal.exclusively(async () => {
        rmSync(`${journal.path}.lock`); writeFileSync(`${journal.path}.lock`, "another-owner");
      })).rejects.toThrow("changed client lock");
      expect(readFileSync(`${journal.path}.lock`, "utf8")).toBe("another-owner");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("read-only checks do not create parents and invalid directory identities cannot escape the workspace", () => {
  const root = mkdtempSync("/tmp/opencode/castloop-journal-missing-");
  try {
    const missing = join(root, "missing");
    ensureLocalJournalParents(missing, "sqlite-uploads", "service");
    expect(existsSync(missing)).toBe(false);
    expect(() => ensureLocalJournalParents(missing, "sqlite-uploads", "service", true)).toThrow("already exist");
    expect(() => ensureLocalJournalParents(root, "sqlite-uploads", "../outside", true)).toThrow("identity");
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
