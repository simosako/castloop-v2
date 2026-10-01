type CommandHelp = { usage: string; description: string };

export const COMMAND_HELP: Record<string, CommandHelp> = {
  init: {
    usage: "init [dir] [--service-id ID] [--account-id ID] [--bucket-name NAME] [--workers-subdomain NAME]",
    description: "Create a service workspace and Cloudflare resources. Missing values are prompted on a terminal.\n" +
      "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Resume an existing workspace with init [dir] without flags.",
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
      "Check the returned job ID with job-status until published and owner free.",
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
    usage: "publish-episode ID",
    description: "Run from the Show directory. Submit staged Episode changes for publication.\n" +
      "Initial publication requires metadata and audio. Later revisions can reuse unchanged published inputs.",
  },
  "job-status": {
    usage: "job-status JOB --show ID [--episode ID]",
    description: "Run from the service workspace. Print publication status, admission owner, commit marker and DLQ state.\n" +
      "Supply --episode for Episode jobs. Complete means status published and owner free.",
  },
  "retry-job": {
    usage: "retry-job JOB --show ID [--episode ID]",
    description: "Run from the service workspace. Requeue the same processing/retrying job only when its DLQ record exists.\n" +
      "Supply --episode for Episode jobs. Permanently failed jobs cannot be retried with this command.",
  },
  "cleanup-job": {
    usage: "cleanup-job JOB --show ID --episode ID",
    description: "Run from the service workspace. Remove staged audio only after successful Episode publication.\n" +
      "Published audio, revision history and commit markers are retained.",
  },
  deploy: {
    usage: "deploy",
    description: "Run from the service workspace. Deploy this executable's embedded Worker and preserve existing secrets.\n" +
      "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
  },
  "migration-status": {
    usage: "migration-status [--local]",
    description: "Run from the service workspace. Read migration admission/progress from a migration bridge or candidate Worker.\n" +
      "Use --local to inspect the local setup journal and lock without network access or credentials; remote state is not checked.\n" +
      "This does not deploy, initialize controls, resume writes, remove locks or certify M6 readiness. Legacy Workers do not provide the remote route.",
  },
};

export function commandHelp(command: string): string {
  const help = Object.hasOwn(COMMAND_HELP, command) ? COMMAND_HELP[command] : undefined;
  if (!help) throw new Error(`Unknown command: ${command}`);
  return `Usage: castloop ${help.usage}\n\n${help.description}\n\nOptions:\n  --help, -h  Show this help`;
}
