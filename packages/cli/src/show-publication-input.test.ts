import { afterEach, expect, test } from "bun:test";
import { parseShowMetadata, stringifyToml } from "@castloop/shared";
import { readShowPublicationInput } from "./show-publication-input";
import { assertLocalStagingSource, freezePayloadSources, inspectLocalStagingSource } from "./staging-sources";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync("/tmp/opencode/castloop-site-css-"); roots.push(root);
  const path = join(root, "show.toml"), css = join(root, "site.css");
  const show = { schema_version: 1 as const, show_id: "daily", title: "Daily", description: "Description", language: "ja",
    author: "Author", owner_name: "Owner", owner_email: "owner@example.com", categories: ["Technology"], explicit: false,
    image_path: "cover.jpg", site_mode: "builtin" as const, site_css_path: "site.css" };
  writeFileSync(path, stringifyToml(show)); writeFileSync(css, ":root{--cl-accent:red}\r\n");
  return { root, path, css, show };
}

test("Show publication freezes normalized CSS without editing the local TOML", async () => {
  const f = fixture(), original = readFileSync(f.path);
  const bytes = await readShowPublicationInput(f.path);
  expect(parseShowMetadata(bytes.toString()).site_css).toBe(":root{--cl-accent:red}\n");
  expect(readFileSync(f.path)).toEqual(original);
  const { payload } = await inspectLocalStagingSource(f.path, "show_metadata");
  const sources = await freezePayloadSources(f.root, [payload], [f.path]);
  try {
    await sources.withPayload(0, async (body, consumed) => {
      expect(Buffer.from(await new Response(body).arrayBuffer()).equals(bytes)).toBe(true); consumed();
    });
    writeFileSync(f.css, "body{color:blue}");
    await expect(sources.assertCurrent()).rejects.toThrow("differs");
    await expect(assertLocalStagingSource(f.path, payload)).rejects.toThrow("differs");
  } finally { await sources.dispose(); }
});

test("CSS input rejects missing, symlink, invalid, oversized and unsafe files; empty CSS is allowed", async () => {
  const f = fixture();
  for (const css of [Buffer.from([0xff]), Buffer.from("x".repeat(65_537)), Buffer.from("/* </sTyLe */"), Buffer.from([0])]) {
    writeFileSync(f.css, css); await expect(readShowPublicationInput(f.path)).rejects.toThrow();
  }
  writeFileSync(f.css, ""); expect(parseShowMetadata((await readShowPublicationInput(f.path)).toString()).site_css).toBe("");
  rmSync(f.css); await expect(readShowPublicationInput(f.path)).rejects.toThrow();
  symlinkSync(f.path, f.css); await expect(readShowPublicationInput(f.path)).rejects.toThrow();
  for (const path of ["../site.css", "https://example.com/site.css", "/site.css"]) {
    expect(() => parseShowMetadata(stringifyToml({ ...f.show, site_css_path: path }))).toThrow();
  }
  writeFileSync(f.path, stringifyToml({ ...f.show, site_css: "body{}" }));
  await expect(readShowPublicationInput(f.path)).rejects.toThrow("not inline");
});
