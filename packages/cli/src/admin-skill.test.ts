import { expect, test } from "bun:test";
import { ADMIN_SKILL_FILES, exportAdminSkill } from "./admin-skill";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

test("Skill export embeds canonical files and refuses overwrites and symlink parents", () => {
  const root = mkdtempSync("/tmp/opencode/castloop-skill-");
  try {
    const destination = join(root, "castloop"); exportAdminSkill(destination);
    for (const [file, content] of Object.entries(ADMIN_SKILL_FILES)) {
      expect(readFileSync(join(destination, file), "utf8")).toBe(content);
      expect(content).toBe(readFileSync(join(import.meta.dir, "../../../skills/castloop", file), "utf8"));
    }
    expect(() => exportAdminSkill(destination)).toThrow("must not exist");
    symlinkSync(root, join(root, "link"));
    expect(() => exportAdminSkill(join(root, "link", "other"))).toThrow("real directory");
    expect(ADMIN_SKILL_FILES["SKILL.md"]).toContain("推測しない");
    expect(ADMIN_SKILL_FILES["references/recovery.md"]).toContain("未知PUT/POST");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
