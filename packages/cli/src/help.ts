import { SQLITE_COMMAND_ARGUMENTS } from "./sqlite-commands";

type CommandHelp = { usage: string; description: string };

export const COMMAND_HELP: Record<string, CommandHelp> = {
  domain: { usage: "domain add HOSTNAME --zone-id ZONE_ID [--operation-id UUID] | remove [--operation-id UUID] | list | status UUID [--cursor SHOW_ID] | continue UUID",
    description: "Manage one dedicated custom subdomain in the same account's active/full Cloudflare DNS zone. Registrar transfer is not required.\n" +
      "add/remove require every Show explicitly paused and drained. They redeploy the same Worker with a new canonical origin, regenerate Feeds and purge caches; finish paused.\n" +
      "Public workers.dev URLs redirect to the custom domain (Feed 301, cover/audio 307) only after explicit Show Resume. Administration remains on workers.dev.\n" +
      "list/status are read-only. continue may perform unstarted mutations using exact acknowledged evidence; unknown PUT/POST/DELETE outcomes are never replayed or adopted.\n" +
      "Do not change this hostname's DNS or Worker domain connections with other tools during a domain operation. Certificates are retained on remove.\n" +
      "Removing a domain cannot undo feed URLs saved by podcast apps. Preserve the workspace and journals on interruption; no automatic Resume or rollback." },
  doctor: { usage: "doctor [--local] [--workspace PATH] [--json]", description: "Compact offline checks with no writes, key generation, networking or repairs. Warnings alone exit 0; failed checks exit 1. Credential presence is not validity." },
  template: { usage: "template service-config|show|episode", description: "Print an embedded example TOML without IO or registration. Examples are not administrator answers or registered identities; init/create-episode own real resource and GUID generation." },
  "preview-show": { usage: "preview-show ID", description: "Read-only local metadata, staged asset hashes and base identity. Does not fetch published full content or check remote readiness. Review input_fingerprint and use publish-show --expect-preview HASH." },
  "preview-episode": { usage: "preview-episode ID", description: "Read-only local metadata, staged asset hashes and base identity. Requires --show with explicit --workspace. Published full metadata is not fetched. Use publish-episode --expect-preview HASH after approval." },
  skill: { usage: "skill export castloop --output DIRECTORY", description: "Export the embedded administrator Skill without networking or external tools. The destination must not exist; existing Skills and AGENTS.md are never overwritten." },
  validate: { usage: "validate service|show|episode FILE [--assets] [--audio MP3] [--json]", description: "Read-only offline validation using publication input rules. File/audio paths use caller cwd; cover uses the TOML directory. Does not prove remote readiness or publication success." },
  describe: { usage: "describe [COMMAND] [--json]", description: "Read offline command specifications, effects and recovery rules. No credentials or workspace required." },
  schema: { usage: "schema service-config|show-input|episode-input|result [--format json-schema]", description: "Print the embedded JSON Schema. Additional measured constraints require castloop validate; TOML dates must be quoted strings." },
  init: {
    usage: "init [dir] [--publication-protocol sqlite-sequential-v1] [--service-id ID] [--account-id ID] [--bucket-name NAME] [--workers-subdomain NAME] [--operation-id UUID]",
    description: "Create a fresh SQLite service (schema_version=2) by default; no protocol option is required.\n" +
      "--publication-protocol sqlite-sequential-v1 remains optional for existing scripts; no other protocol is supported.\n" +
      "Missing values are prompted on a terminal. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.\n" +
      "Creates a private R2 bucket, Worker and SQLite-backed Durable Object without Queues.\n" +
      "Verifies Alarm/R2/cache/purge readiness. New Shows start paused; use show-resume SHOW NEW_WINDOW_UUID.\n" +
      "Existing resources are never adopted. Service schema_version=1 requires v0.5.x; migration is not provided.",
  },
  "create-show": {
    usage: "create-show ID [--site-url URL]",
    description: "Run from the service workspace. Reserve a Show ID and create its local show.toml.\n" +
      "A real website URL is required (prompted if omitted). Creates a paused Show DO; explicitly show-resume before uploads. Does not publish.",
  },
  "create-episode": {
    usage: "create-episode ID",
    description: "Run from the Show directory. Create a local Episode TOML draft with a GUID and published_at.\n" +
      "This does not upload or publish the Episode.",
  },
  "update-show": {
    usage: "update-show ID",
    description: "Run from the service workspace. Upload verified Show metadata and JPEG/PNG cover to unique private R2 keys.\n" +
      "Requires Cloudflare credentials. Does not publish; use publish-show explicitly.",
  },
  "publish-show": {
    usage: "publish-show ID",
    description: "Run from the service workspace after update-show. Freeze and submit the current draft to the SQLite FIFO.\n" +
      "Waits for the exact job's succeeded status after writes and cache purge. Queued is not publication success.",
  },
  "update-episode": {
    usage: "update-episode ID",
    description: "Run from the Show directory. Upload verified Episode metadata without uploading audio or publishing.\n" +
      "Requires Cloudflare credentials. Old or frozen inputs cannot be silently replaced.",
  },
  "update-episode-audio": {
    usage: "update-episode-audio ID MP3",
    description: "Run from the Show directory. Validate and upload MP3 audio (at most 300,000,000 bytes) to a unique R2 key.\n" +
      "Requires Cloudflare credentials; verifies full readback/hash/size/object identity. Does not publish.",
  },
  "publish-episode": {
    usage: "publish-episode ID [MP3]",
    description: "Run from the Show directory. Freeze and submit staged changes, then wait for succeeded.\n" +
      "Initial publication requires metadata and audio. Metadata-only updates reuse immutable published audio.\n" +
      "An MP3 argument is optional; if supplied it must match the staged source. Unknown submissions are never resent.",
  },
  "job-status": {
    usage: "job-status JOB",
    description: "Run from the service workspace. Read the retained publication/lifecycle job's status.\n" +
      "status.state succeeded proves this operation completed, not global quiescence or recovery authorization.",
  },
  deploy: {
    usage: "deploy [--operation-id UUID]",
    description: "Run from the service workspace. Perform a code-only update of the same config/schema/namespace.\n" +
      "Explicitly pause and drain every Show first. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.\n" +
      "Probes the new runtime and finishes paused. Never adopts resources, converts data or replays an unknown deployment.",
  },
  "init-reconcile": {
    usage: "init-reconcile OPERATION_UUID",
    description: "Read-only reconciliation of an exact retained initialization already completed ready/paused/drained on the server.\n" +
      "Never redeploys, adopts an unknown deployment or replays initialization.",
  },
  "init-continue-verification": {
    usage: "init-continue-verification OPERATION_UUID",
    description: "Continue verification after acknowledged deployment/access configuration, before any setup request.\n" +
      "Requires unchanged frozen source/configuration and a fresh paused runtime.\n" +
      "Never recreates resources, uploads configuration, redeploys, or resends setup.",
  },
  "update-service-verify": {
    usage: "update-service-verify OPERATION_UUID",
    description: "Continue a retained deploy_acknowledged/deployed/verified update with no prior activation request.\n" +
      "Rechecks frozen source/configuration, acknowledged script ETag, pinned deployment, namespace and server prepared state.\n" +
      "Waits for the recorded native version, then requests its first activation/probe and finishes paused.\n" +
      "Never re-uploads, repeats preparation, adopts unknown PUTs or resends activation.",
  },
  "update-service-reconcile": {
    usage: "update-service-reconcile OPERATION_UUID",
    description: "Reconcile an exact already-completed paused update using retained evidence without remote mutations.",
  },
  "service-status": {
    usage: "service-status",
    description: "Read service runtime and aggregated Show readiness/paused/queued/drained status. No service-wide Pause or admission window exists.\n" +
      "The aggregate is not an atomic snapshot or an update lock; an empty FIFO does not prove unregistered uploads settled.",
  },
  "show-status": {
    usage: "show-status SHOW_ID",
    description: "Read this Show's runtime, Pause state, admission window and FIFO without consulting other Shows.",
  },
  "show-pause": {
    usage: "show-pause SHOW_ID PAUSE_UUID",
    description: "Pause this Show's delivery and new admission. Already accepted jobs drain; other Shows are unaffected.",
  },
  "show-resume": {
    usage: "show-resume SHOW_ID NEW_WINDOW_UUID",
    description: "Resume this verified, drained Show with a NEW admission window outside shared maintenance.\n" +
      "Other Shows' blocked jobs do not prevent this. Never releases unknown IO or blocked jobs.",
  },
  "target-show": {
    usage: "target-show SHOW_ID",
    description: "Read a Show's current lifecycle and expected state version without mutations or recovery authorization.",
  },
  "target-episode": {
    usage: "target-episode SHOW_ID EPISODE_ID",
    description: "Read the Episode's current lifecycle/base revision and expected versions without mutations.",
  },
  "list-shows": {
    usage: "list-shows [--include-deleted] [--cursor TOKEN] [--json]",
    description: "Run from the service workspace. List server-side Shows, states, titles and feed URLs.\n" +
      "Returns up to 20 entries; follow next_cursor. Local-only drafts are excluded. Snapshot only.\n" +
      "Requires the administrator key, not a Cloudflare API token.",
  },
  "list-episodes": {
    usage: "list-episodes SHOW_ID [--include-deleted] [--cursor TOKEN] [--json]",
    description: "Run from the service workspace. List server-side Episodes, states, titles and dates for SHOW_ID.\n" +
      "Returns up to 20 entries; follow next_cursor. Local-only drafts are excluded. Snapshot only.\n" +
      "Requires the administrator key, not a Cloudflare API token.",
  },
  "preview-show-lifecycle": {
    usage: "preview-show-lifecycle SHOW_ID unpublish|restore",
    description: "Print a read-only lifecycle plan. Save JSON, review target/action/request_sha256, then use lifecycle-execute.\n" +
      "Restore uses saved snapshots and preserves individually unpublished Episodes. Physical deletion is not supported.",
  },
  "preview-episode-lifecycle": {
    usage: "preview-episode-lifecycle SHOW_ID EPISODE_ID unpublish|restore",
    description: "Print a read-only Episode lifecycle plan. Save JSON and review it before lifecycle-execute.\n" +
      "Restore preserves saved GUID/date/audio/revision identity, not local edits. Physical deletion is not supported.",
  },
  "lifecycle-execute": {
    usage: "lifecycle-execute PLAN_JSON REQUEST_SHA256 confirm",
    description: "Submit the exact reviewed unpublish/restore plan with its hash and explicit confirmation.\n" +
      "Queued is not completed; use job-status or operation-status lifecycle JOB until succeeded.",
  },
  "operation-status": {
    usage: "operation-status upload|rss-import|publication|draft|show-registration|lifecycle|cleanup ID [--show SHOW_ID] [--local|--remote] [--after-version N] [--request-cursor UUID]",
    description: "Read operation, client, request and checkpoint records without changing journals or locks. Remote is the default.",
  },
  "operation-list": {
    usage: "operation-list [--show SHOW_ID] [--incomplete] [--local|--remote] [--cursor UUID] [--parent UUID]",
    description: "List operations and server SQLite capacity. Remote pages contain up to 20 entries; follow next_cursor.",
  },
  "operation-resume": {
    usage: "operation-resume upload ID --show SHOW_ID",
    description: "Resume an unchanged upload from a durable successful PUT receipt, verification or draft attachment. Unknown PUTs are retained.",
  },
  "operation-cancel": {
    usage: "operation-cancel upload|rss-import ID --show SHOW_ID",
    description: "Cancel a settled, unused operation. Files remain stored; preview cleanup separately.",
  },
  "operation-cleanup-preview": {
    usage: "operation-cleanup-preview upload ID --show SHOW_ID",
    description: "Preview eligible staging files from a cancelled operation and their confirmation hash. Read-only.",
  },
  "operation-cleanup": {
    usage: "operation-cleanup upload ID PLAN_SHA256 confirm --show SHOW_ID",
    description: "Delete only the reviewed, settled, unused staging objects. Retain receipts and uncertain deletion results for inspection.",
  },
  "import-rss": {
    usage: "import-rss SHOW_ID FEED_URL (--dry-run | --output DIRECTORY)",
    description: "Import RSS 2.0 to local files without a service workspace, Cloudflare credentials or changes.\n" +
      "--dry-run reports counts, missing fields and warnings; --output downloads the snapshot, cover, MP3s and TOML.\n" +
      "Repeat the same command to continue this snapshot without overwriting edits. MP3s are at most 300,000,000 bytes.\n" +
      "Review before publication. Does not migrate subscribers, service schemas or old operational journals.",
  },
  "publish-rss-import": {
    usage: "publish-rss-import DIRECTORY",
    description: "Publish a reviewed local RSS import as a new Show from the service workspace.\n" +
      "Requires a ready SQLite service, administrator key and Cloudflare credentials; creates and explicitly opens only the new Show.\n" +
      "Validates inputs, preserves GUIDs/dates, then publishes the Show and Episodes sequentially. Not an atomic batch.\n" +
      "Re-running observes acknowledged pending jobs and continues without republishing completed inputs.\n" +
      "Unknown mutations stay blocked. Does not adopt existing Shows, convert services or remove the old host.",
  },
};

export function commandHelp(command: string): string {
  const help = Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : undefined;
  if (!help) throw new Error(`Unknown command: ${command}`);
  return `Usage: castloop ${help.usage}\n\n${help.description}\n\nOptions:\n  --help, -h  Show this help\n${Object.entries(commandOptions(command)).map(([name, type]) => `  --${name}${type === "string" ? " VALUE" : ""}`).join("\n")}\n\nExplicit --workspace selects only that service root. Episode commands also require --show.\nAudio paths use the Show directory; lifecycle plans use the workspace. New validate paths use caller cwd.\n--non-interactive disables CLI prompts, not administrator approval.`;
}

export function commandOptions(command: string): Record<string, "string" | "boolean"> {
  const options: Record<string, "string" | "boolean"> = { json: "boolean", "non-interactive": "boolean" };
  if (!["describe", "schema", "import-rss", "validate", "template", "skill"].includes(command)) options.workspace = "string";
  const byCommand: Record<string, Record<string, "string" | "boolean">> = {
    init: { "publication-protocol": "string", "service-id": "string", "account-id": "string", "bucket-name": "string", "workers-subdomain": "string", "operation-id": "string" },
    "create-show": { "site-url": "string" }, deploy: { "operation-id": "string" }, schema: { format: "string" },
    domain: { "zone-id": "string", "operation-id": "string", cursor: "string" },
    "list-shows": { "include-deleted": "boolean", cursor: "string" }, "list-episodes": { "include-deleted": "boolean", cursor: "string" },
    "operation-list": { show: "string", local: "boolean", remote: "boolean", incomplete: "boolean", cursor: "string", parent: "string" },
    "operation-status": { show: "string", local: "boolean", remote: "boolean", "after-version": "string", "request-cursor": "string" },
    "import-rss": { "dry-run": "boolean", output: "string" },
    validate: { assets: "boolean", audio: "string" }, doctor: { local: "boolean" }, skill: { output: "string" },
  };
  if (["create-episode", "update-episode", "update-episode-audio", "publish-episode", "preview-episode"].includes(command) || command.startsWith("operation-")) options.show = "string";
  if (["publish-show", "publish-episode"].includes(command)) options["expect-preview"] = "string";
  return { ...options, ...byCommand[command] };
}

export function describeCommand(command: string) {
  const help = COMMAND_HELP[command];
  if (!help || !Object.hasOwn(COMMAND_HELP, command)) throw new Error("Unknown command");
  const offline = ["describe", "schema", "validate", "template", "skill", "doctor", "preview-show", "preview-episode"].includes(command);
  const read = offline || ["service-status", "show-status", "target-show", "target-episode", "list-shows", "list-episodes", "job-status", "operation-status", "operation-list", "operation-cleanup-preview", "preview-show-lifecycle", "preview-episode-lifecycle"].includes(command);
  return { command, ...help, options: commandOptions(command),
    positional_counts: command === "create-show" ? [1] : command === "init" ? [0, 1] : command === "deploy" ? [0] :
      SQLITE_COMMAND_ARGUMENTS[command] ?? ({ describe: [0, 1], schema: [1], validate: [2], skill: [2], template: [1], doctor: [0], "import-rss": [2], "publish-rss-import": [1] } as Record<string, number[]>)[command],
    constraints: ["--local and --remote are mutually exclusive", "Explicit --workspace requires --show for Episode commands", "Missing init and create-show values fail without IO in --non-interactive mode", "--json disables prompts and returns one JSON document; describe/schema return their specification directly"],
    authentication: offline || command === "import-rss" ? "none" : "administrator key; Cloudflare credentials additionally required for resource administration and upload",
    effects: { local: offline ? command === "skill" ? "explicit_export_only" : "read_only" : read ? "read_only" : "may_write_records", remote: offline ? "none" : read || command === "create-episode" ? "read_only" : command === "import-rss" ? "download_only" : "may_mutate", publication: command.startsWith("publish-") || command === "lifecycle-execute" },
    output_schema: "result", input_schemas: ["service-config", "show-input", "episode-input"],
    recovery: read ? "Bounded observation only; snapshots do not authorize mutations." : "Preserve exact workspace, Show, input and records. Unknown PUT/POST outcomes must not be replayed. Observe the recorded job/operation; upload continuation requires the retained receipt and unchanged input.",
    paths: { workspace: "caller cwd", audio: "Show directory", lifecycle_plan: "workspace", validation_inputs: "caller cwd" } };
}
