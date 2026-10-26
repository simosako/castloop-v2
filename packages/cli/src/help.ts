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
  diagnose: { usage: "diagnose SHOW_ID [SHOW_ID...] [--max-shows N] [--external]",
    description: "Read-only local and remote diagnosis for explicitly listed Shows (serial; at most 5 by default, --max-shows up to 20).\n" +
      "Performs management API GETs plus one Cloudflare account GET; never mutates, repairs, purges, resumes or replays anything.\n" +
      "Checks workspace, key and credentials, service runtime identity, shared maintenance, admission, FIFO queue, registration, target lifecycle, unfinished operations and local/remote consistency,\n" +
      "classifying every check with a scope (local/remote/cross/external) and pass/warn/fail/not_checked. Any failed check exits 1; warnings alone exit 0.\n" +
      "queued or a CLI ok is never reported as publication success; --external adds public-path delivery checks via the verify family." },
  template: { usage: "template service-config|admin-config|show|episode", description: "Print an embedded example TOML without IO or registration. admin-config is optional workspace CLI preferences, not service identity. Examples are not administrator answers or registered identities; init/create-episode own real resource and GUID generation." },
  "preview-show": { usage: "preview-show ID [--local|--remote] [--rss-output FILE]", description: "Compare published, local and staged content with immutable cover identity. Defaults to authenticated remote reads when local state exists; --local never networks. Remote errors never become unchanged results. RSS is generated locally only into a new file. Bind approval to publish-show --expect-preview HASH." },
  "preview-episode": { usage: "preview-episode ID [--local|--remote] [--rss-output FILE]", description: "Compare published, local and staged metadata/audio and preserved GUID/date. Requires --show with explicit --workspace. --local reports not_checked; remote failures stop. RSS export is local and never overwrites. Use publish-episode --expect-preview HASH after approval." },
  "list-show-revisions": { usage: "list-show-revisions SHOW [--cursor SEQUENCE]", description: "Read committed Show revision history, newest first, 20 per page. Snapshots are not publication approval." },
  "list-episode-revisions": { usage: "list-episode-revisions ID [--cursor SEQUENCE]", description: "Read committed Episode revision history with --show, newest first, 20 per page. Does not expose private media publicly." },
  "preview-show-revision": { usage: "preview-show-revision SHOW REVISION_UUID", description: "Read current and selected saved Show content and a plan. Does not write journals or publish. Execution republishes saved content without rolling back Episodes." },
  "preview-episode-revision": { usage: "preview-episode-revision ID REVISION_UUID", description: "Read current and selected saved Episode content with --show. Preview preserves GUID/date and selects saved immutable audio without upload. Execution is explicit." },
  "revision-execute": { usage: "revision-execute PLAN_JSON REQUEST_SHA256 confirm", description: "Adopt the exact reviewed saved revision as a NEW revision, retaining all history and media. Requires open admission. Waits for the same job; unknown requests are never replayed. Unpublished targets become published. Does not edit local originals." },
  "sync-local-metadata": { usage: "sync-local-metadata --show SHOW [--episode ID] --expect-revision UUID [--output FILE]", description: "Export exact current metadata to the standard TOML path or a new output file. Refuses existing files and unfinished drafts; never overwrites originals or downloads assets. Output paths use caller cwd." },
  "preview-schedule-time": { usage: "preview-schedule-time DATETIME [--timezone IANA_ZONE]", description: "Offline date/time conversion only: this command does NOT create a reservation or publish. An explicit offset determines the instant; otherwise --timezone overrides optional workspace castloop-admin.toml timezone, then server basis UTC. Prints local time, offset, UTC and sources. Rejects ambiguous/nonexistent DST times and explicit offset/--timezone disagreement. Does not check server time or readiness." },
  skill: { usage: "skill export castloop --output DIRECTORY", description: "Export the embedded administrator Skill without networking or external tools. The destination must not exist; existing Skills and AGENTS.md are never overwritten." },
  validate: { usage: "validate service|admin-config|show|episode FILE [--assets] [--audio MP3] [--json]", description: "Read-only offline validation using publication input rules. admin-config validates optional CLI preferences (UTC or an IANA timezone, not abbreviations). File/audio paths use caller cwd; cover uses the TOML directory. Does not prove remote readiness or publication success." },
  describe: { usage: "describe [COMMAND] [--json]", description: "Read offline command specifications, effects and recovery rules. No credentials or workspace required." },
  schema: { usage: "schema service-config|admin-config|show-input|episode-input|result [--format json-schema]", description: "Print the embedded JSON Schema. Additional measured constraints require castloop validate; TOML dates must be quoted strings." },
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
    usage: "create-show ID [--site-mode builtin|external] [--site-url URL]",
    description: "Run from the service workspace. Reserve a Show ID and create its local show.toml.\n" +
      "Use --site-mode builtin for an automatically generated website (no --site-url). Otherwise a real external website URL is required (prompted if omitted).\n" +
      "Creates a paused Show DO; explicitly show-resume before uploads. Does not publish.",
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
  progress: {
    usage: "progress JOB",
    description: "Run from the service workspace. Read-only merged progress view for one retained publication/lifecycle job:\n" +
      "frozen inputs, per-asset upload states, submission, FIFO waiting (with reason), execution and terminal state.\n" +
      "Unobservable steps (queue position, internal execution, cache purge) stay unknown and are never shown as done.\n" +
      "queued is not publication success. Observational only; exits 0 and never authorizes recovery.",
  },
  verify: {
    usage: "verify SHOW_ID [--episode EPISODE_ID]",
    description: "Check public delivery with GET/HEAD against the configured public origin only; no administrator key or management API.\n" +
      "Fetches the feed (bounded by the server render budget), then checks feed structure, enclosure origins, known GUIDs,\n" +
      "the published cover and (with --episode) the published audio by status/length. Processing success and delivery are reported separately.\n" +
      "Expected 404/503 answers are classified distinctly; any failed check exits 1.",
  },
  stats: {
    usage: "stats SHOW_ID [--episode EPISODE_ID] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--by-revision] [--cursor TOKEN]",
    description: "Read delivery statistics for approved public Episode audio (UTC days), aggregated per day inside the Show.\n" +
      "Without --episode: per-Episode totals for the window (default: last 30 days, at most 366; 20 episodes per page).\n" +
      "With --episode: daily rows (31 days per page) plus per-audio-revision totals; --by-revision prints the revision breakdown.\n" +
      "Counts are server-side counters only (no IP addresses or User-Agent strings are stored). HEAD, 304, small range probes and\n" +
      "known bots are separated from initial downloads; response_bytes counts served Content-Length and does not subtract client\n" +
      "disconnects. Days before measurement started show as unmeasured and pruned days (retention limit) show as pruned, never 0.\n" +
      "Lifetime totals include pruned days. Read-only; requires the administrator key.",
  },
  "stats-retention": {
    usage: "stats-retention SHOW_ID DAYS [--operation-id UUID]",
    description: "Change this Show's delivery-statistics daily retention window (30..3650, default 400) without redeploying.\n" +
      "The new limit applies from the next UTC-day pruning; already pruned daily rows never come back, and shortening prunes\n" +
      "older rows into lifetime totals instead of losing them. Idempotent per operation ID: the request is journaled locally\n" +
      "before submission and an unknown outcome is only re-checked by its operation ID, never replayed blindly.",
  },
  watch: {
    usage: "watch JOB [--timeout SECONDS] [--interval SECONDS]",
    description: "Run from the service workspace. Bounded read-only observation of one retained job until its terminal state.\n" +
      "Default timeout 600s (max 3600), interval 5s (1-60), at most 720 polls; each poll is a bounded management GET.\n" +
      "Progress goes to stderr as JSON lines; the final report is stdout (use --json for one envelope document).\n" +
      "Exit codes: 0 succeeded observed, 1 failed/blocked observed, 2 unobservable (budget exhausted or job missing); SIGINT exits 130.\n" +
      "No notifications are sent; on success the report points to castloop verify for external delivery checks.",
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
  "show-admission-pause": {
    usage: "show-admission-pause SHOW_ID OPERATION_UUID",
    description: "Stop new publication and upload admission for this Show while keeping approved content delivery enabled. Accepted jobs continue; maintenance and other delivery checks still apply.",
  },
  "show-delivery-resume": {
    usage: "show-delivery-resume SHOW_ID OPERATION_UUID",
    description: "Enable only approved content delivery for a verified, drained Show outside maintenance. Publication and upload admission stay closed.",
  },
  "show-control-status": {
    usage: "show-control-status SHOW_ID OPERATION_UUID",
    description: "Read the saved result of a Show stop/resume operation and its current status. Does not replay requests or change local records. Missing results do not prove a request was never applied.",
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
  "backup-create": {
    usage: "backup-create [--workspace PATH] --output FILE [--include-audio] [--passphrase-file FILE] [--json]",
    description: "Create one encrypted local backup archive of a service workspace: configuration, .castloop state (administrator key, client IDs, journals), Show TOML and covers.\n" +
      "Offline only; never networks or mutates the service. MP3 originals are excluded unless --include-audio is explicit; every exclusion is recorded in the archive manifest.\n" +
      "Run while no other castloop command edits the workspace; the archive is a point-in-time snapshot.\n" +
      "Audio-included backups matter for unpublished originals or account-level disasters; published audio is kept immutably in R2, so a low cadence is enough.\n" +
      "The passphrase (8 to 1024 bytes) comes from --passphrase-file or an interactive prompt, never from the command line or environment.",
  },
  "backup-verify": {
    usage: "backup-verify FILE [--passphrase-file FILE] [--json]",
    description: "Decrypt and fully verify one backup archive offline: every entry digest, the manifest, the service configuration and the ciphertext trailer.\n" +
      "Reports included and excluded files, retained locks and unfinished local operations. Read-only; verification success does not prove server-side recovery.",
  },
  "backup-restore-preview": {
    usage: "backup-restore-preview FILE --dest PATH [--passphrase-file FILE] [--json]",
    description: "Show the restoration plan for one archive: destination conflict check, expansion list, unfinished local operations and frozen absolute source paths. Writes nothing.",
  },
  "backup-restore": {
    usage: "backup-restore FILE DEST confirm [--passphrase-file FILE] [--json]",
    description: "Restore an archive into DEST, which must not exist; any failure removes the partial destination.\n" +
      "Restores the same service identity (configuration hash, administrator key, client IDs) and regenerates .gitignore.\n" +
      "After restoration run doctor --local; unfinished operations may only be observed (operation-status), never replayed.\n" +
      "Does not network, publish, resume or authorize anything remotely.",
  },
};

export function commandHelp(command: string): string {
  const help = Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : undefined;
  if (!help) throw new Error(`Unknown command: ${command}`);
  return `Usage: castloop ${help.usage}\n\n${help.description}\n\nOptions:\n  --help, -h  Show this help\n${Object.entries(commandOptions(command)).map(([name, type]) => `  --${name}${type === "string" ? " VALUE" : ""}`).join("\n")}\n\nExplicit --workspace selects only that service root. Episode commands also require --show.\nAudio paths use the Show directory; lifecycle plans use the workspace. New validate paths use caller cwd.\n--non-interactive disables CLI prompts, not administrator approval.`;
}

export function commandOptions(command: string): Record<string, "string" | "boolean"> {
  const options: Record<string, "string" | "boolean"> = { json: "boolean", "non-interactive": "boolean" };
  if (!["describe", "schema", "import-rss", "validate", "template", "skill", "backup-verify", "backup-restore-preview", "backup-restore"].includes(command)) options.workspace = "string";
  const byCommand: Record<string, Record<string, "string" | "boolean">> = {
    init: { "publication-protocol": "string", "service-id": "string", "account-id": "string", "bucket-name": "string", "workers-subdomain": "string", "operation-id": "string" },
    "create-show": { "site-url": "string", "site-mode": "string" }, deploy: { "operation-id": "string" }, schema: { format: "string" },
    domain: { "zone-id": "string", "operation-id": "string", cursor: "string" },
    "list-shows": { "include-deleted": "boolean", cursor: "string" }, "list-episodes": { "include-deleted": "boolean", cursor: "string" },
    "operation-list": { show: "string", local: "boolean", remote: "boolean", incomplete: "boolean", cursor: "string", parent: "string" },
    "operation-status": { show: "string", local: "boolean", remote: "boolean", "after-version": "string", "request-cursor": "string" },
    diagnose: { "max-shows": "string", external: "boolean" },
    verify: { episode: "string" }, watch: { timeout: "string", interval: "string" },
    stats: { episode: "string", from: "string", to: "string", "by-revision": "boolean", cursor: "string" },
    "stats-retention": { "operation-id": "string" },
    "import-rss": { "dry-run": "boolean", output: "string" },
    validate: { assets: "boolean", audio: "string" }, doctor: { local: "boolean" }, skill: { output: "string" },
    "preview-schedule-time": { timezone: "string" },
    "preview-show": { local: "boolean", remote: "boolean", "rss-output": "string" },
    "preview-episode": { local: "boolean", remote: "boolean", "rss-output": "string" },
    "list-show-revisions": { cursor: "string" }, "list-episode-revisions": { cursor: "string" },
    "sync-local-metadata": { show: "string", episode: "string", "expect-revision": "string", output: "string" },
    "backup-create": { output: "string", "include-audio": "boolean", "passphrase-file": "string" },
    "backup-verify": { "passphrase-file": "string" },
    "backup-restore-preview": { dest: "string", "passphrase-file": "string" },
    "backup-restore": { "passphrase-file": "string" },
  };
  if (["create-episode", "update-episode", "update-episode-audio", "publish-episode", "preview-episode", "list-episode-revisions", "preview-episode-revision"].includes(command) || command.startsWith("operation-")) options.show = "string";
  if (["publish-show", "publish-episode"].includes(command)) options["expect-preview"] = "string";
  return { ...options, ...byCommand[command] };
}

export function describeCommand(command: string) {
  const help = COMMAND_HELP[command];
  if (!help || !Object.hasOwn(COMMAND_HELP, command)) throw new Error("Unknown command");
  const offline = ["describe", "schema", "validate", "template", "skill", "doctor", "preview-schedule-time",
    "backup-create", "backup-verify", "backup-restore-preview", "backup-restore"].includes(command);
  const preview = ["preview-show", "preview-episode"].includes(command);
  const read = offline || preview || ["list-show-revisions", "list-episode-revisions", "preview-show-revision", "preview-episode-revision", "service-status", "show-status", "show-control-status", "target-show", "target-episode", "list-shows", "list-episodes", "job-status", "operation-status", "operation-list", "operation-cleanup-preview", "preview-show-lifecycle", "preview-episode-lifecycle", "diagnose", "progress", "verify", "watch", "stats"].includes(command);
  return { command, ...help, options: commandOptions(command),
    positional_counts: command === "create-show" ? [1] : command === "init" ? [0, 1] : command === "deploy" ? [0] :
      SQLITE_COMMAND_ARGUMENTS[command] ?? ({ describe: [0, 1], schema: [1], validate: [2], skill: [2], template: [1], doctor: [0], "preview-schedule-time": [1], "import-rss": [2], "publish-rss-import": [1],
        "backup-create": [0], "backup-verify": [1], "backup-restore-preview": [1], "backup-restore": [3] } as Record<string, number[]>)[command],
    constraints: ["--local and --remote are mutually exclusive", "Explicit --workspace requires --show for Episode commands", "Missing init and create-show values fail without IO in --non-interactive mode", "--json disables prompts and returns one JSON document; describe/schema return their specification directly"],
    authentication: offline || command === "import-rss" ? "none" : "administrator key; Cloudflare credentials additionally required for resource administration and upload",
    effects: { local: preview ? "read_only_or_explicit_rss_export" : offline ? ["skill", "backup-create", "backup-restore"].includes(command) ? "explicit_export_only" : "read_only" : read ? "read_only" : "may_write_records", remote: offline ? "none" : read || command === "create-episode" || command === "sync-local-metadata" ? "read_only" : command === "import-rss" ? "download_only" : "may_mutate", publication: command.startsWith("publish-") || command === "lifecycle-execute" || command === "revision-execute" },
    output_schema: "result", input_schemas: ["service-config", "admin-config", "show-input", "episode-input"],
    recovery: read ? "Bounded observation only; snapshots do not authorize mutations." : "Preserve exact workspace, Show, input and records. Unknown PUT/POST outcomes must not be replayed. Observe the recorded job/operation; upload continuation requires the retained receipt and unchanged input.",
    paths: { workspace: "caller cwd", audio: "Show directory", lifecycle_plan: "workspace", validation_inputs: "caller cwd" } };
}
