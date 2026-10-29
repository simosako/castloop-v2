import { expect, test } from "bun:test";
import { ensureLocalJournalParents } from "./local-journal-path";
import type { JournalFamily } from "./local-journal-path";
import { createLocalJournalStorage } from "./local-journal-storage";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const familyServices = {
  "sqlite-initializations": "service", "sqlite-registrations": "service",
  "sqlite-rss-imports": "service", "sqlite-domain-changes": "service",
  "rss-import-downloads": undefined,
  "sqlite-client": "service",
} satisfies Record<JournalFamily, string | undefined>;

test("all journal families use their exact service-scoped or flat directory and reject the opposite scope", async () => {
  for (const family of Object.keys(familyServices) as JournalFamily[]) {
    const root = mkdtempSync("/tmp/opencode/castloop-journal-family-");
    try {
      const service = familyServices[family];
      expect(() => ensureLocalJournalParents(root, family, service === undefined ? "service" : undefined, true)).toThrow("identity");
      expect(readdirSync(root)).toEqual([]);
      const journal = createLocalJournalStorage(root, family, service, "operation.json");
      expect(journal.path).toBe(join(root, ".castloop", family, ...(service === undefined ? [] : [service]), "operation.json"));
      journal.initialize({ family, phase: "prepared" });
      expect(journal.read()).toEqual({ family, phase: "prepared" });
      journal.replace({ family, phase: "updated" });
      expect(journal.read()).toEqual({ family, phase: "updated" });
      expect(readdirSync(join(root, ".castloop"))).toEqual([family]);
      expect(readdirSync(join(root, ".castloop", family))).toEqual(service === undefined ? ["operation.json"] : [service]);
      expect(readdirSync(dirname(journal.path))).toEqual(["operation.json"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

for (const family of ["sqlite-domain-changes", "rss-import-downloads"] as const) {
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

  test(`${family} rechecks parents before reading or replacing a record`, () => {
    const root = mkdtempSync("/tmp/opencode/castloop-journal-replaced-");
    try {
      const journal = storage(root); journal.initialize({});
      const directory = dirname(journal.path), outside = join(root, "outside");
      renameSync(directory, `${directory}-saved`); mkdirSync(outside); symlinkSync(outside, directory);
      expect(() => journal.read()).toThrow("real directories");
      expect(() => journal.replace({ phase: "updated" })).toThrow("real directories");
      expect(readdirSync(outside)).toEqual([]);
      rmSync(directory); renameSync(`${directory}-saved`, directory);
      journal.replace({ phase: "updated" });
      expect(journal.read()).toEqual({ phase: "updated" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("read-only checks do not create parents and invalid directory identities cannot escape the workspace", () => {
  const root = mkdtempSync("/tmp/opencode/castloop-journal-missing-");
  try {
    const missing = join(root, "missing");
    ensureLocalJournalParents(missing, "sqlite-domain-changes", "service");
    expect(existsSync(missing)).toBe(false);
    expect(() => ensureLocalJournalParents(missing, "sqlite-domain-changes", "service", true)).toThrow("already exist");
    expect(() => ensureLocalJournalParents(root, "sqlite-domain-changes", "../outside", true)).toThrow("identity");
    expect(() => ensureLocalJournalParents(root, "unknown-family" as JournalFamily, "service", true)).toThrow("identity");
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
