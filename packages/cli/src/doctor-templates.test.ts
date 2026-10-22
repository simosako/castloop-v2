import { expect, test } from "bun:test";
import { inputTemplate } from "./input-templates";
import { validateLocalInput } from "./local-input";
import { diagnoseLocal, formatDoctor } from "./doctor";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("embedded templates and documented examples use the same input validators", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-templates-");
  try {
    for (const kind of ["service-config", "show", "episode"]) {
      const file = join(root, `${kind}.toml`); writeFileSync(file, inputTemplate(kind));
      expect((await validateLocalInput(kind === "service-config" ? "service" : kind, file, {})).publication_ready).toBe(false);
    }
    for (const kind of ["show", "episode"]) {
      const file = join(root, `${kind}.toml`);
      writeFileSync(file, readFileSync(join(import.meta.dir, `../../../design/${kind}-template.toml`), "utf8"));
      expect((await validateLocalInput(kind, file, {})).checks[0]?.status).toBe("pass");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor uses identical compact human/JSON checks without creating missing state", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-doctor-");
  try {
    let result = await diagnoseLocal(root, {});
    expect(result.summary.fail).toBe(1); expect(readdirSync(root)).toEqual([]);
    writeFileSync(join(root, "castloop.toml"), inputTemplate("service-config"));
    result = await diagnoseLocal(root, {});
    expect(result.summary.fail).toBe(0);
    for (const check of result.checks) expect(formatDoctor(result)).toContain(check.message);
    expect(result.checks.find((check) => check.id === "remote")?.status).toBe("not_checked");
    expect(readdirSync(root)).toEqual(["castloop.toml"]);
    expect(JSON.stringify(result)).not.toContain("owner@example.com");
    const mismatch = await diagnoseLocal(root, { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "never-echo-token" });
    expect(mismatch.summary.fail).toBe(1);
    expect(JSON.stringify(mismatch)).not.toContain("never-echo-token");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
