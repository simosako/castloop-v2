import { expect, test } from "bun:test";
import { parseShowMetadata, stringifyToml } from "@castloop/shared";
import { inputTemplate, showTemplate } from "./input-templates";
import { loadLocalInput, validateLocalInput } from "./local-input";
import { diagnoseLocal, formatDoctor } from "./doctor";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("embedded templates and documented examples use the same input validators", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-templates-");
  try {
    for (const kind of ["service-config", "admin-config", "show", "episode"]) {
      const file = join(root, `${kind}.toml`); writeFileSync(file, inputTemplate(kind));
      const result = await validateLocalInput(kind === "service-config" ? "service" : kind, file, {});
      expect(result.checks[0]).toEqual({ id: "metadata", status: "pass" });
      expect(result.publication_ready).toBe(false);
    }
    for (const kind of ["show", "episode"]) {
      for (const path of [`design/${kind}-template.toml`, `examples/${kind}.toml`]) {
        const file = join(import.meta.dir, "../../..", path);
        const result = await validateLocalInput(kind, file, {});
        expect(result.checks[0]).toEqual({ id: "metadata", status: "pass" });
        expect(result.publication_ready).toBe(false);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Show examples match the builtin creation default and support the documented site alternatives", async () => {
  const root = mkdtempSync("/tmp/opencode/castloop-site-templates-");
  try {
    const css = readFileSync(join(import.meta.dir, "../../../examples/show-site.css"), "utf8");
    writeFileSync(join(root, "site.css"), css);
    const sources = [inputTemplate("show"), ...["design/show-template.toml", "examples/show.toml"].map((path) =>
      readFileSync(join(import.meta.dir, "../../..", path), "utf8"))];
    for (const source of sources) {
      const show = parseShowMetadata(source);
      expect(show.site_mode).toBe(showTemplate(show.show_id).site_mode);
      expect(show.site_url).toBeUndefined();
      expect(show.site_css).toBeUndefined();
      const file = join(root, "show.toml");
      writeFileSync(file, stringifyToml({ ...show, site_timezone: "Asia/Tokyo", site_css_path: "site.css" }));
      const builtin = await loadLocalInput("show", file);
      expect(builtin.value).toMatchObject({ site_mode: "builtin", site_timezone: "Asia/Tokyo", site_css: css });
      writeFileSync(file, stringifyToml({ ...show, site_mode: "external", site_url: "https://example.com/podcast" }));
      expect((await validateLocalInput("show", file, {})).checks[0]?.status).toBe("pass");
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
