import skill from "../../../skills/castloop/SKILL.md" with { type: "text" };
import setup from "../../../skills/castloop/references/setup.md" with { type: "text" };
import publish from "../../../skills/castloop/references/publish.md" with { type: "text" };
import recovery from "../../../skills/castloop/references/recovery.md" with { type: "text" };
import { AgentError } from "./agent-output";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const ADMIN_SKILL_FILES = { "SKILL.md": skill, "references/setup.md": setup,
  "references/publish.md": publish, "references/recovery.md": recovery };

function realDirectory(path: string): void {
  try {
    if (!lstatSync(path).isDirectory()) throw new AgentError("unsafe_destination", "Skill parent must be a real directory, not a symlink.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    realDirectory(dirname(path)); mkdirSync(path, { mode: 0o700 });
  }
}

export function exportAdminSkill(output: string) {
  const destination = resolve(output);
  realDirectory(dirname(destination));
  try { mkdirSync(destination, { mode: 0o700 }); }
  catch { throw new AgentError("destination_exists", "Skill destination must not exist; compare updates separately without overwriting edits."); }
  mkdirSync(join(destination, "references"), { mode: 0o700 });
  for (const [file, text] of Object.entries(ADMIN_SKILL_FILES)) writeFileSync(join(destination, file), text, { flag: "wx", mode: 0o600 });
  return { destination, files: Object.keys(ADMIN_SKILL_FILES) };
}
