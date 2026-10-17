import { expect, test } from "bun:test";
import { protectLocalState } from "./workspace-protection";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("workspace protection creates private ignore rules and preserves existing CRLF and missing final newline", () => {
  for (const source of [undefined, "user-file\r\n!.castloop/\r\n!*.mp3", ".castloop/\n*.mp3\n"]) {
    const root = mkdtempSync("/tmp/opencode/castloop-workspace-protection-");
    try {
      const file = join(root, ".gitignore");
      if (source !== undefined) writeFileSync(file, source);
      protectLocalState(root);
      const expected = source === undefined ? ".castloop/\n*.mp3\n" : source.endsWith("*.mp3\n") ? source : `${source}\n.castloop/\n*.mp3\n`;
      expect(readFileSync(file, "utf8")).toBe(expected);
      if (source === undefined) expect(lstatSync(file).mode & 0o777).toBe(0o600);
      protectLocalState(root);
      expect(readFileSync(file, "utf8")).toBe(expected);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("workspace protection never follows a gitignore symlink or grows an oversized file", () => {
  const root = mkdtempSync("/tmp/opencode/castloop-workspace-protection-reject-");
  try {
    const outside = join(root, "outside"), ignore = join(root, ".gitignore");
    writeFileSync(outside, "preserve\n"); symlinkSync(outside, ignore);
    expect(() => protectLocalState(root)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("preserve\n");
    rmSync(ignore);
    writeFileSync(ignore, "x".repeat(1_000_000));
    expect(() => protectLocalState(root)).toThrow("size limit");
    expect(lstatSync(ignore).size).toBe(1_000_000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
