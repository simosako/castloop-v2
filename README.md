# castloop

Serverless podcast hosting on Cloudflare: one private R2 bucket and one public Worker per service, multiple Shows, managed through a standalone CLI.

**v0.2.1 adds Show and Episode listings to the M6 lifecycle features released in v0.2.0.** It supports new M6 services and compatible updates of initialized M6 services. It does not convert or adopt v0.1.x services. The older [v0.1.2 binary](https://github.com/simosako/castloop-v2/releases/tag/v0.1.2) has different commands and no lifecycle operations; its historical instructions are in [the Linux smoke guide](docs/linux_smoke_test.md).

## Build and install

Download `castloop-linux-x64`, `SHA256SUMS`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` from the [v0.2.1 release](https://github.com/simosako/castloop-v2/releases/tag/v0.2.1). Run `sha256sum --check SHA256SUMS` in the download directory before installing the binary. `castloop --version` must report `0.2.1`.

The build machine needs Bun 1.4.2 and Node.js/npm:

```sh
npm ci
npm run check
bun test
npm run build:cli -- linux-x64
sha256sum dist/castloop-linux-x64
install -m 0755 dist/castloop-linux-x64 "$HOME/.local/bin/castloop"
castloop --version
```

The target Linux x86-64 machine needs no Bun, Node.js, Wrangler, source tree, `ffprobe`, or R2 S3 credentials. Enable R2 and Queues and supply an account-scoped Cloudflare API token with Workers Scripts, Workers R2 Storage, and Queues permissions. Never store it in TOML or Git. Experimental macOS/Windows cross-builds are not distributed or runtime-verified.

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
cd my-show
castloop create-episode first
# Edit episode-first.toml and provide an MP3.
castloop update-episode first
castloop update-episode-audio first audio.mp3
castloop publish-episode first audio.mp3
cd ..
castloop job-status EPISODE_JOB_UUID
```

Use the `pause_id` from `service-status`, not a newly generated ID, to resume. Replace the example website with the administrator's real site URL. A publish receipt means submitted, not finished: wait for `server_status.status.state: "published"` and `server_status.ownership: "released"` before another operation on that Show. The feed is `<public_base_url>/podcasts/my-show/feed.xml`; settings are in `castloop.toml`.

Updates stage inputs without publishing. For metadata-only Episode revisions, run `update-episode ID`, then `publish-episode ID` **without an MP3 argument**. For audio-only revisions, run `update-episode-audio ID file.mp3`, then `publish-episode ID file.mp3`. Whenever audio is staged, publication requires the unchanged original MP3. Keep GUID and `published_at` unchanged. Normal revisions retain immutable published media and history.

MP3s are limited to 300,000,000 bytes. The CLI validates duration, uploads and reads back the complete object to verify its size/SHA-256 and identity. The Worker checks that evidence against R2 HEAD; R2 verifies SHA-256 when saving immutable published audio. Workers Paid is not required by this implementation. Staging audio has no automatic expiration or general cleanup command in this MVP.

## List Shows and Episodes

These commands require **both the v0.2.1 CLI and a Worker deployed from that build**; updating only the CLI is insufficient. For an existing v0.2.0 M6 service, use the compatible-update procedure below. No Cloudflare resources are updated merely by listing or installing the executable.

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
- Operations do not interrupt unfinished uploads/publications. Check lifecycle status for completed/released ownership, not just a commit receipt.

## Compatible Worker updates

Back up `castloop.toml` and the private `.castloop/` directory, replace the executable with the verified new build, then run from each **already initialized M6** workspace:

```sh
castloop service-pause NEW_PAUSE_UUID
castloop service-status
# Wait for invocations to settle and unfinished Show owners to complete.
castloop deploy
castloop service-status
castloop service-resume NEW_PAUSE_UUID
```

Pause temporarily stops delivery and new mutations. Paused does not necessarily mean drained. Deployment preserves data, media URLs and secrets, verifies the new runtime, and remains paused until explicit resume. There is no legacy conversion, resource adoption, automatic rollback or zero-downtime update in this MVP.

## Errors and recovery limits

Preserve the workspace, journals, locks and remote owners after any error. Do not rerun unknown requests, delete locks, replace administrator secrets or release tokens because time elapsed or HEAD found no object. An unknown/forcibly interrupted invocation can remain blocked; universal recovery is outside this MVP.

- `local-operation-status FAMILY ID` inspects local records without credentials or network access. `operation-status FAMILY ID` compares them with authenticated server status. Families: `staging`, `publication`, `lifecycle`, `show-registration`.
- Historical jobs may report `ownership: "superseded"` after a later operation. Use `target-show ID` or `target-episode SHOW_ID EPISODE_ID` for current ownership; this does not authorize retrying an old job.
- Read-only inspections can be unverified while progress changes. Repeat only read-only inspection; never replay a mutation or release ownership on that basis.
- `retry-job JOB_UUID` and `lifecycle-retry JOB_UUID REQUEST_SHA256 ACK` explicitly retry the same acknowledged commit only when execution has safely settled; they refuse active/unknown execution.
- `init-reconcile OPERATION_UUID` and `update-service-reconcile OPERATION_UUID` reconcile already completed, paused server operations with retained local requests. They do not repeat deployments. `update-service-verify OPERATION_UUID` continues only an acknowledged deployment's verification.
- Initialization journals are `.castloop/service-initializations/SERVICE_ID.json`; update journals are `.castloop/service-updates/SERVICE_ID/OPERATION_UUID.json`. Retain these and their locks. Re-running `init` is not a recovery method for a started operation.
- HTTP 403: check account/token scope and permissions. Local inputs changed after staging: restage only an editable, unclaimed draft; committed/unknown operations stay frozen.

The single REST PUT recovery model retains [unverified assumption U1](design/m6_upload_recovery_options.md): a PUT is assumed not to write later after client disconnection. This is not a Cloudflare guarantee. Owner/generation checks and explicit IO settlement remain required.

## Development and release scope

Use `castloop help COMMAND` for syntax. Source mode is `bun packages/cli/src/index.ts`; it bundles `src/worker.ts`, while compiled binaries contain the Worker. Test-only fault injection and cache nonce headers are excluded from the formal entry points. Do not commit `.castloop/`, credentials or unpublished media.

[M6 acceptance](design/m6_standalone_acceptance.md) and [approved scope](design/m6_review_queue.md) describe verified behavior and its limits. See the [v0.2.1 release notes](docs/release-v0.2.1.md) and [v0.2.0 release notes](docs/release-v0.2.0.md) for the published scope. Custom domains, old-format conversion, zero-downtime migration and cost/downtime measurement follow the MVP. Existing Cloudflare resources are not automatically deleted.

The [release workflow](.github/workflows/build-binaries.yml) builds/checks Linux x86-64 artifacts and publishes on a matching `v*` tag. Include [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with redistributed binaries. castloop uses the MIT License.
