import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("release workflow remote Actions use full commit SHAs instead of mutable tags", () => {
  const source = readFileSync(join(import.meta.dir, "../.github/workflows/build-binaries.yml"), "utf8");
  const uses = source.split("\n").filter((line) => /^\s*-\s*uses:/.test(line));
  expect(uses.length).toBeGreaterThan(0);
  for (const line of uses) expect(line).toMatch(/^\s*- uses: [\w.-]+\/[\w./-]+@[a-f0-9]{40} # v\d+\.\d+\.\d+$/);
});
