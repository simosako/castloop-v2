# castloop

castloop is a serverless podcast hosting program. Once deployed, it runs with minimal ops.

## Overview
- Hosts public podcasts on CloudFlare.
- One deployment can host multiple shows.
- A CLI (`castloop`) manages shows and episodes.

## Install the CLI (Linux)

The release artifact is a Bun single-file executable. It includes the CLI, shared metadata models, and a deployable Worker bundle. Building it from a checkout requires Bun 1.4.2, Node.js/npm, and the project's lockfile:

```sh
npm ci
npm run check
npm run build:cli
sha256sum dist/castloop
mkdir -p "$HOME/.local/bin"
install -m 0755 dist/castloop "$HOME/.local/bin/castloop"
castloop --version
```

The target Linux machine needs **Node.js/npm and Wrangler 4.x** for Cloudflare administration and R2 uploads. Bun and this source tree are not needed to run the executable. Install Wrangler outside the service workspace and point the CLI at it:

```sh
npm install --prefix "$HOME/.local/share/castloop-tools" wrangler@4.131.2
export CASTLOOP_WRANGLER="$HOME/.local/share/castloop-tools/node_modules/.bin/wrangler"
"$CASTLOOP_WRANGLER" --version
```

Keep `CASTLOOP_WRANGLER` in the administrator's shell configuration (or put a compatible `wrangler` on `PATH`). Install `ffprobe` for MP3 analysis before uploading Episode audio. On a headless VPS, set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the environment. The API token needs permissions to manage Workers, Queues, R2 buckets/objects, and R2 notifications. Do not put the token in `castloop.toml` or Git. On a machine with a browser, Wrangler OAuth login can be used for interactive Cloudflare access.

### Initialize and publish

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
castloop init /path/to/workspace \
  --service-id my-service --bucket-name my-private-bucket \
  --workers-subdomain my-account-subdomain
cd /path/to/workspace
castloop create-show my-show --site-url https://your-real-site.example/podcast
# Edit my-show/show.toml and provide the JPEG/PNG named in image_path.
castloop update-show my-show
castloop publish-show my-show
castloop job-status SHOW_JOB_ID --show my-show
cd my-show
castloop create-episode first-episode
# Edit episode-first-episode.toml and provide an MP3.
castloop update-episode first-episode
castloop update-episode-audio first-episode audio.mp3
castloop publish-episode first-episode
cd ..
castloop job-status EPISODE_JOB_ID --show my-show --episode first-episode
```

The publish commands print their job IDs. A publication is finished when `job-status` reports `status.state: "published"` **and** `owner.state: "free"`. The public feed is at `<public_base_url>/podcasts/my-show/feed.xml`; `public_base_url` is in `castloop.toml`. Staging with `update-show`, `update-episode`, or `update-episode-audio` does not publish anything. Replace the example site URL above with a real URL supplied by the administrator. See [`examples/show.toml`](examples/show.toml) and [`examples/episode.toml`](examples/episode.toml) for metadata shapes; `create-show` and `create-episode` generate working local drafts with unique IDs and timestamps.

For a metadata-only Episode revision, edit the local Episode TOML and run `update-episode ID`, then `publish-episode ID`. For an audio-only revision, run `update-episode-audio ID file.mp3`, then `publish-episode ID`. Keep the Episode GUID and original `published_at` unchanged. Old public MP3s and revision history are retained. After a successful publication, `cleanup-job JOB_ID --show my-show --episode ID` removes only its redundant staged MP3.

### Update the executable and Worker

Install the new binary to a temporary path first, then replace the old binary and deploy the embedded Worker **for each service workspace**:

```sh
npm run build:cli
install -m 0755 dist/castloop "$HOME/.local/bin/castloop.next"
mv "$HOME/.local/bin/castloop.next" "$HOME/.local/bin/castloop"
cd /path/to/workspace
castloop deploy
```

Back up `castloop.toml` and the private `.castloop/` directory before moving a workspace. Do not replace `.castloop/secrets.json` or `.castloop/state.json` when updating. `castloop deploy` extracts the Worker bundled with the current binary into `.castloop/worker.mjs` and deploys that version with Wrangler. Re-running `init` in an existing workspace resumes unfinished initialization without recreating resources.

### Troubleshooting

| Symptom | Action |
| --- | --- |
| `Wrangler CLI is missing` | Install Wrangler 4.x with Node.js/npm; set `CASTLOOP_WRANGLER` to its executable path or put it on `PATH`. |
| `init` stopped partway | Keep the workspace and run `castloop init /path/to/workspace` again. Inspect `.castloop/state.json` and Cloudflare resources if it still fails; `init` does not automatically delete resources. |
| Show ID already reserved | Use a new Show ID or inspect the existing reservation. A reservation alone does not publish a Show. |
| Local TOML or MP3 changed after staging | Re-run the corresponding `update-*` command before `publish-*`. A committed job is frozen; later edits need a new job. |
| `retrying` with `dlq: true` | Inspect `job-status` and the Show admission; after resolving the transient issue, use `castloop retry-job JOB_ID --show my-show [--episode ID]` to resume the **same** job. A DLQ record remains as history even after recovery. |
| `failed` or admission still held | Inspect job status, frozen commit, and published keys before intervening. Do not start another job for the same Show or delete its reservation while a partial publication may exist. |

The CLI reports Cloudflare failures without printing API credentials. See [`design/m2_implementation_log.md`](design/m2_implementation_log.md) and [`design/m3_implementation_log.md`](design/m3_implementation_log.md) for publication and recovery behavior.

## Development environment

- use mise to install development environment. (see .mise.toml)

```
mise install
```
- use npm to install node/javascript/typescript related packages. (see packages.json)

```
npm ci
```
- use codegraph to search codebase. codegraph cli itself is installed by mise.

```
codegraph init      # create index
```
you may need to create a sym-link from ~/.local/share/mise/shims/codegraph to ~/.local/bin to allow opencode use codegraph cli.

you don't need to run ``codegraph installl``, because this repo's AGENTS.md and opencode.jsonc contain settings for codegraph.

- use opencode v2 , MCP and skills

``.mise.toml`` doesn't contain opencode v2. you should install it manually.
``opencode.jsonc`` contains MCP settings.
``.agents/skills`` directory contains skills.

you need to set ``CLOUDFLARE_ACCOUNT_ID`` and ``CLOUDFLARE_API_TOKEN`` environment variable to use cloudflare MCP.

| Scope   | Permission         | Access |
| ------- | ------------------ | ------ |
| Account | Workers            | Admin  |
| Account | Workers R2 Storage | Edit   |
| Account | Queues             | Edit   |
| Account | Account Settings   | Read   |
| Domain  | Workers Routes     | Edit   |


```
{
  "name": "castloop-v2-dev",
  "policies": [
    {
      "effect": "allow",
      "permission_groups": [
        {
          "id": "98d78cd2433d4c3687191bc0244ef948"
        },
        {
          "id": "bf7481a1826f439697cb59a20b22293e"
        },
        {
          "id": "c1fde68c7bcc44588cbb6ddbc16d6480"
        },
        {
          "id": "28f4b596e7d643029c524985477ae49a"
        }
      ],
      "resources": {
        "com.cloudflare.api.account.YOUR_ACCOUNT_ID": {
          "com.cloudflare.api.account.zone.*": "*"
        }
      }
    }
  ],
  "condition": {}
}
```

## Source CLI (development)

The source CLI runs with Bun. From this repository, use `bun packages/cli/src/index.ts` (or `npm run cli --`). Source mode deploys `src/index.ts` from this checkout; the compiled executable deploys its embedded Worker instead.

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
bun packages/cli/src/index.ts init /path/to/workspace \
  --service-id my-service --bucket-name my-private-bucket \
  --workers-subdomain my-account-subdomain
cd /path/to/workspace
bun /path/to/castloop-v2/packages/cli/src/index.ts create-show my-show \
  --site-url https://example.com/my-show
cd my-show
bun /path/to/castloop-v2/packages/cli/src/index.ts create-episode first-episode
```

Missing arguments are prompted for on an interactive terminal. Initialization creates a private R2 bucket, Queue, DLQ, Worker and commit-marker notification. It stores non-secret service settings in `castloop.toml`; `.castloop/` contains the local admin key and retry state and must remain private. An incomplete `init` or `create-show` can be rerun with the same workspace and ID. For details and verification, see [`design/m1_implementation_log.md`](design/m1_implementation_log.md).

## Publication commands from the source checkout

Run `deploy` from the workspace root after updating the Worker source. Edit the local Show TOML and cover first. The update commands only stage inputs; publication always requires an explicit publish command.

```sh
cd /path/to/workspace
bun /path/to/castloop-v2/packages/cli/src/index.ts deploy
bun /path/to/castloop-v2/packages/cli/src/index.ts update-show my-show
bun /path/to/castloop-v2/packages/cli/src/index.ts publish-show my-show
cd my-show
bun /path/to/castloop-v2/packages/cli/src/index.ts create-episode first-episode
# Edit episode-first-episode.toml and prepare an MP3.
bun /path/to/castloop-v2/packages/cli/src/index.ts update-episode first-episode
bun /path/to/castloop-v2/packages/cli/src/index.ts update-episode-audio first-episode audio.mp3
bun /path/to/castloop-v2/packages/cli/src/index.ts publish-episode first-episode
cd ..
bun /path/to/castloop-v2/packages/cli/src/index.ts job-status JOB_ID --show my-show --episode first-episode
```

`ffprobe` must be installed for Episode audio analysis. A job showing `retrying` and `dlq: true` can be explicitly requeued with `retry-job JOB_ID --show my-show --episode first-episode`. Show jobs omit `--episode`. See [`design/m2_implementation_log.md`](design/m2_implementation_log.md) for the verified scope and recovery details.

For subsequent Episode revisions, run `update-episode ID` only when TOML changed, or `update-episode-audio ID file.mp3` only when audio changed, then `publish-episode ID`. Unchanged published inputs are reused; GUID and the original `published_at` must stay the same. A stale base revision is rejected. To remove only the redundant staged MP3 after a job is published, use `cleanup-job JOB_ID --show my-show --episode ID` from the workspace root. Published media, revision metadata, and commit markers remain available. See [`design/m3_implementation_log.md`](design/m3_implementation_log.md).
