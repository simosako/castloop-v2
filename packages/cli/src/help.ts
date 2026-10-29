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
      "Checks workspace, key and credentials, service runtime identity, shared maintenance, admission, registration and published content,\n" +
      "classifying every check with a scope (local/remote/cross/external) and pass/warn/fail/not_checked. Any failed check exits 1; warnings alone exit 0.\n" +
      "queued or a CLI ok is never reported as publication success; --external adds public-path delivery checks via the verify family." },
  template: { usage: "template service-config|admin-config|show|episode", description: "Print an embedded example TOML without IO or registration. admin-config is optional workspace CLI preferences, not service identity. Examples are not administrator answers or registered identities; init/create-episode own real resource and GUID generation." },
  "preview-show": { usage: "preview-show ID [--local|--remote] [--rss-output FILE]", description: "Compare local TOML/CSS/cover with published content. No staging or upload. --local never networks; remote failures stop. Bind approval to publish-show --expect-preview HASH." },
  "preview-episode": { usage: "preview-episode ID [MP3] [--local|--remote] [--rss-output FILE]", description: "Compare local TOML and optional MP3 with published content. Omitted MP3 reuses published audio; initial publication needs MP3. --local reports remote not_checked. Future published_at is a warning, not a schedule. Bind approval to publish-episode --expect-preview HASH." },
  "list-show-revisions": { usage: "list-show-revisions SHOW [--cursor SEQUENCE]", description: "Read committed Show revision history, newest first, 20 per page. Snapshots are not publication approval." },
  "list-episode-revisions": { usage: "list-episode-revisions ID [--cursor SEQUENCE]", description: "Read committed Episode revision history with --show, newest first, 20 per page. Does not expose private media publicly." },
  "preview-show-revision": { usage: "preview-show-revision SHOW REVISION_UUID", description: "Read current and selected saved Show content and a plan. Does not write journals or publish. Execution republishes saved content without rolling back Episodes." },
  "preview-episode-revision": { usage: "preview-episode-revision ID REVISION_UUID", description: "Read current and selected saved Episode content with --show. Preview preserves GUID/date and selects saved immutable audio without upload. Execution is explicit." },
  "revision-execute": { usage: "revision-execute PLAN_JSON REQUEST_SHA256 confirm", description: "Adopt the reviewed saved content synchronously, retaining history and media. Identical current content returns unchanged. Unpublished targets become published. Does not edit local originals." },
  "sync-local-metadata": { usage: "sync-local-metadata --show SHOW [--episode ID] --expect-revision UUID [--output FILE]", description: "Export exact current metadata to a new file. Never overwrites originals or downloads assets. Output paths use caller cwd." },
  "preview-schedule-time": { usage: "preview-schedule-time DATETIME [--timezone IANA_ZONE]", description: "Offline date/time conversion only: this command does NOT create a reservation or publish. An explicit offset determines the instant; otherwise --timezone overrides optional workspace castloop-admin.toml timezone, then server basis UTC. Prints local time, offset, UTC and sources. Rejects ambiguous/nonexistent DST times and explicit offset/--timezone disagreement. Does not check server time or readiness." },
  "preview-episode-schedule": { usage: "preview-episode-schedule ID [MP3] --at DATETIME [--timezone IANA_ZONE] [--show SHOW]", description: "Read-only remote review of local Episode inputs and schedule time. Prints approval_sha256; does not upload or publish." },
  "schedule-episode": { usage: "schedule-episode ID [MP3] --at DATETIME [--timezone IANA_ZONE] --expect-preview HASH [--show SHOW]", description: "Place reviewed media and save frozen metadata, audio reference and base for future publication. Returns scheduled, not published. If the response is lost, inspect schedule-list." },
  "preview-show-schedule": { usage: "preview-show-schedule SHOW --at DATETIME [--timezone IANA_ZONE]", description: "Read-only remote review of local Show inputs and schedule time. Prints approval_sha256; does not upload or publish." },
  "schedule-show": { usage: "schedule-show SHOW --at DATETIME [--timezone IANA_ZONE] --expect-preview HASH", description: "Freeze reviewed Show metadata/cover and submit a future Show publication schedule. Returns scheduled, not published." },
  "schedule-list": { usage: "schedule-list SHOW [--cursor UUID]", description: "List up to 20 schedules for this Show, newest first; follow next_cursor." },
  "schedule-status": { usage: "schedule-status SHOW SCHEDULE_UUID", description: "Read a schedule, its frozen content, version, time and resulting revision. dispatched means publication and schedule completion committed together." },
  "preview-schedule-reschedule": { usage: "preview-schedule-reschedule SHOW SCHEDULE_UUID --at DATETIME [--timezone IANA_ZONE]", description: "Read-only preview of moving an undispatched schedule to a new future UTC time. Prints the current schedule, resolved time and approval_sha256; bind it to schedule-reschedule --expect-preview HASH." },
  "preview-schedule-cancel": { usage: "preview-schedule-cancel SHOW SCHEDULE_UUID", description: "Read-only preview of cancelling the current schedule version. Prints approval_sha256; bind it to schedule-cancel --expect-preview HASH." },
  "preview-schedule-reapprove": { usage: "preview-schedule-reapprove SHOW SCHEDULE_UUID --at DATETIME [--timezone IANA_ZONE] --expect-version N", description: "Review saved schedule content against the current runtime/base. Prints approval_sha256; no local draft journal is needed." },
  "schedule-reschedule": { usage: "schedule-reschedule SHOW SCHEDULE_UUID --at DATETIME [--timezone IANA_ZONE] --expect-version N --expect-preview HASH", description: "Move an undispatched schedule to a new future UTC time without changing its frozen content. Rejects a stale version or dispatched/cancelled schedule. Obtain the hash from preview-schedule-reschedule first." },
  "schedule-cancel": { usage: "schedule-cancel SHOW SCHEDULE_UUID --expect-version N --expect-preview HASH", description: "Cancel an undispatched schedule. Does not delete media or undo publication." },
  "schedule-reapprove": { usage: "schedule-reapprove SHOW SCHEDULE_UUID --at DATETIME [--timezone IANA_ZONE] --expect-version N --expect-preview HASH", description: "Explicitly reapprove saved schedule content with the reviewed current runtime/base and new time. Does not resume Shows or change saved metadata/media." },
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
  "publish-show": {
    usage: "publish-show ID",
    description: "Publish local Show TOML/CSS/cover in one command. Place media directly in R2 and commit synchronously after cache purge.\n" +
      "Returns changed or unchanged and the current revision. Repeating identical content adds no history or media objects.",
  },
  "publish-episode": {
    usage: "publish-episode ID [MP3] [--allow-future-published-at]",
    description: "Publish local Episode TOML and optional MP3 directly, without staging. Returns changed or unchanged and the current revision.\n" +
      "Initial publication requires metadata and audio. Metadata-only updates reuse immutable published audio.\n" +
      "A future published_at does NOT delay publication: this command starts now. Non-interactive runs require\n" +
      "--allow-future-published-at; interactive runs ask to type \"publish now\". Use schedule-episode for scheduled publication.\n" +
      "MP3 is required initially, otherwise omitted MP3 reuses published audio. If a response is lost, review current content and rerun the same inputs.",
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
    description: "Read service runtime and aggregated Show readiness/availability. The aggregate is not an atomic snapshot or an update lock; it does not authorize cleanup.",
  },
  "show-status": {
    usage: "show-status SHOW_ID",
    description: "Read this Show's runtime, availability and admission window without consulting other Shows.",
  },
  "show-pause": {
    usage: "show-pause SHOW_ID PAUSE_UUID",
    description: "Pause this Show's delivery and publication changes. Pending publication commits recheck admission; other Shows are unaffected.",
  },
  "show-admission-pause": {
    usage: "show-admission-pause SHOW_ID OPERATION_UUID",
    description: "Stop publication changes for this Show while keeping approved content delivery enabled. Maintenance and delivery checks still apply; media placement alone does not publish.",
  },
  "show-delivery-resume": {
    usage: "show-delivery-resume SHOW_ID OPERATION_UUID",
    description: "Enable only approved content delivery for a verified Show outside maintenance. Publication admission stays closed.",
  },
  "show-control-status": {
    usage: "show-control-status SHOW_ID OPERATION_UUID",
    description: "Read the saved result of a Show stop/resume operation and its current status. Does not replay requests or change local records. Missing results do not prove a request was never applied.",
  },
  "show-resume": {
    usage: "show-resume SHOW_ID NEW_WINDOW_UUID",
    description: "Resume this verified Show with a NEW admission window outside shared maintenance. Other Shows are unaffected; suspended schedules still need explicit reapproval.",
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
      "Returns synchronously after publication commit, or unchanged if the requested state is already current.",
  },
  "import-rss": {
    usage: "import-rss SHOW_ID FEED_URL (--dry-run | --output DIRECTORY)",
    description: "Import RSS 2.0 to local files without a service workspace, Cloudflare credentials or changes.\n" +
      "--dry-run reports counts, missing fields and warnings; --output downloads the snapshot, cover, MP3s and TOML.\n" +
      "Repeat the same command to continue this snapshot without overwriting edits. MP3s are at most 300,000,000 bytes.\n" +
      "Review before publication. Does not migrate subscribers, service schemas or old operational journals.",
  },
  "publish-rss-import": {
    usage: "publish-rss-import DIRECTORY [--allow-future-published-at]",
    description: "Publish a reviewed local RSS import as a new Show from the service workspace.\n" +
      "Requires a ready SQLite service, administrator key and Cloudflare credentials; creates and explicitly opens only the new Show.\n" +
      "Validates inputs, preserves GUIDs/dates, then publishes the Show and Episodes sequentially. Not an atomic batch.\n" +
      "If any imported Episode has a future published_at, publication starts immediately and requires --allow-future-published-at.\n" +
      "Re-running continues batch progress; identical publication content is unchanged.\n" +
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
      "After restoration run doctor --local; preserve old operation records and never replay their unknown outcomes.\n" +
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
    diagnose: { "max-shows": "string", external: "boolean" },
    verify: { episode: "string" },
    stats: { episode: "string", from: "string", to: "string", "by-revision": "boolean", cursor: "string" },
    "stats-retention": { "operation-id": "string" },
    "import-rss": { "dry-run": "boolean", output: "string" },
    "publish-rss-import": { "allow-future-published-at": "boolean" },
    "publish-episode": { "allow-future-published-at": "boolean" },
    validate: { assets: "boolean", audio: "string" }, doctor: { local: "boolean" }, skill: { output: "string" },
    "preview-schedule-time": { timezone: "string" },
    "preview-episode-schedule": { at: "string", timezone: "string", "expect-preview": "string" },
    "schedule-episode": { at: "string", timezone: "string", "expect-preview": "string" },
    "preview-show-schedule": { at: "string", timezone: "string", "expect-preview": "string" },
    "schedule-show": { at: "string", timezone: "string", "expect-preview": "string" },
    "schedule-list": { cursor: "string" },
    "schedule-status": {},
    "preview-schedule-reschedule": { at: "string", timezone: "string" },
    "preview-schedule-cancel": {},
    "preview-schedule-reapprove": { at: "string", timezone: "string", "expect-version": "string" },
    "schedule-reschedule": { at: "string", timezone: "string", "expect-version": "string", "expect-preview": "string" },
    "schedule-cancel": { "expect-version": "string", "expect-preview": "string" },
    "schedule-reapprove": { at: "string", timezone: "string", "expect-version": "string", "expect-preview": "string" },
    "preview-show": { local: "boolean", remote: "boolean", "rss-output": "string" },
    "preview-episode": { local: "boolean", remote: "boolean", "rss-output": "string" },
    "list-show-revisions": { cursor: "string" }, "list-episode-revisions": { cursor: "string" },
    "sync-local-metadata": { show: "string", episode: "string", "expect-revision": "string", output: "string" },
    "backup-create": { output: "string", "include-audio": "boolean", "passphrase-file": "string" },
    "backup-verify": { "passphrase-file": "string" },
    "backup-restore-preview": { dest: "string", "passphrase-file": "string" },
    "backup-restore": { "passphrase-file": "string" },
  };
  if (["create-episode", "publish-episode", "preview-episode",
    "preview-episode-schedule", "schedule-episode", "list-episode-revisions", "preview-episode-revision"].includes(command)) options.show = "string";
  if (["publish-show", "publish-episode"].includes(command)) options["expect-preview"] = "string";
  return { ...options, ...byCommand[command] };
}

export function describeCommand(command: string) {
  const help = COMMAND_HELP[command];
  if (!help || !Object.hasOwn(COMMAND_HELP, command)) throw new Error("Unknown command");
  const offline = ["describe", "schema", "validate", "template", "skill", "doctor", "preview-schedule-time",
    "backup-create", "backup-verify", "backup-restore-preview", "backup-restore"].includes(command);
  const preview = ["preview-show", "preview-episode", "preview-episode-schedule", "preview-show-schedule",
    "preview-schedule-reschedule", "preview-schedule-cancel", "preview-schedule-reapprove"].includes(command);
  const read = offline || preview || ["schedule-list", "schedule-status", "list-show-revisions", "list-episode-revisions", "preview-show-revision", "preview-episode-revision", "service-status", "show-status", "show-control-status", "target-show", "target-episode", "list-shows", "list-episodes", "preview-show-lifecycle", "preview-episode-lifecycle", "diagnose", "verify", "stats"].includes(command);
  return { command, ...help, options: commandOptions(command),
    positional_counts: command === "create-show" ? [1] : command === "init" ? [0, 1] : command === "deploy" ? [0] :
      SQLITE_COMMAND_ARGUMENTS[command] ?? ({ describe: [0, 1], schema: [1], validate: [2], skill: [2], template: [1], doctor: [0], "preview-schedule-time": [1], "import-rss": [2], "publish-rss-import": [1],
        "backup-create": [0], "backup-verify": [1], "backup-restore-preview": [1], "backup-restore": [3] } as Record<string, number[]>)[command],
    constraints: ["--local and --remote are mutually exclusive", "Explicit --workspace requires --show for Episode commands", "Missing init and create-show values fail without IO in --non-interactive mode", "--json disables prompts and returns one JSON document; describe/schema return their specification directly"],
    authentication: offline || command === "import-rss" ? "none" : "administrator key; Cloudflare credentials additionally required for resource administration and upload",
    effects: { local: preview ? "read_only_or_explicit_rss_export" : offline ? ["skill", "backup-create", "backup-restore"].includes(command) ? "explicit_export_only" : "read_only" : read ? "read_only" : "may_write_records", remote: offline ? "none" : read || command === "create-episode" || command === "sync-local-metadata" ? "read_only" : command === "import-rss" ? "download_only" : "may_mutate", publication: command.startsWith("publish-") || command.startsWith("schedule-") && !["schedule-list", "schedule-status"].includes(command) ||
      command === "lifecycle-execute" || command === "revision-execute" },
    output_schema: "result", input_schemas: ["service-config", "admin-config", "show-input", "episode-input"],
    recovery: read ? "Read-only observation; snapshots do not authorize mutations." : command === "publish-rss-import" ? "Resume only the same retained batch and inputs. Identical content is unchanged; unknown Show registration, Resume or local installation outcomes stop without replay." : ["publish-show", "publish-episode", "lifecycle-execute", "revision-execute"].includes(command) ? "Review current content after a lost response. Repeating the same desired content is unchanged; changed bases require a new review." : "Preserve the exact workspace, target and records. Unknown resource, deployment and control outcomes must not be replayed.",
    paths: { workspace: "caller cwd", audio: "Show directory", lifecycle_plan: "workspace", validation_inputs: "caller cwd" } };
}
