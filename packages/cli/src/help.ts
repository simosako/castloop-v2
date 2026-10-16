type CommandHelp = { usage: string; description: string };

export const COMMAND_HELP: Record<string, CommandHelp> = {
  "publish-rss-import": {
    usage: "publish-rss-import DIRECTORY",
    description: "Publish a reviewed local RSS import as a new Show from the service workspace.\n" +
      "Requires an open queue-management-v1-ready Worker, retained administrator key and Cloudflare credentials with Queues Edit.\n" +
      "Validates all TOML and assets before registration; publishes the Show then Episodes sequentially.\n" +
      "Intermediate Episodes become public as jobs finish. The operation is not an atomic batch.\n" +
      "Re-running inspects acknowledged pending jobs and continues recorded progress without republishing completed inputs.\n" +
      "Unknown mutation outcomes remain blocked; preserve .castloop journals and inspect the existing jobs.\n" +
      "Completion does not authorize removal of the old host or certify subscriber migration.",
  },
  "import-rss": {
    usage: "import-rss SHOW_ID FEED_URL (--dry-run | --output DIRECTORY)",
    description: "Import one RSS 2.0 podcast to local files without Cloudflare credentials or changes.\n" +
      "--dry-run fetches only RSS and reports counts, missing fields and unsupported extensions.\n" +
      "--output downloads the RSS snapshot, JPEG/PNG cover, MP3s and editable TOML into an empty directory.\n" +
      "Repeat the same command to continue this snapshot without overwriting edited TOML.\n" +
      "Preserve downloaded files and private .castloop records; review them before publication.\n" +
      "Audio must be MP3 and at most 300,000,000 bytes. Local import does not migrate subscribers or remove the old host.",
  },
  init: {
    usage: "init [dir] [--publication-protocol sqlite-sequential-v1] [--service-id ID] [--account-id ID] [--bucket-name NAME] [--workers-subdomain NAME] [--operation-id UUID]",
    description: "Create a service workspace and Cloudflare resources. Missing values are prompted on a terminal.\n" +
      "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Creates only new resources and completes paused.\n" +
      "schema_version=1: use service-status, then service-resume with its pause ID. Never rerun an initialization with an unknown outcome.\n" +
      "Development: --publication-protocol sqlite-sequential-v1 creates a fresh SQLite DO service without Queues.\n" +
      "SQLite initialization verifies Alarm/R2/cache readiness and finishes paused; resume with a NEW window UUID. Existing services are not converted.",
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
    description: "Run from the service workspace. Stage local Show metadata and cover art without publishing.\n" +
      "Requires queue-management-v1 readiness and Cloudflare credentials with Queues Edit. Waits for an R2 grant before upload.",
  },
  "publish-show": {
    usage: "publish-show ID",
    description: "Run from the service workspace after update-show. Submit the staged Show for publication.\n" +
      "Requires queue-management-v1 readiness and Cloudflare Queues Edit. Queued does not prove admission, marker creation or publication.\n" +
      "Check the returned job ID with job-status until server_status.response.state is published.",
  },
  "update-episode": {
    usage: "update-episode ID",
    description: "Run from the Show directory. Stage Episode metadata without uploading audio or publishing.\n" +
      "Requires queue-management-v1 readiness and Cloudflare credentials with Queues Edit.",
  },
  "update-episode-audio": {
    usage: "update-episode-audio ID MP3",
    description: "Run from the Show directory. Validate and stage MP3 audio (at most 300,000,000 bytes).\n" +
      "Requires queue-management-v1 readiness and Cloudflare credentials with Queues Edit.\n" +
      "This does not publish. Initial publication also requires update-episode.",
  },
  "publish-episode": {
    usage: "publish-episode ID [MP3]",
    description: "Run from the Show directory. Submit staged Episode changes for publication.\n" +
      "Initial publication requires metadata and audio. Supply the original MP3 path whenever audio was staged.\n" +
      "For metadata-only revisions omit MP3; unchanged published audio is reused.\n" +
      "Requires queue-management-v1 readiness and Cloudflare Queues Edit. Unknown submissions are never automatically resent.",
  },
  "job-status": {
    usage: "job-status JOB",
    description: "Run from the service workspace. Compare the retained publication journal with server status.\n" +
      "New jobs read authenticated private R2 results and require Cloudflare credentials; response.state published proves this operation completed.\n" +
      "Legacy jobs retain published/released status. Neither a result nor queued proves global service quiescence or authorizes recovery.",
  },
  "retry-job": {
    usage: "retry-job JOB",
    description: "Run from the service workspace. Explicitly retry the same acknowledged publication commit.\n" +
      "Requires its retained journal, an existing verified marker and settled execution. Does not resend an unconfirmed Queue submission.\n" +
      "New async management requests cannot be retried by this command. Active or unknown owners/locks are not released.",
  },
  "release-job": {
    usage: "release-job JOB",
    description: "Disabled: dead-letter history does not prove that the current execution or IO ended.\n" +
      "Preserve journals and tokens and inspect Worker logs. No token is released or commit requeued.",
  },
  deploy: {
    usage: "deploy [--operation-id UUID]",
    description: "Run from the service workspace. Update an already initialized M6 service without converting data.\n" +
      "Explicitly pause and drain first. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.\n" +
      "Completes paused; resume explicitly. Does not adopt legacy services or replay unknown deployments.",
  },
  domain: {
    usage: "domain add HOSTNAME [--operation-id UUID] | domain list | domain remove [--operation-id UUID]",
    description: "Run from the service workspace. Use one Custom Domain in an active/full Cloudflare zone owned by this account.\n" +
      "Add/remove require explicit service-pause and drained owners, and finish paused; resume explicitly.\n" +
      "Keep workers.dev for administration. TLS probes send no administrator key or API token.\n" +
      "Repeat the same command to continue acknowledged progress/TLS waiting. Preserve unknown REST outcomes, execution tokens and locks.\n" +
      "List is read-only and reports connections, settings mismatches and unfinished operations. Set Cloudflare account/API token and the local administrator key.",
  },
  "init-reconcile": {
    usage: "init-reconcile OPERATION_UUID",
    description: "Reconcile a retained initialization only when the server already completed it paused. Does not redeploy or replay initialization.",
  },
  "update-service-continue": {
    usage: "update-service-continue OPERATION_UUID",
    description: "Explicitly activate an acknowledged upload only with a durable not-started activation checkpoint.\n" +
      "Rechecks the retained owner, settings, version history and script ETag; never uploads again. Completes paused.\n" +
      "Legacy upload-only journals, unknown activation requests and residual locks remain blocked.",
  },
  "update-service-verify": {
    usage: "update-service-verify OPERATION_UUID",
    description: "Continue verification of an acknowledged deployment using its retained journal. Never re-upload an unknown deployment.",
  },
  "update-service-reconcile": {
    usage: "update-service-reconcile OPERATION_UUID",
    description: "Reconcile an already completed paused update without repeating remote mutations.",
  },
  "service-status": {
    usage: "service-status",
    description: "Read service admission, pause ID, worker version and unsettled invocations. Paused does not necessarily mean drained.",
  },
  "service-pause": {
    usage: "service-pause PAUSE_UUID",
    description: "Explicitly pause delivery and new mutations. Existing owners must finish; no elapsed-time release is performed.",
  },
  "service-resume": {
    usage: "service-resume UUID",
    description: "Resume only the exact paused service after runtime verification and settlement of existing owners.\n" +
      "schema_version=1 requires its PAUSE_UUID. sqlite-sequential-v1 requires a NEW admission-window UUID, not the pause command UUID.",
  },
  "target-show": {
    usage: "target-show SHOW_ID",
    description: "Read a Show's current lifecycle, generations and unfinished ownership without mutations.",
  },
  "list-shows": {
    usage: "list-shows [--include-deleted] [--cursor TOKEN] [--json]",
    description: "Run from the service workspace. List server-side Shows, states, titles and feed URLs without mutations.\n" +
      "Returns up to 20 control records per page; repeat with the returned cursor for more. Deleted IDs are hidden unless requested.\n" +
      "Local-only drafts are not included. Snapshot only; feed URLs do not prove delivery. Requires the administrator key, not a Cloudflare API token.",
  },
  "list-episodes": {
    usage: "list-episodes SHOW_ID [--include-deleted] [--cursor TOKEN] [--json]",
    description: "Run from the service workspace. SHOW_ID is required. List server-side Episodes, states, titles and publication dates.\n" +
      "Returns up to 20 control records per page; repeat with the returned cursor for more. Deleted IDs are hidden unless requested.\n" +
      "Local-only Episode TOML drafts are not included. Parent Show/service state is reported separately. Requires the administrator key.",
  },
  "target-episode": {
    usage: "target-episode SHOW_ID EPISODE_ID",
    description: "Read an Episode's current lifecycle, revision and unfinished ownership without mutations.",
  },
  "preview-show-lifecycle": {
    usage: "preview-show-lifecycle SHOW_ID unpublish|restore|delete",
    description: "Print a non-mutating lifecycle plan. Save JSON, review target/action/request hash, then use lifecycle-execute.\n" +
      "Unpublish is reversible; deletion removes payloads permanently while retaining operational records and IDs.",
  },
  "preview-episode-lifecycle": {
    usage: "preview-episode-lifecycle SHOW_ID EPISODE_ID unpublish|restore|delete",
    description: "Print a non-mutating Episode lifecycle plan. Save JSON and review it before lifecycle-execute.\n" +
      "Deletion is irreversible and retains operational records and IDs.",
  },
  "lifecycle-execute": {
    usage: "lifecycle-execute PLAN_JSON REQUEST_SHA256 confirm|confirm-delete-retain-records",
    description: "Execute the exact reviewed plan with explicit acknowledgement. Delete requires confirm-delete-retain-records.\n" +
      "The returned job ID is queued, not completed; inspect operation-status lifecycle JOB until settled.",
  },
  "lifecycle-retry": {
    usage: "lifecycle-retry JOB_UUID REQUEST_SHA256 confirm|confirm-delete-retain-records",
    description: "Retry the same confirmed lifecycle job only with its retained journal and settled execution. No force unlock or owner release.",
  },
  "migration-status": {
    usage: "migration-status [--local]",
    description: "Run from the service workspace. Read migration admission/progress from a migration bridge or candidate Worker.\n" +
      "Use --local to inspect the local setup journal and lock without network access or credentials; remote state is not checked.\n" +
      "This does not deploy, initialize controls, resume writes, remove locks or certify M6 readiness. Legacy Workers do not provide the remote route.",
  },
  "migration-preflight": {
    usage: "migration-preflight LEGACY_VERSION_ID",
    description: "Run from the service workspace. Inspect the expected single legacy Worker version through Cloudflare REST GETs only.\n" +
      "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. No administrator key or Wrangler is needed.\n" +
      "This snapshot does not deploy, pause, save a journal, prove old IO termination or authorize migration completion or recovery.",
  },
  "local-operation-status": {
    usage: "local-operation-status FAMILY ID",
    description: "Run from the service workspace. Read a local M6 operation journal and observe its lock.\n" +
      "FAMILY must be staging, publication, lifecycle or show-registration. Staging uses an upload operation ID,\n" +
      "publication/lifecycle use a job ID, and show-registration uses a Show ID.\n" +
      "No credentials, network access or writes are used. Missing local records do not prove remote absence or completion.\n" +
      "This does not retry, remove locks, release tokens, authorize recovery or certify M6 readiness.",
  },
  "operation-status": {
    usage: "operation-status FAMILY ID",
    description: "Run from the service workspace. Compare a frozen local M6 operation with its read-only server status.\n" +
      "FAMILY must be staging, publication, lifecycle or show-registration; IDs match local-operation-status.\n" +
      "Requires the local administrator key. New async content jobs use private R2 and require Cloudflare account/API credentials.\n" +
      "Legacy jobs use the M6 management status route without a Cloudflare API token.\n" +
      "This does not send mutations, update local phases, remove locks, release tokens, authorize recovery or certify M6 readiness.\n" +
      "Legacy Workers and migration-only candidate routes reject this inspection.",
  },
};

export function commandHelp(command: string): string {
  const help = Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : undefined;
  if (!help) throw new Error(`Unknown command: ${command}`);
  const sqlite = ["update-show", "publish-show", "update-episode", "update-episode-audio", "publish-episode", "job-status", "preview-show-lifecycle", "preview-episode-lifecycle", "lifecycle-execute", "operation-status"].includes(command) ?
    "\n\nSQLite development workspaces (schema_version=2): unique R2 uploads, no Queue grants/Queues Edit, explicit DO submission and bounded completion polling.\n" +
    "Lifecycle preview/execution supports only unpublish/restore of saved snapshots, with the reviewed hash and confirm; deletion is not implemented.\n" +
    "succeeded proves this operation completed, not global quiescence. Unknown requests are never resent; retry/release and deploy/domain are not implemented." : "";
  return `Usage: castloop ${help.usage}\n\n${help.description}${sqlite}\n\nOptions:\n  --help, -h  Show this help`;
}
