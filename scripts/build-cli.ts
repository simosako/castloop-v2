import { WORKER_COMPATIBILITY_DATE } from "../packages/cli/src/worker-payload";
import { M6_FRESH_WORKER_COMPATIBILITY_DATE } from "../packages/shared/src/index";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = {
  "linux-x64": "bun-linux-x64",
  "macos-x64": "bun-darwin-x64",
  "macos-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64",
} as const;
const args = process.argv.slice(2);
const m6Test = args.includes("--m6-test");
const targets = args.filter((argument) => argument !== "--m6-test");
const requestedTarget = targets[0];
if (args.length > 2 || targets.length > 1 || args.filter((argument) => argument === "--m6-test").length > 1 || (requestedTarget && !(requestedTarget in TARGETS))) {
  throw new Error(`Usage: bun scripts/build-cli.ts [${Object.keys(TARGETS).join(" | ")}] [--m6-test]`);
}
const target = requestedTarget as keyof typeof TARGETS | undefined;
const name = m6Test ? "castloop-m6-test" : "castloop";
const outfile = join(root, "dist", target
  ? `${name}-${target}${target === "windows-x64" ? ".exe" : ""}` : name);
const worker = await Bun.build({ entrypoints: [join(root, m6Test ? "src/m6-setup-worker.ts" : "src/index.ts")],
  target: "browser", minify: true, external: ["cloudflare:workers"] });
if (!worker.success || worker.outputs.length !== 1) throw new Error("Worker bundle build failed");
const source = await worker.outputs[0].text();
mkdirSync(join(root, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, m6Test ? "packages/cli/src/m6-test-cli.ts" : "packages/cli/src/index.ts")],
  compile: { outfile, ...(target ? { target: TARGETS[target] } : {}),
    autoloadDotenv: false, autoloadBunfig: false },
  env: "disable",
  plugins: [{
    name: "castloop-worker-bundle",
    setup(build) {
      build.onLoad({ filter: /worker-payload\.ts$/ }, () => ({
        contents: `export const WORKER_COMPATIBILITY_DATE = ${JSON.stringify(m6Test ? M6_FRESH_WORKER_COMPATIBILITY_DATE : WORKER_COMPATIBILITY_DATE)};\n` +
          `export const embeddedWorkerSource = ${JSON.stringify(source)};\n`,
        loader: "ts",
      }));
    },
  }],
});
if (!result.success) throw new Error("Bun executable build failed");
console.log(`Built ${outfile}`);
