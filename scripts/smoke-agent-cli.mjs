import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(process.env.CASTLOOP_TEST_TMP ?? tmpdir(), "castloop-binary-agent-"));
try {
  const binary = join(root, "castloop");
  copyFileSync(resolve(process.argv[2] ?? "dist/castloop"), binary);
  const work = join(root, "empty"); mkdirSync(work);
  function run(args, expected = 0) {
    const child = spawnSync(binary, args, { cwd: work, env: { PATH: "", HOME: work }, encoding: "utf8" });
    assert.equal(child.status, expected, child.stderr || child.stdout);
    return child.stdout;
  }
  assert.equal(JSON.parse(run(["describe", "--json"])).contract_version, 1);
  for (const name of ["service-config", "show-input", "episode-input", "result"]) {
    assert.equal(JSON.parse(run(["schema", name])).additionalProperties, false);
  }
  assert.deepEqual(readdirSync(work), []);
  for (const [kind, file] of [["service-config", "castloop.toml"], ["show", "show.toml"], ["episode", "episode.toml"]]) {
    writeFileSync(join(work, file), run(["template", kind]));
    assert.equal(JSON.parse(run(["validate", kind === "service-config" ? "service" : kind, file, "--json"])).ok, true);
  }
  writeFileSync(join(work, "cover.jpg"), Buffer.from([255, 216, 255, 2]));
  writeFileSync(join(work, "audio.mp3"), Buffer.concat(Array(50).fill(Buffer.concat([Buffer.from([255, 251, 144, 100]), Buffer.alloc(413)]))));
  run(["validate", "show", "show.toml", "--assets", "--json"]);
  run(["validate", "episode", "episode.toml", "--audio", "audio.mp3", "--json"]);
  const doctor = JSON.parse(run(["doctor", "--local", "--workspace", work, "--json"]));
  assert.equal(doctor.result.summary.fail, 0);
  assert.equal(doctor.result.checks.find((check) => check.id === "remote").status, "not_checked");
  assert.match(run(["doctor", "--local", "--workspace", work]), /Summary: .*0 fail/);
  assert.equal(readdirSync(work).includes(".castloop"), false);
  const showDirectory = join(work, "samplepodcast"); mkdirSync(showDirectory);
  copyFileSync(join(work, "show.toml"), join(showDirectory, "show.toml"));
  const preview = JSON.parse(run(["preview-show", "samplepodcast", "--workspace", work, "--json"]));
  assert.equal(preview.result.state, "local_only");
  assert.equal(preview.result.published.status, "not_checked");
  assert.equal(readdirSync(work).includes(".castloop"), false);
  const skill = join(work, "skill"); run(["skill", "export", "castloop", "--output", skill, "--json"]);
  for (const file of ["SKILL.md", "references/setup.md", "references/publish.md", "references/recovery.md"]) {
    assert.equal(readFileSync(join(skill, file), "utf8"), readFileSync(join(sourceRoot, "skills/castloop", file), "utf8"));
  }
  assert.equal(JSON.parse(run(["skill", "export", "castloop", "--output", skill, "--json"], 1)).error.code, "destination_exists");
  writeFileSync(join(work, "bad.toml"), 'owner_email = "never-echo@example.com"\nunknown =');
  const error = run(["validate", "show", "bad.toml", "--json"], 1);
  assert.equal(error.includes("never-echo@example.com"), false);
  assert.equal(JSON.parse(error).error.outcome, "not_started");
  console.log("Standalone agent smoke checks passed (empty PATH, no source/runtime dependencies).");
} finally { rmSync(root, { recursive: true, force: true }); }
