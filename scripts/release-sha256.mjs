import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

// Prints one "<sha256>  <basename>" line in sha256sum --check format so every
// release platform can produce identical SHA256SUMS entries without relying on
// GNU coreutils being present (macOS has no sha256sum).
const file = process.argv[2];
if (process.argv.length !== 3 || file === undefined) {
  throw new Error("Usage: node scripts/release-sha256.mjs FILE");
}
const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
console.log(`${digest}  ${basename(file)}`);
