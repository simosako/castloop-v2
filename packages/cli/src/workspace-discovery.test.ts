import { expect, test } from "bun:test";
import { stringifyToml } from "@castloop/shared";
import { episodeTemplate, inputTemplate, showTemplate } from "./input-templates";
import { TEST_COVER_JPEG } from "./test-support/media";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const entrypoint = join(import.meta.dir, "index.ts");

function workspace(root: string): void {
  mkdirSync(join(root, "daily"), { recursive: true });
  writeFileSync(join(root, "castloop.toml"), inputTemplate("service-config"));
  writeFileSync(join(root, "daily", "show.toml"), stringifyToml(showTemplate("daily")));
  writeFileSync(join(root, "daily", "cover.jpg"), TEST_COVER_JPEG);
  writeFileSync(join(root, "daily", "episode-first.toml"),
    stringifyToml(episodeTemplate("first", "saved-guid", "2026-01-02T10:00:00Z")));
}

function command(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, entrypoint, ...args, "--json"], {
    cwd, env: { PATH: "", HOME: process.env.HOME }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  expect(result.stderr.toString()).toBe("");
  return { code: result.exitCode, output: JSON.parse(result.stdout.toString()) };
}

test("workspace discovery resolves local previews at the workspace, Show and nested directories", () => {
  const temp = mkdtempSync("/tmp/opencode/castloop-workspace-discovery-");
  try {
    const root = join(temp, "workspace"), show = join(root, "daily"), nested = join(show, "drafts", "audio");
    workspace(root); mkdirSync(nested, { recursive: true });
    for (const cwd of [root, show, nested]) {
      const result = command(cwd, "preview-show", "daily", "--local");
      expect(result.code).toBe(0);
      expect(result.output).toMatchObject({ ok: true, target: { workspace: root }, result: { target: { show_id: "daily" } } });
    }
    for (const cwd of [show, nested]) {
      const result = command(cwd, "preview-episode", "first", "--local");
      expect(result.code).toBe(0);
      expect(result.output).toMatchObject({ ok: true, target: { workspace: root, show_id: "daily" },
        result: { target: { kind: "episode", show_id: "daily", episode_id: "first" } } });
    }
    expect(command(root, "preview-episode", "first", "--local").output.error.code).toBe("missing_show");
    expect(command(root, "preview-episode", "first", "--show", "daily", "--local").code).toBe(0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("workspace discovery includes the fifth parent but not the sixth", () => {
  const temp = mkdtempSync("/tmp/opencode/castloop-workspace-depth-");
  try {
    const root = join(temp, "workspace"), fifth = join(root, "a", "b", "c", "d", "e"), sixth = join(fifth, "f");
    workspace(root); mkdirSync(sixth, { recursive: true });
    const found = command(fifth, "preview-show", "daily", "--local");
    expect(found.code).toBe(0);
    expect(found.output.target.workspace).toBe(root);
    const missing = command(sixth, "preview-show", "daily", "--local");
    expect(missing.code).toBe(1);
    expect(missing.output).toMatchObject({ ok: false, error: { code: "missing_workspace", outcome: "not_started" } });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("explicit workspace and Show select only the requested target", () => {
  const temp = mkdtempSync("/tmp/opencode/castloop-workspace-explicit-");
  try {
    const root = join(temp, "one"), other = join(temp, "two"), nested = join(root, "daily", "drafts");
    workspace(root); workspace(other); mkdirSync(nested);
    const explicit = command(nested, "preview-episode", "first", "--workspace", other, "--show", "daily", "--local");
    expect(explicit.code).toBe(0);
    expect(explicit.output.target).toMatchObject({ workspace: other, show_id: "daily" });
    expect(command(nested, "preview-episode", "first", "--workspace", other, "--local").output.error.code).toBe("missing_show");
    const absent = command(nested, "preview-show", "daily", "--workspace", join(temp, "missing"), "--local");
    expect(absent.code).toBe(1);
    expect(absent.output.target.workspace).toBe(join(temp, "missing"));
    expect(command(nested, "preview-episode", "first", "--show", "daily", "--local").code).toBe(0);
    mkdirSync(join(root, "weekly"));
    writeFileSync(join(root, "weekly", "episode-first.toml"),
      stringifyToml(episodeTemplate("first", "weekly-guid", "2026-01-02T10:00:00Z")));
    const differentShow = command(nested, "preview-episode", "first", "--show", "weekly", "--local");
    expect(differentShow.code).toBe(0);
    expect(differentShow.output.target).toMatchObject({ workspace: root, show_id: "weekly" });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("workspace discovery selects the nearest valid nested workspace", () => {
  const temp = mkdtempSync("/tmp/opencode/castloop-workspace-nested-");
  try {
    const root = join(temp, "outer"), inner = join(root, "inner"), cwd = join(inner, "daily");
    workspace(root); workspace(inner);
    const result = command(cwd, "preview-show", "daily", "--local");
    expect(result.code).toBe(0);
    expect(result.output.target.workspace).toBe(inner);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("the nearest invalid configuration never falls back to another workspace", () => {
  const temp = mkdtempSync("/tmp/opencode/castloop-workspace-nearest-");
  try {
    const root = join(temp, "workspace"), inner = join(root, "daily"), cwd = join(inner, "drafts");
    workspace(root); mkdirSync(cwd);
    writeFileSync(join(inner, "castloop.toml"), "schema_version = 1\n");
    const legacy = command(cwd, "preview-show", "daily", "--local");
    expect(legacy.code).toBe(1);
    expect(legacy.output).toMatchObject({ ok: false, target: { workspace: inner }, error: { outcome: "not_started" } });
    rmSync(join(inner, "castloop.toml"));
    symlinkSync(join(inner, "missing-config"), join(inner, "castloop.toml"));
    const link = command(cwd, "preview-show", "daily", "--local");
    expect(link.code).toBe(1);
    expect(link.output).toMatchObject({ ok: false, target: { workspace: inner }, error: { outcome: "not_started" } });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("implicit Show selection requires matching local identity before remote operations", () => {
  const temp = mkdtempSync("/tmp/opencode/castloop-workspace-show-");
  try {
    const root = join(temp, "workspace"), show = join(root, "daily"), unrelated = join(root, "other");
    workspace(root); mkdirSync(unrelated);
    expect(command(unrelated, "preview-episode", "first", "--local").output.error.code).toBe("missing_show");
    writeFileSync(join(show, "show.toml"), stringifyToml(showTemplate("other")));
    const mismatch = command(show, "create-episode", "first");
    expect(mismatch.code).toBe(1);
    expect(mismatch.output).toMatchObject({ ok: false, error: { code: "target_mismatch", outcome: "not_started" } });
    expect(command(show, "preview-episode", "first", "--show", "daily", "--local").code).toBe(0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("init, doctor and schedule-time retain their current-directory behavior", () => {
  const temp = mkdtempSync("/tmp/opencode/castloop-workspace-offline-");
  try {
    const root = join(temp, "workspace"), cwd = join(root, "daily", "drafts");
    workspace(root); mkdirSync(cwd);
    const init = command(cwd, "init", "--non-interactive");
    expect(init.output).toMatchObject({ ok: false, target: { workspace: cwd }, error: { code: "missing_input", outcome: "not_started" } });
    expect(existsSync(join(cwd, "castloop.toml"))).toBe(false);
    expect(command(cwd, "doctor", "--local").output.target.workspace).toBe(cwd);
    const time = command(cwd, "preview-schedule-time", "2026-12-01T09:00:00");
    expect(time.code).toBe(0);
    expect(time.output.target.workspace).toBe(cwd);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("backup-create discovers its workspace but resolves output and passphrase paths from cwd", () => {
  const temp = mkdtempSync("/tmp/opencode/castloop-workspace-backup-");
  try {
    const root = join(temp, "workspace"), cwd = join(root, "daily", "drafts");
    workspace(root); mkdirSync(cwd);
    writeFileSync(join(cwd, "passphrase.txt"), "test-passphrase\n");
    const result = command(cwd, "backup-create", "--output", "backup.clbk", "--passphrase-file", "passphrase.txt", "--non-interactive");
    expect(result.code).toBe(0);
    expect(result.output).toMatchObject({ ok: true, target: { workspace: root }, result: { archive: join(cwd, "backup.clbk") } });
    expect(existsSync(join(cwd, "backup.clbk"))).toBe(true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

if (process.platform !== "win32") test("interactive output identifies the discovered workspace without changing JSON output", async () => {
  const temp = mkdtempSync("/tmp/opencode/castloop-workspace-terminal-");
  try {
    const root = join(temp, "workspace"), cwd = join(root, "daily");
    workspace(root);
    for (const json of [false, true]) {
      let text = "";
      const child = Bun.spawn([process.execPath, entrypoint, "preview-show", "daily", "--local", ...(json ? ["--json"] : [])], {
        cwd, env: { PATH: "", HOME: process.env.HOME }, terminal: { data(_terminal, data) { text += data.toString(); } },
      });
      try {
        expect(await child.exited).toBe(0);
        if (json) expect(JSON.parse(text).target.workspace).toBe(root);
        else {
          expect(text).toContain(`Workspace: ${root}`);
          expect(text).toContain("Service: sample");
          expect(text).toContain('"show_id": "daily"');
        }
      } finally { child.terminal?.close(); }
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
