import { buildM6WorkerUploadMetadata, parseServiceConfig, showMetadataSchema, validateId } from "@castloop/shared";
import { CloudflareApi } from "./cloudflare-api";
import { readBoundedLocalJournal } from "./local-journal-read";
import { createFreshM6RestEffects } from "./m6-initialization-rest";
import { createM6LocalEpisodeDraft, createM6LocalShowDraft } from "./m6-local-drafts";
import { publishLocalM6Draft, updateLocalM6Draft } from "./m6-local-update";
import { M6ServiceClient } from "./m6-service-client";
import { createFreshM6InitializationJournal, runFreshM6Initialization } from "./m6-service-initialization";
import { createShowRegistrationJournal } from "./show-registration-journal";
import { createShowRegistrationEffects, runShowRegistration } from "./show-registration-operation";
import { TargetInspectionClient } from "./target-inspection-client";
import { embeddedWorkerSource, WORKER_COMPATIBILITY_DATE } from "./worker-payload";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HELP = `Unreleased isolated M6 test binary. Requires castloop.toml in the working directory.
init OPERATION_UUID
service-status | service-pause PAUSE_UUID | service-resume PAUSE_UUID
target-show SHOW_ID | target-episode SHOW_ID EPISODE_ID
create-show SHOW_ID SITE_URL | create-episode SHOW_ID EPISODE_ID
update-show SHOW_ID | update-episode SHOW_ID EPISODE_ID
update-episode-audio SHOW_ID EPISODE_ID MP3_PATH
publish-show SHOW_ID | publish-episode SHOW_ID EPISODE_ID MP3_PATH
No production release, adoption, deletion, automatic resume or unknown-outcome replay.`;

function argumentsFor(args: string[], count: number): void {
  if (args.length !== count || args.some((arg) => !arg || arg.startsWith("--"))) throw new Error("Invalid test command arguments; use --help");
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") { console.log(HELP); return; }
  const counts: Record<string, number> = { init: 1, "service-status": 0, "service-pause": 1, "service-resume": 1,
    "target-show": 1, "target-episode": 2,
    "create-show": 2, "create-episode": 2, "update-show": 1, "update-episode": 2, "update-episode-audio": 3, "publish-show": 1, "publish-episode": 3 };
  if (!Object.hasOwn(counts, command)) throw new Error("Unknown test command; use --help");
  argumentsFor(args, counts[command]!);
  const root = process.cwd();
  if (!lstatSync(root).isDirectory()) throw new Error("Test workspace must be a real directory");
  const config = parseServiceConfig(readFileSync(join(root, "castloop.toml"), "utf8"));
  if (!config.service_id.startsWith("m6-test-") || [config.worker_name, config.bucket_name, config.queue_name, config.dlq_name]
    .some((name) => !name.startsWith("castloop-m6-test-"))) throw new Error("Only explicitly named isolated M6 test resources are permitted");
  const directory = join(root, ".castloop");
  const secretFile = join(directory, "secrets.json");
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new Error("Test state parent must not be a symlink");
  if (command === "init") {
    if (!embeddedWorkerSource) throw new Error("Build the standalone --m6-test binary before initialization");
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error("Test state parent must not be a symlink");
    if (!existsSync(secretFile)) {
      const fd = openSync(secretFile, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ CASTLOOP_ADMIN_KEY: randomBytes(32).toString("hex") })); fsyncSync(fd); }
      finally { closeSync(fd); }
      const parent = openSync(directory, "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
  }
  const secret = readBoundedLocalJournal(secretFile);
  if (!secret || typeof secret !== "object" || !("CASTLOOP_ADMIN_KEY" in secret) || typeof secret.CASTLOOP_ADMIN_KEY !== "string") throw new Error("Missing local administrator key");
  const key = secret.CASTLOOP_ADMIN_KEY;
  if (command === "init") {
    const source = embeddedWorkerSource!;
    const metadata = buildM6WorkerUploadMetadata(config, null, key, WORKER_COMPATIBILITY_DATE);
    const journal = await createFreshM6InitializationJournal(root, config, args[0]!, source, metadata);
    await runFreshM6Initialization(journal, createFreshM6RestEffects(new CloudflareApi(config), key), source, metadata);
    console.log(JSON.stringify({ result: "initialized-paused", operation_id: args[0], runtime_readiness: journal.load().runtime_readiness }));
    return;
  }
  if (command.startsWith("service-")) {
    const action = command.slice("service-".length) as "status" | "pause" | "resume";
    const client = new M6ServiceClient(config, key);
    const response = await client.call(action === "status" ? { service_id: config.service_id, action } : { service_id: config.service_id, action, pause_id: args[0]! });
    console.log(JSON.stringify(response));
    return;
  }
  const showId = validateId(args[0]!, "show");
  if (command.startsWith("target-")) {
    const target = command === "target-show" ? { kind: "show" as const, show_id: showId } :
      { kind: "episode" as const, show_id: showId, episode_id: validateId(args[1]!, "episode") };
    console.log(JSON.stringify(await new TargetInspectionClient(config, key).inspect({ schema_version: 1, service_id: config.service_id, ...target })));
    return;
  }
  if (command === "create-show") {
    showMetadataSchema.shape.site_url.parse(args[1]);
    if (existsSync(join(root, showId))) throw new Error("Local Show directory already exists; do not create another registration");
    const reserve = { schema_version: 1 as const, action: "reserve" as const, service_id: config.service_id, show_id: showId,
      reservation_id: crypto.randomUUID() };
    const journal = createShowRegistrationJournal(root, config, reserve);
    await runShowRegistration(journal, createShowRegistrationEffects(config, key));
    console.log(await createM6LocalShowDraft(root, config, showId, args[1]!));
    return;
  }
  const episodeId = command.endsWith("show") ? undefined : validateId(args[1]!, "episode");
  if (command === "create-episode") { console.log(await createM6LocalEpisodeDraft(root, config, showId, episodeId!)); return; }
  const target = episodeId ? { kind: "episode" as const, show_id: showId, episode_id: episodeId } : { kind: "show" as const, show_id: showId };
  if (command.startsWith("publish-")) {
    const state = await publishLocalM6Draft(root, config, target, key, args[2] ? { audioPath: resolve(args[2]) } : {});
    console.log(JSON.stringify({ result: "publication-committed", job_id: state.publication.request.job_id }));
    return;
  }
  const state = await updateLocalM6Draft(root, config, target, command === "update-show" ? { asset: "show" } : command === "update-episode" ?
    { asset: "episode_metadata" } : { asset: "audio", audio_path: resolve(args[2]!) }, key, {
      rest: { accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" },
    });
  if (state.finish_receipt !== "staged") throw new Error("Staging was explicitly aborted; its receipt was retained and publication was not authorized");
  console.log(JSON.stringify({ result: "staged", operation_id: state.upload.operation_id }));
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "M6 test command failed");
  console.error("M6 test command did not complete. Preserve journals, locks and remote owners; do not automatically replay unknown requests.");
  process.exitCode = 1;
});
