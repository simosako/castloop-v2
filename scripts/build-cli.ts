import { WORKER_COMPATIBILITY_DATE } from "../packages/cli/src/worker-payload";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir(),
  "castloop-worker-"));

try {
  const workerOutput = join(temporary, "worker");
  const config = join(temporary, "wrangler.jsonc");
  writeFileSync(config, JSON.stringify({
    name: "castloop-bundle", main: join(root, "src/index.ts"),
    compatibility_date: WORKER_COMPATIBILITY_DATE,
    cache: { enabled: true },
  }) + "\n");
  execFileSync(join(root, "node_modules/.bin/wrangler"),
    ["deploy", "--config", config, "--dry-run", "--minify", "--outdir", workerOutput],
    { cwd: root, stdio: "pipe", timeout: 120000 });
  const source = readFileSync(join(workerOutput, "index.js"), "utf8")
    .replace(/\n\/\/# sourceMappingURL=.*\n?$/, "\n");

  mkdirSync(join(root, "dist"), { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(root, "packages/cli/src/index.ts")],
    compile: { outfile: join(root, "dist/castloop"), autoloadDotenv: false, autoloadBunfig: false },
    env: "disable",
    plugins: [{
      name: "castloop-worker-bundle",
      setup(build) {
        build.onLoad({ filter: /worker-payload\.ts$/ }, () => ({
          contents: `export const WORKER_COMPATIBILITY_DATE = ${JSON.stringify(WORKER_COMPATIBILITY_DATE)};\n` +
            `export const embeddedWorkerSource = ${JSON.stringify(source)};\n`,
          loader: "ts",
        }));
      },
    }],
  });
  if (!result.success) throw new Error("Bun executable build failed");
  console.log("Built dist/castloop");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
