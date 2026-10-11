type CommandHelp = { usage: string; description: string };

export const COMMAND_HELP: Record<string, CommandHelp> = {
  init: {
    usage: "init [dir] [--service-id ID] [--account-id ID] [--bucket-name NAME] [--workers-subdomain NAME] [--operation-id UUID]",
    description: "Create a service workspace and Cloudflare resources. Missing values are prompted on a terminal.\n" +
      "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Creates only new resources and completes paused.\n" +
      "Use service-status, then service-resume with its pause ID. Never rerun an initialization with an unknown outcome.",
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
    description: "Run from the service workspace. Stage local Show metadata and cover art without publishing.",
  },
  "publish-show": {
    usage: "publish-show ID",
    description: "Run from the service workspace after update-show. Submit the staged Show for publication.\n" +
      "Check the returned job ID with job-status until published and ownership released.",
  },
  "update-episode": {
    usage: "update-episode ID",
    description: "Run from the Show directory. Stage Episode metadata without uploading audio or publishing.",
  },
  "update-episode-audio": {
    usage: "update-episode-audio ID MP3",
    description: "Run from the Show directory. Validate and stage MP3 audio (at most 300,000,000 bytes).\n" +
      "This does not publish. Initial publication also requires update-episode.",
  },
  "publish-episode": {
    usage: "publish-episode ID [MP3]",
    description: "Run from the Show directory. Submit staged Episode changes for publication.\n" +
      "Initial publication requires metadata and audio. Supply the original MP3 path whenever audio was staged.\n" +
      "For metadata-only revisions omit MP3; unchanged published audio is reused.",
  },
  "job-status": {
    usage: "job-status JOB",
    description: "Run from the service workspace. Compare the retained publication journal with server status.\n" +
      "Complete means published status and released ownership; a commit receipt only means queued.",
  },
  "retry-job": {
    usage: "retry-job JOB",
    description: "Run from the service workspace. Explicitly retry the same acknowledged publication commit.\n" +
      "Requires its retained journal and settled execution; active or unknown owners/locks are not released.",
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
    usage: "service-resume PAUSE_UUID",
    description: "Resume only the exact paused service after runtime verification and settlement of existing owners.",
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
      "Requires the local administrator key and an M6 management status route. No Cloudflare API token is required.\n" +
      "This does not send mutations, update local phases, remove locks, release tokens, authorize recovery or certify M6 readiness.\n" +
      "Legacy Workers and migration-only candidate routes reject this inspection.",
  },
};

export function commandHelp(command: string): string {
  const help = Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : undefined;
  if (!help) throw new Error(`Unknown command: ${command}`);
  return `Usage: castloop ${help.usage}\n\n${help.description}\n\nOptions:\n  --help, -h  Show this help`;
}
