import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

async function run(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
    cwd, env: { PATH: "", HOME: process.env.HOME }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("offline discovery and validation never create state or expose input errors", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-agent-");
  try {
    for (const args of [["describe", "--json"], ["schema", "show-input"]]) expect((await run(args, root)).code).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    writeFileSync(join(root, "episode.toml"), 'schema_version = 1\nepisode_id = "first"\nguid = "saved-guid"\ntitle = "Title"\ndescription = "Description"\npublished_at = "2026-10-22T10:00:00+09:00"\n');
    const good = await run(["validate", "episode", "episode.toml", "--json"], root);
    expect(good.code).toBe(0); expect(JSON.parse(good.stdout)).toMatchObject({ ok: true, result: { publication_ready: false } });
    writeFileSync(join(root, "bad.toml"), 'owner_email = "private@example.com"\nunknown = ');
    const bad = await run(["validate", "show", "bad.toml", "--json"], root);
    expect(bad.code).toBe(1); expect(bad.stdout).not.toContain("private@example.com"); expect(bad.stderr).toBe("");
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: { outcome: "not_started", code: "invalid_input" } });
    expect(existsSync(join(root, ".castloop"))).toBe(false);
    const init = await run(["init", "new", "--non-interactive", "--json"], root);
    expect(init.code).toBe(1); expect(existsSync(join(root, "new"))).toBe(false);
    const badId = await run(["init", "bad-id", "--operation-id", "not-a-uuid", "--non-interactive", "--json"], root);
    expect(badId.code).toBe(1); expect(existsSync(join(root, "bad-id"))).toBe(false);
    const mismatch = await run(["init", "new", "--workspace", join(root, "other"), "--json"], root);
    expect(JSON.parse(mismatch.stdout).error.code).toBe("target_mismatch");
    const missing = await run(["publish-episode", "first", "--workspace", root, "--json"], root);
    expect(JSON.parse(missing.stdout).error.code).toBe("missing_show");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("offline validation uses input limits and reports safe field paths", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-agent-limits-");
  try {
    const base = 'schema_version = 1\nepisode_id = "first"\nguid = "saved-guid"\ntitle = "Title"\npublished_at = "2026-10-22T10:00:00Z"\n';
    writeFileSync(join(root, "episode.toml"), base + `description = "${"😀".repeat(10000)}"\n`);
    expect((await run(["validate", "episode", "episode.toml", "--json"], root)).code).toBe(0);
    writeFileSync(join(root, "episode.toml"), base + `description = "${"😀".repeat(10001)}"\n`);
    const result = await run(["validate", "episode", "episode.toml", "--json"], root);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).error.fields).toContainEqual({ path: ["description"], code: "custom" });
    expect(readdirSync(root)).toEqual(["episode.toml"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
