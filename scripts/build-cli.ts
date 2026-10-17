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
const requestedTarget = args[0];
if (args.length > 1 || (requestedTarget !== undefined && !Object.hasOwn(TARGETS, requestedTarget))) {
  throw new Error(`Usage: bun scripts/build-cli.ts [${Object.keys(TARGETS).join(" | ")}]`);
}
const target = requestedTarget as keyof typeof TARGETS | undefined;
const outfile = join(root, "dist", target
  ? `castloop-${target}${target === "windows-x64" ? ".exe" : ""}` : "castloop");
const worker = await Bun.build({ entrypoints: [join(root, "src/worker.ts")],
  target: "browser", minify: true, external: ["cloudflare:workers"] });
if (!worker.success || worker.outputs.length !== 1) throw new Error("Worker bundle build failed");
const source = await worker.outputs[0].text();
const sqliteWorker = await Bun.build({ entrypoints: [join(root, "src/sqlite-worker.ts")], target: "browser", minify: true, external: ["cloudflare:workers"] });
if (!sqliteWorker.success || sqliteWorker.outputs.length !== 1) throw new Error("SQLite Worker bundle build failed");
const sqliteSource = await sqliteWorker.outputs[0].text();
mkdirSync(join(root, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [join(root, "packages/cli/src/index.ts")],
  compile: { outfile, ...(target ? { target: TARGETS[target] } : {}),
    autoloadDotenv: false, autoloadBunfig: false },
  env: "disable",
  plugins: [{
    name: "castloop-worker-bundle",
    setup(build) {
      build.onLoad({ filter: /worker-payload\.ts$/ }, () => ({
        contents: `export const WORKER_COMPATIBILITY_DATE = ${JSON.stringify(M6_FRESH_WORKER_COMPATIBILITY_DATE)};\n` +
          `export const embeddedWorkerSource = ${JSON.stringify(source)};\n` +
          `export const embeddedSqliteWorkerSource = ${JSON.stringify(sqliteSource)};\n`,
        loader: "ts",
      }));
    },
  }],
});
if (!result.success) throw new Error("Bun executable build failed");
console.log(`Built ${outfile}`);
