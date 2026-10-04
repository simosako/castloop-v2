import { parseServiceConfig } from "@castloop/shared";
import { M6_COMMAND_ARGUMENTS, runM6Command } from "./m6-commands";
import { M6UpdateClient } from "./m6-update-client";
import { dropSetupCompletion } from "./test-support/drop-setup-completion";
import { embeddedWorkerSource } from "./worker-payload";
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function main(): Promise<unknown> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") return `Isolated M6 test binary; only explicitly named test resources are permitted.\n${Object.keys(M6_COMMAND_ARGUMENTS).join("\n")}\nupdate-service-drop-completion OPERATION_UUID (fault test only)`;
  const root = process.cwd();
  const config = parseServiceConfig(readFileSync(join(root, "castloop.toml"), "utf8"));
  if (!config.service_id.startsWith("m6-test-") || [config.worker_name, config.bucket_name, config.queue_name, config.dlq_name]
    .some((name) => !name.startsWith("castloop-m6-test-"))) throw new Error("Only explicitly named isolated M6 test resources are permitted");
  const fault = command === "update-service-drop-completion";
  return runM6Command(root, config, fault ? "update-service" : command, args, {
    workerSource: async () => {
      if (!embeddedWorkerSource) throw new Error("Build the standalone --m6-test binary before initialization or update");
      return embeddedWorkerSource;
    },
    ...(fault ? { updateClient: (api, key) => new M6UpdateClient(config, key, api, dropSetupCompletion()) } : {}),
  });
}

try {
  const result = await main();
  console.log(typeof result === "string" ? result : JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : "M6 test command failed");
  console.error("Preserve journals, locks and remote owners; do not automatically replay unknown requests.");
  process.exitCode = 1;
}
