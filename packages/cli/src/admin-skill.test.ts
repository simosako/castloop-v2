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
    expect(ADMIN_SKILL_FILES["references/recovery.md"]).toContain("unchanged");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("embedded Skill separates creation, publication, schedules and retained-state recovery", () => {
  const skill = ADMIN_SKILL_FILES["SKILL.md"];
  expect(skill).toContain("v0.8.2");
  expect(skill).toContain("castloop --version");
  expect(skill).not.toContain("この開発版");
  expect(skill).not.toContain("毎回`--workspace");
  expect(skill).toContain("1プロセス");
  expect(skill).toContain("Cloudflare Access");
  expect(skill).toContain("`scheduled`");
  expect(skill).toContain("`dispatched`");
  expect(skill).toContain("`next_cursor`");
  expect(skill).not.toContain("一覧は20件ごと");

  const setup = ADMIN_SKILL_FILES["references/setup.md"];
  expect(setup).toContain("castloop init ABSOLUTE_PATH");
  expect(setup).toContain("初回の作成用フラグを付け直さない");
  const publish = ADMIN_SKILL_FILES["references/publish.md"];
  expect(publish).toContain("新規Episodeだけ");
  expect(publish).toContain("approval_sha256");
  expect(publish).toContain("--rss-output");
  expect(publish).toContain("新規ファイル");
  const recovery = ADMIN_SKILL_FILES["references/recovery.md"];
  expect(recovery).toContain("domain status UUID");
  expect(recovery).toContain("domain continue UUID");
  expect(recovery).toContain("バックアップ");
  expect(recovery).toContain("自動継続しない");
});
