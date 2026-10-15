# castloop

Serverless podcast hosting on Cloudflare: one private R2 bucket and one public Worker per service, multiple Shows, managed through a standalone CLI.

**v0.4.0 adds one-time RSS migration and publication performance/diagnostic improvements**, retaining Show/Episode publication, listings, unpublishing, restoration, deletion, and custom domains. It supports new M6 services and compatible updates of initialized M6 services. It does not convert or adopt v0.1.x services. The older [v0.1.2 binary](https://github.com/simosako/castloop-v2/releases/tag/v0.1.2) has different commands and no lifecycle operations; its historical instructions are in [the Linux smoke guide](docs/linux_smoke_test.md). The [design overview](design/initial_design.md) describes the current architecture and development history.

**Known limitation:** observed publication HTTP CPU was 15–34ms, above the Workers Free 10ms target. This release does not guarantee stable Free-tier operation or complete resolution of [Issue #13](https://github.com/simosako/castloop-v2/issues/13). No paid-plan change is automatic. See the [v0.4.0 release notes](docs/release-v0.4.0.md).

**Development branch:** `feat/publication-queue-submit` now implements [option C: Queue/R2 management](design/async_management_implementation.md), not included in v0.4.0. Content updates submit `stage-start`, wait for an authenticated R2 grant, upload directly to private R2, then submit `upload-complete`. Explicit publication delegates claim/commit/publication to Queue; new job polling reads compact authenticated R2 results, without castloop management HTTP. Both development CLI and an updated, verified Worker with `runtime_readiness.management_protocol: "queue-management-v1"` are required, along with Cloudflare credentials and Queues Edit. `publication-queued` / journal `async_queued` proves enqueue only; wait for `server_status.response.state: "published"` on `job-status`. Unknown submissions are never resent or sent through an HTTP fallback; async retry/release is not provided. Registration, standalone target inspection, service controls, listings, lifecycle, and deployment retain their existing HTTP paths. [Isolated live measurement](design/async_management_measurement_20261015.md) completed seven publications with no observed management HTTP; Queue publication CPU was median/max 238/410ms. Public feed GET still reached 11ms, and normal metadata-update total wall increased from the earlier stage A median 110.4s to 172.5s. This is not service-wide Free readiness or permanent Issue #13 resolution. No resources or token permissions are changed automatically.

## Build and install

### Install the release binary

Download `castloop-linux-x64`, `SHA256SUMS`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` from the [v0.4.0 release](https://github.com/simosako/castloop-v2/releases/tag/v0.4.0). In the download directory:

```sh
sha256sum --check SHA256SUMS
mkdir -p "$HOME/.local/bin"
install -m 0755 castloop-linux-x64 "$HOME/.local/bin/castloop"
export PATH="$HOME/.local/bin:$PATH"
castloop --version
```

The version must be `0.4.0`. Keep the two license files with the binary and add `$HOME/.local/bin` to your shell's PATH for future sessions.

The target Linux x86-64 machine needs no Bun, Node.js, Wrangler, source tree, `ffprobe`, or R2 S3 credentials. Enable R2 and Queues and supply an account-scoped Cloudflare API token with Workers Scripts, Workers R2 Storage, and Queues read/write permissions. Never store it in TOML or Git. Experimental macOS/Windows cross-builds are not distributed or runtime-verified.

### Build from source

The build machine needs Bun 1.4.2 and Node.js 24/npm:

```sh
npm ci
npm run check
bun test
npm run build:cli -- linux-x64
sha256sum dist/castloop-linux-x64
```

The binary is written to `dist/castloop-linux-x64`; install it in place of the downloaded binary above. Wrangler is not part of this build path.

## Initialize and publish

Use unused resource names and a new workspace. Initialization verifies the deployed runtime and completes **paused**. It does not adopt existing resources or automatically resume.

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
castloop init /path/to/workspace \
  --service-id my-service --bucket-name my-private-bucket \
  --workers-subdomain my-account-subdomain
cd /path/to/workspace
castloop service-status
castloop service-resume PAUSE_UUID
castloop create-show my-show --site-url https://your-real-site.example/podcast
# Edit my-show/show.toml and provide the JPEG/PNG named in image_path.
castloop update-show my-show
castloop publish-show my-show
castloop job-status SHOW_JOB_UUID
# Repeat job-status until published and ownership released before continuing.
cd my-show
castloop create-episode first
# Edit episode-first.toml and provide an MP3.
castloop update-episode first
castloop update-episode-audio first audio.mp3
castloop publish-episode first audio.mp3
cd ..
castloop job-status EPISODE_JOB_UUID
```

Use `admission.pause_id` from `service-status`, not a newly generated ID, to resume. Replace the example website with the administrator's real site URL. Use the `job_id` from each publish response for `job-status`. A publish receipt means submitted, not finished: wait for `server_status.status.state: "published"` and `server_status.ownership: "released"` before another operation on that Show. The feed is `<public_base_url>/podcasts/my-show/feed.xml`; settings are in `castloop.toml`.

Show commands run from the service root; Episode create/update/publish commands run from the Show directory. `create-episode` creates only a local TOML, not a server reservation. Initialization adds `.castloop/` and `*.mp3` to `.gitignore`. Keep `.castloop/` private and back it up: it contains the administrator key and operation journals needed for status and recovery. A Git checkout of the TOML files alone is not a complete administration workspace.

Updates stage inputs without publishing. For metadata-only Episode revisions, run `update-episode ID`, then `publish-episode ID` **without an MP3 argument**. For audio-only revisions, run `update-episode-audio ID file.mp3`, then `publish-episode ID file.mp3`. Whenever audio is staged, publication requires the unchanged original MP3. Keep GUID and `published_at` unchanged. Normal revisions retain immutable published media and history.

Use JPEG or PNG cover art; a published Show's cover extension cannot be changed. Restore unpublished content before editing it. A future `published_at` does not schedule publication: only an explicit publish command starts it.

MP3s are limited to 300,000,000 bytes. The CLI validates duration, uploads and reads back the complete object to verify its size/SHA-256 and identity. The Worker checks that evidence against R2 HEAD; R2 verifies SHA-256 when saving immutable published audio. The earlier 300 MB acceptance does not establish that v0.4.0's HTTP endpoints meet Free-tier CPU limits. Staging audio has no automatic expiration or general cleanup command in this MVP.

## List Shows and Episodes

These commands require **both a CLI and a Worker with listing support (v0.2.1 or later)**; updating only the CLI is insufficient. For an existing v0.2.0 M6 service, use the compatible-update procedure below. No Cloudflare resources are updated merely by listing or installing the executable.

Run from the service workspace with its retained administrator key. Listing does not require `CLOUDFLARE_API_TOKEN`:

```sh
castloop list-shows
castloop list-episodes my-show
castloop list-shows --include-deleted
castloop list-episodes my-show --json
castloop list-shows --cursor 'TOKEN_FROM_PREVIOUS_PAGE'
```

`SHOW_ID` is required for `list-episodes`. Default output is a concise table; `--json` returns the structured response. Both commands inspect server control records, including drafts, unpublished content and deletion in progress. Deleted IDs are hidden unless `--include-deleted` is supplied. Local-only Episode TOML drafts are not included.

Each request scans at most 20 control records in ID order. Continue with the returned `next_cursor` and the same Show/options; a page can be empty after filtering deleted entries while still having a next cursor. Titles are summaries of published metadata, limited to 100 characters; metadata larger than 16 KiB, missing/invalid metadata, unfinished operations, never-published drafts and removed payloads can leave a title/date unavailable. Episode state, parent Show state and service pause are distinct. Feed URLs and snapshot states do not certify delivery or authorize mutations. No audio, revision history or job inventory is scanned, and no locks or owners are released.

## Unpublish, restore, or delete

Run from the service workspace. Preview is read-only; save and review the exact target, action and request hash:

```sh
castloop preview-episode-lifecycle my-show first unpublish > plan.json
# Read plan.json and copy preview.request_sha256.
castloop lifecycle-execute plan.json REQUEST_SHA256 confirm
castloop operation-status lifecycle JOB_UUID
```

Replace `unpublish` with `restore` or `delete`. For a whole Show, use `preview-show-lifecycle my-show ACTION`. Delete requires **`confirm-delete-retain-records`** instead of `confirm`. Never substitute a new preview after confirmation; stale generations are rejected.

- Unpublish hides content with HTTP 404; restore preserves GUID, revisions and media.
- Delete physically removes payloads and is irreversible. Deleted IDs cannot be reused. Necessary small reservations, tombstones, frozen requests, commit markers and status/progress records are retained indefinitely without copying content text or secrets.
- Deleting/deleted content returns 410. Public responses require cache revalidation; `system/` and `staging/` are never public.
- Operations do not interrupt unfinished uploads/publications. Wait for `server_status.status.state: "completed"` and `server_status.ownership: "released"`, not just a commit receipt. Restoring a Show preserves each Episode's own state; separately unpublished Episodes stay unpublished.

## Compatible Worker updates

Back up `castloop.toml` and the private `.castloop/` directory, replace the executable with the verified new build, then run from each **already initialized M6** workspace. If it is already paused, skip `service-pause` and use its existing `admission.pause_id` instead of a new UUID.

Obtain all Show IDs with `list-shows --include-deleted`, following every `next_cursor`. For a v0.2.0 Worker without listing support, inspect the bucket's `system/show-publications/` prefix in Cloudflare instead. Do not treat an empty page or local directories as a complete inventory.

```sh
castloop service-pause NEW_PAUSE_UUID
castloop service-status
# Repeat target-show for every Show ID, including deleted IDs.
castloop target-show SHOW_ID
# Continue only when admission.invocations is [] and every
# target-show reports unfinished_show_operation: false.
castloop deploy
castloop service-status
castloop service-resume NEW_PAUSE_UUID
```

Pause blocks new mutations; v0.3.0 and later Workers also return HTTP 503 for paused public delivery. Paused does not necessarily mean drained, and an HTTP response alone is not proof that old operations ended. Deployment preserves data, media URLs and secrets, verifies the new runtime, and remains paused until explicit resume. There is no legacy conversion, resource adoption, automatic rollback or zero-downtime update in this MVP. Installing a binary or publishing a release does not update Cloudflare Workers automatically. v0.4.0 publication requires both the new CLI and its deployed Worker; mixed publication protocols are rejected. Do not downgrade after using external GUIDs or the new Episode catalog.

## Custom domains

v0.3.0 and later provide `domain add HOSTNAME`, `domain list`, and `domain remove`, with one hostname per service. Use an active/full Cloudflare Zone in the same account; check Workers Scripts Write, Zone Read, and DNS Read permissions. Upgrade an existing M6 Worker with the compatible-update procedure above before using these commands.

Domain operations require explicit pause/drain and finish paused; resume explicitly after checking completion. `public_base_url` is the canonical Podcast URL, while `workers_dev_base_url` remains the same Worker's HTTPS workers.dev origin for CLI administration. Both hosts serve the same public content without redirects. DNS/TLS probes send no secrets. Removal restores workers.dev URLs without deleting media, revisions or GUIDs; normal deployment preserves a matching Custom Domain connection.

See [custom-domain usage and recovery](docs/custom_domains.md) for commands and recovery limits. Do not manually change these settings on a running service. Podcast directory URL changes are the administrator's responsibility; subscription migration and redirects are not provided.

## Errors and recovery limits

Preserve the workspace, journals, locks and remote owners after any error. Do not rerun unknown requests, delete locks, replace administrator secrets or release tokens because time elapsed or HEAD found no object. An unknown/forcibly interrupted invocation can remain blocked; universal recovery is outside this MVP.

- `local-operation-status FAMILY ID` inspects local records without credentials or network access. `operation-status FAMILY ID` compares them with authenticated server status. Families: `staging`, `publication`, `lifecycle`, `show-registration`.
- Historical jobs may report `ownership: "superseded"` after a later operation. Use `target-show ID` or `target-episode SHOW_ID EPISODE_ID` for current ownership; this does not authorize retrying an old job.
- Read-only inspections can be unverified while progress changes. Repeat only read-only inspection; never replay a mutation or release ownership on that basis.
- `retry-job JOB_UUID` and `lifecycle-retry JOB_UUID REQUEST_SHA256 ACK` explicitly retry the same acknowledged commit only when execution has safely settled; they refuse active/unknown execution.
- `release-job` / `publication-release` are disabled. DLQ history, elapsed time, and absent objects do not prove that old I/O ended and never authorize token release.
- `init-reconcile OPERATION_UUID` and `update-service-reconcile OPERATION_UUID` reconcile already completed, paused server operations with retained local requests. They do not repeat deployments. `update-service-verify OPERATION_UUID` continues only an acknowledged deployment's verification.
- In v0.4.0, `update-service-continue OPERATION_UUID` explicitly continues an uploaded Worker only when its schema-v2 journal records `activation_checkpoint.state = "not_started"`. It rechecks the same retained server owner, frozen settings, original deployment, latest two versions/sequence and uploaded script ETag before activating that exact version once. It never re-uploads, rolls back or resumes delivery; successful runtime verification finishes paused. Use `update-service-verify` instead if both upload and deployment receipts were saved.
- Legacy schema-v1 upload-only journals (including Issue #11's interrupted operation) cannot prove activation never started and remain blocked. Do not edit/upgrade their journals, manually activate, infer safety from the old deployment, or clear owners/locks. Schema-v2 `"requested"` without a deployment receipt also remains blocked, even if no POST seems visible or time has elapsed. A caught pre-activation GET failure can retain a continuable checkpoint; a forcibly interrupted process with a residual lock cannot. A legacy `prepared` journal cannot start the new protocol; only use a new operation ID after independently confirming the service is paused/drained and the old operation never began.
- Initialization journals are `.castloop/service-initializations/SERVICE_ID.json`; update journals are `.castloop/service-updates/SERVICE_ID/OPERATION_UUID.json`. Retain these and their locks. Re-running `init` is not a recovery method for a started operation.
- HTTP 403: check account/token scope and permissions. Local inputs changed after staging: restage only an editable, unclaimed draft; committed/unknown operations stay frozen.

The single REST PUT recovery model retains [unverified assumption U1](design/m6_upload_recovery_options.md): a PUT is assumed not to write later after client disconnection. This is not a Cloudflare guarantee. Owner/generation checks and explicit IO settlement remain required.

## RSS migration and publication acceptance

v0.4.0 provides `import-rss SHOW_ID RSS_URL --dry-run`, `import-rss SHOW_ID RSS_URL --output DIRECTORY`, and `publish-rss-import DIRECTORY` for one-time RSS migration into a new Show. Download and review locally before explicit sequential publication. GUIDs and publication dates are preserved; recurring synchronization, adoption of an existing Show, and subscriber migration are not provided. See [RSS migration usage and recovery](docs/rss_migration.md) and the [approved plan](design/m7_rss_import_plan.md).

v0.4.0 publication uses the `queue-validation-v1` acceptance protocol. Update both CLI and Worker: `publish-show`/`publish-episode` return `publication-accepted`, and the HTTP `202 accepted` receipt confirms a frozen request/marker, not validation or publication success. The existing Queue consumer validates staged inputs before public writes. Wait for `published / released`. Deterministic pre-write input failures report `failed / validation_failed`; preserve the held Show owner and frozen draft, and do not retry, edit or force-release them. Legacy `committed` journals remain readable without automatic conversion. See [HTTP acceptance design](design/http_publication_commit_optimization_plan.md).

RSS publication waits for each acknowledged job for at most 300 status attempts and starts no new status request after five minutes. An in-flight HTTP request has its own timeout. A pending job retains its cursor; rerunning the same import inspects that job without replaying publication. The [direct Queue submission proposal](design/publication_queue_delegation_options.md) is future development, not part of v0.4.0.

The [design document index](design/README.md) separates current references from archived development history.

Use `castloop help COMMAND` for syntax. Source mode is `bun packages/cli/src/index.ts`; it bundles `src/worker.ts`, while compiled binaries contain the Worker. Test-only fault injection and cache nonce headers are excluded from the formal entry points. Do not commit `.castloop/`, credentials or unpublished media.

[M6 acceptance](design/archive/m6_standalone_acceptance.md) and [approved scope](design/m6_review_queue.md) describe verified behavior and its limits. See the [v0.4.0 release notes](docs/release-v0.4.0.md), [v0.3.0 release notes](docs/release-v0.3.0.md), [v0.2.1 release notes](docs/release-v0.2.1.md), and [v0.2.0 release notes](docs/release-v0.2.0.md) for the published scope. Old-format conversion, zero-downtime migration and cost/downtime measurement remain outside the MVP. Existing Cloudflare resources are not automatically deleted.

Existing M6 workspaces without `workers_dev_base_url` retain their original workers.dev URL and configuration hash until an owned domain change saves the field. [Live Cloudflare acceptance passed](https://github.com/simosako/castloop-v2/blob/7e57cac5b22435c54d68d0a6edc9a28e2285ff71/design/acceptance/custom-domains/20261011-run4/run4/result.md), including removal and restored workers.dev delivery. Earlier interrupted trial operations remain retained; their unknown requests or tokens are not released by this version.

The [release workflow](.github/workflows/build-binaries.yml) builds/checks Linux x86-64 artifacts and publishes on a matching `v*` tag. Include [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with redistributed binaries. castloop uses the MIT License.
