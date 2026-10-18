# castloop

Serverless podcast hosting on Cloudflare, managed with a standalone CLI: one private R2 bucket and one public Worker per service, multiple Shows.

**v0.6.0 supports SQLite services only.** `castloop init` creates a schema-version-2 service by default. Queue/R2 service support, its Worker bundle and commands have been removed. Content metadata and SQLite request formats are unchanged. Installing this release does not deploy or change an existing Cloudflare service. See the [release notes](docs/release-v0.6.0.md).

The CLI uploads and verifies unique R2 objects, then explicitly submits a frozen publication request to one Durable Object per service. Its SQLite FIFO and Alarms execute one job at a time, without Cloudflare Queues or D1. Local TOML remains the editable source; R2 holds published files and SQLite holds control state.

The v0.6.0 trial published 36 full-size Episodes (1.50GB) in **485.53 seconds**, plus three short Episodes. All 39 audio hashes and delivery checks passed, including preservation after a Worker update. Saved logs showed outer/cache HTTP CPU maxima of **3/5ms**, below the Workers Free 10ms target for the captured requests. This is not proof of complete log capture, every workload's Free compatibility, or permanent resolution of [Issue #13](https://github.com/simosako/castloop-v2/issues/13). See the [acceptance and CPU record](design/schema_v1_removal_live_test.md).

## Supported service configuration

Only `schema_version = 2` with `publication_protocol = "sqlite-sequential-v1"` is supported. Publication, listings, RSS import, unpublish/restore and same-config/schema/namespace code-only updates are available. Physical deletion, custom domains and blocked-job retry/release are not supported.

Service schema version 1 is rejected before management requests, deployment or administrator-key/journal creation. There is **no schema-version-1 migration feature**: do not edit schema/protocol fields, adopt old resources or convert retained journals. Existing Queue services require a compatible **v0.5.x CLI and Worker**, maintained separately; see the [v0.5.x-only Queue guide](docs/queue_service.md). Installing this CLI does not change, pause, delete or harden an existing deployed Worker. Shared Show/Episode metadata still uses its independent `schema_version = 1`.

## Install

Download `castloop-linux-x64`, `SHA256SUMS`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` from the [v0.6.0 release](https://github.com/simosako/castloop-v2/releases/tag/v0.6.0). Verify the checksum, make the executable runnable, and place it on your PATH:

```sh
sha256sum --check SHA256SUMS
chmod +x castloop-linux-x64
./castloop-linux-x64 --version
```

Keep the matching old CLI/source for frozen initialization/update journals. Existing Queue services need [v0.5.x](https://github.com/simosako/castloop-v2/blob/v0.5.2/README.md), not this release; there is no automatic migration.

Keep `LICENSE` and `THIRD_PARTY_NOTICES.md` with the executable. Linux x86-64 is the distributed and runtime-verified target; macOS/Windows binaries are not distributed.

The administrator's machine needs no Bun, Node.js, Wrangler, source tree, `ffprobe`, or separate R2 S3 credentials. Enable the required Cloudflare products and supply `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. SQLite initialization needs Worker/R2 resource and deployment permissions and access to SQLite-backed Durable Objects; it does not need Queues Edit. The CLI never expands token permissions or changes billing/CPU limits automatically.

### Build from source

Use Bun 1.4.2 and Node.js 24/npm on the build machine:

```sh
npm ci
npm run check
bun test
npm run build:cli -- linux-x64
```

The executable is `dist/castloop-linux-x64` and embeds only `src/sqlite-worker.ts`. Source mode is `bun packages/cli/src/index.ts`. See `castloop help COMMAND` for syntax.

## Initialize a new SQLite service

Use a new workspace and unused resource names. Substitute your Cloudflare account's workers.dev subdomain and a fresh UUID for each operation/window:

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
castloop init /path/to/workspace \
  --service-id my-service --bucket-name my-private-bucket \
  --workers-subdomain my-account-subdomain --operation-id INIT_UUID
cd /path/to/workspace
castloop service-status
castloop service-resume NEW_WINDOW_UUID
```

Initialization defaults to schema version 2; the existing `--publication-protocol sqlite-sequential-v1` flag remains optional. It verifies the actual Worker/version/namespace and an Alarm/R2/cache/purge probe, then finishes **paused**. It never adopts existing resources. Resume requires a **new admission-window UUID**, not the init/pause UUID.

Keep `castloop.toml` and private, git-ignored `.castloop/` state together and backed up. The latter contains the administrator key and journals: TOML alone is not a complete workspace. Never commit credentials, journals or unpublished audio. Since v0.5.1 `castloop.toml` must be a regular file of 1–16,384 bytes; a symlinked, FIFO, oversized or non-UTF-8 configuration is rejected before any management request or local state is created.

## Publish a Show and Episode

```sh
castloop create-show my-show --site-url https://your-real-site.example/podcast
# Edit my-show/show.toml and provide the JPEG/PNG named in image_path.
castloop update-show my-show
castloop publish-show my-show
cd my-show
castloop create-episode first
# Edit episode-first.toml and prepare audio.mp3.
castloop update-episode first
castloop update-episode-audio first audio.mp3
castloop publish-episode first
cd ..
castloop job-status EPISODE_JOB_UUID
```

Use a real website URL and the returned job ID. Show commands run at the service root; Episode commands run in the Show directory. `create-*` never publishes. `update-*` uploads verified inputs without publication. **Only `publish-*` submits**, then waits for the exact job's `succeeded` status. A queued/accepted response is not success. `job-status` returns `status.state`; `succeeded` proves that operation's writes, purge and SQL completion, not global quiescence.

For a metadata-only update, edit the TOML, run `update-episode ID`, then `publish-episode ID`. For audio-only, run `update-episode-audio ID new.mp3`, then `publish-episode ID`. Publication does not need an MP3 argument after staging; an optional argument must match the staged source. Preserve GUID and `published_at`; published media and revision history are immutable during normal updates.

The feed is `<public_base_url>/podcasts/my-show/feed.xml`. Covers must be JPEG/PNG; a published cover's extension cannot change. MP3 input is limited to **300,000,000 bytes** and is fully read back to verify size/hash before submission. The new SQLite route's native 300MB publication remains untested; earlier Queue-path acceptance is not a substitute. Staging/audio has no automatic retention cleanup.

## List, unpublish and restore

```sh
castloop list-shows
castloop list-episodes my-show --json
castloop list-episodes my-show --cursor 'TOKEN_FROM_PREVIOUS_PAGE'
castloop preview-episode-lifecycle my-show first unpublish > plan.json
# Review plan.json and copy its request_sha256.
castloop lifecycle-execute plan.json REQUEST_SHA256 confirm
castloop job-status JOB_UUID
```

Listings return up to 20 entries per page; follow `next_cursor`. Local-only drafts are not listed. Snapshot listings do not authorize changes or recovery.

Use `restore` instead of `unpublish`, or `preview-show-lifecycle my-show ACTION` for a Show. Preview is read-only; execution queues the reviewed request and requires the same job's `succeeded` status. Restore uses saved snapshots, not local edits, and preserves GUID/date/audio. Restoring a Show does not revive individually unpublished Episodes. Unpublish retains payloads and does not reduce storage. **SQLite physical deletion and domain operations are not implemented.**

## RSS import

```sh
castloop import-rss imported-show https://old-host.example/feed.xml --dry-run
castloop import-rss imported-show https://old-host.example/feed.xml --output /path/to/import
# Review the downloaded TOML, cover, MP3s and warnings before publishing.
castloop publish-rss-import /path/to/import
```

Run publication from the service root. Imports create a new Show, preserve GUIDs/dates and publish sequentially; completed Episodes become public before the entire import finishes. Subscriber migration, recurring sync, adoption of existing Shows and removal of the old host are not performed. See [RSS usage](docs/rss_migration.md).

## Update an existing SQLite Worker

Back up the retained workspace. Replace the executable, then explicitly pause and drain before a same-config/schema/namespace code-only update:

```sh
castloop service-pause PAUSE_OPERATION_UUID
castloop service-status
# Continue only when publication_ready, paused and drained are confirmed.
castloop deploy --operation-id UPDATE_UUID
castloop service-status
castloop service-resume NEW_WINDOW_UUID
```

An already paused service does not need a second pause request. Update verifies the exact deployed version and new Alarm/R2/cache/purge readiness and finishes paused. It does not convert schemas, change domains/configuration, force-release blocked jobs, or replay unknown deployments. See [update/recovery details](docs/sqlite_sequential_development.md#互換worker更新).

**Recovery continuation (since v0.5.2):** `castloop update-service-verify UPDATE_UUID` also continues REST verification from an acknowledged PUT or a pinned deployment after a GET failure, not only from `verified`. It requires the exact frozen inputs and rechecks the acknowledged ETag, deployment/version, namespace and server maintenance request before the first activation/probe. It never repeats PUT/preparation or a previously requested activation. Older receipt-free `deploy_requested` journals remain blocked; see the [recovery contract](design/sqlite_worker_update_recovery.md).

## Errors and recovery

- Preserve `.castloop/`, frozen requests and uploads. Inspect the same `job-status` and `service-status`; never replace unknown jobs or remove locks because time elapsed.
- SQLite management GETs retry transient transport/body failures and selected transient HTTP statuses up to three attempts. Publication polling counts actual GETs toward 300 and starts none after five minutes. POST/PUT mutations are **never automatically retried**.
- `failed` means a deterministic pre-write input/base failure; `blocked` preserves uncertain/unfinished execution and stops the FIFO. SQLite retry/release is not provided. An empty queue does not prove unregistered uploads ended.
- `init-reconcile` and `update-service-reconcile` only reconcile exact, already-completed server evidence. Limited explicit verification continuations exist for acknowledged deployment journals; they do not repeat resource creation/deploy or adopt unknown versions.

See the [SQLite operations guide](docs/sqlite_sequential_development.md), [v0.6.0 development changes](docs/release-v0.6.0.md), [v0.5.2 release notes](docs/release-v0.5.2.md), and [design index](design/README.md). Existing Queue environments must keep v0.5.x and use its [separate guide](docs/queue_service.md). No release, install or test completion automatically deploys, resumes, cleans up or deletes Cloudflare resources.

The [release workflow](.github/workflows/build-binaries.yml) tests, builds and smoke-checks Linux artifacts before publishing matching `v*` tags. castloop uses the MIT License; redistribute [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with the binary.
