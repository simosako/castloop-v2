type CommandHelp = { usage: string; description: string };

export const COMMAND_HELP: Record<string, CommandHelp> = {
  init: {
    usage: "init [dir] [--publication-protocol sqlite-sequential-v1] [--service-id ID] [--account-id ID] [--bucket-name NAME] [--workers-subdomain NAME] [--operation-id UUID]",
    description: "Create a fresh SQLite service (schema_version=2) by default; no protocol option is required.\n" +
      "--publication-protocol sqlite-sequential-v1 remains optional for existing scripts; no other protocol is supported.\n" +
      "Missing values are prompted on a terminal. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.\n" +
      "Creates a private R2 bucket, Worker and SQLite-backed Durable Object without Queues.\n" +
      "Verifies Alarm/R2/cache/purge readiness and finishes paused; resume with a NEW admission-window UUID.\n" +
      "Existing resources are never adopted. Service schema_version=1 requires v0.5.x; migration is not provided.",
  },
  "create-show": {
    usage: "create-show ID [--site-url URL]",
    description: "Run from the service workspace. Reserve a Show ID and create its local show.toml.\n" +
      "A real website URL is required (prompted if omitted). This does not publish the Show.",
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
      "Explicitly pause and drain first. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.\n" +
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
    description: "Read service state, runtime/readiness, admission window and FIFO active/queued/drained status.\n" +
      "Paused does not necessarily mean drained; an empty FIFO does not prove unregistered uploads settled.",
  },
  "service-pause": {
    usage: "service-pause PAUSE_UUID",
    description: "Explicitly pause delivery and new admission. Already accepted jobs can drain; blocked jobs stay preserved.",
  },
  "service-resume": {
    usage: "service-resume UUID",
    description: "Resume the verified paused service with a NEW admission-window UUID, not the init/pause UUID.\n" +
      "Does not release unknown IO, blocked jobs or retained locks.",
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
    usage: "operation-status upload|rss-import|publication|draft|show-registration|lifecycle|cleanup ID [--local|--remote] [--after-version N] [--request-cursor UUID]",
    description: "Read operation, client, request and checkpoint records without changing journals or locks. Remote is the default.",
  },
  "operation-list": {
    usage: "operation-list [--incomplete] [--local|--remote] [--cursor UUID] [--parent UUID]",
    description: "List operations and server SQLite capacity. Remote pages contain up to 20 entries; follow next_cursor.",
  },
  "operation-resume": {
    usage: "operation-resume upload ID",
    description: "Resume an unchanged upload from a durable successful PUT receipt, verification or draft attachment. Unknown PUTs are retained.",
  },
  "operation-cancel": {
    usage: "operation-cancel upload|rss-import ID",
    description: "Cancel a settled, unused operation. Files remain stored; preview cleanup separately.",
  },
  "operation-cleanup-preview": {
    usage: "operation-cleanup-preview upload ID",
    description: "Preview eligible staging files from a cancelled operation and their confirmation hash. Read-only.",
  },
  "operation-cleanup": {
    usage: "operation-cleanup upload ID PLAN_SHA256 confirm",
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
      "Requires an open, ready SQLite service, administrator key and Cloudflare credentials; no Queues permissions.\n" +
      "Validates inputs, preserves GUIDs/dates, then publishes the Show and Episodes sequentially. Not an atomic batch.\n" +
      "Re-running observes acknowledged pending jobs and continues without republishing completed inputs.\n" +
      "Unknown mutations stay blocked. Does not adopt existing Shows, convert services or remove the old host.",
  },
};

export function commandHelp(command: string): string {
  const help = Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : undefined;
  if (!help) throw new Error(`Unknown command: ${command}`);
  return `Usage: castloop ${help.usage}\n\n${help.description}\n\nOptions:\n  --help, -h  Show this help`;
}
