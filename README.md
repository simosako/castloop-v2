# castloop

[![Latest release](https://img.shields.io/github/v/release/simosako/castloop-v2)](https://github.com/simosako/castloop-v2/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Serverless podcast hosting on Cloudflare, managed with a standalone CLI: one private R2 bucket and one Worker per service, multiple Shows.

**Early beta.** Commands and persisted formats can change incompatibly. v0.8.0 completes architecture simplification [Phases 1–4](design/README.md): direct media placement, synchronous atomic publication, on-demand RSS and builtin-site rendering, and simplified deploy/runtime control. It requires fresh internal queue/content formats **14/13**; older formats are not migrated. An isolated, Access-protected Cloudflare smoke test verified service initialization, a Show, three published Episodes and builtin-site audio playback. Native performance, full Free-plan compatibility and broader runtime behavior remain unverified. See the [v0.8.0 release notes](docs/release-v0.8.0.md).

The CLI validates local TOML/media, places content-addressed media in private R2, and explicitly sends metadata plus media references to the target Show DO. After validation and required cache purges, one SQLite transaction commits content, revisions and delivery generations. Each Show has independent SQLite state; a small control DO tracks Show registration, catalog listing and custom domain state. No Cloudflare Queues or D1 are used.

## Install and build

Download the matching binary, `SHA256SUMS`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` from the [latest release](https://github.com/simosako/castloop-v2/releases/latest). Released binaries do not include unreleased branch changes.

| Platform | Binary |
| --- | --- |
| Linux x86-64, glibc | `castloop-linux-x64` |
| macOS Apple Silicon, macOS 11+ | `castloop-macos-arm64` |
| Windows x64, Windows 10+ | `castloop-windows-x64.exe` |

Verify the downloaded checksum (`sha256sum`, `shasum -a 256`, or PowerShell `Get-FileHash -Algorithm SHA256`). On Unix, make the binary executable. Binaries are unsigned; see the [distribution guide](docs/cli_binary_distribution.md) for platform limitations.

The administrator needs no Bun, Node.js, Wrangler, ffprobe or separate R2 S3 credentials. Supply `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with the required Worker/R2/SQLite DO permissions. The CLI never expands permissions or changes billing/CPU limits.

Build this branch with Bun and Node.js/npm:

```sh
npm ci
npm run check
bun test
npm run build:cli -- linux-x64
```

The executable is `dist/castloop-linux-x64` and embeds only `src/sqlite-worker.ts`. Source mode is `bun packages/cli/src/index.ts`. See `castloop help COMMAND` for syntax.

## Initialize a new service

Use a new workspace and unused resource names:

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
castloop init /path/to/workspace \
  --service-id my-service --bucket-name my-private-bucket \
  --workers-subdomain my-account-subdomain --operation-id INIT_UUID
cd /path/to/workspace
castloop service-status
```

Only fresh `schema_version = 2`, `publication_protocol = "sqlite-sequential-v1"`, `storage_layout = "show-v1"` services with matching internal formats are supported. Shared content metadata independently uses schema version 1. Old layouts and service schema version 1 are rejected; do not edit old settings to bypass this boundary. Existing Queue services require the [v0.5.x CLI/Worker](docs/queue_service.md).

Initialization verifies the deployed Worker, namespace and runtime readiness. A newly registered Show is immediately ready for publication. Existing resources are never adopted.

## Publish a Show and Episode

```sh
castloop create-show my-show --site-url https://your-real-site.example/podcast
# Alternatively: create-show my-show --site-mode builtin
# Edit my-show/show.toml and provide the JPEG/PNG named in image_path.
castloop preview-show my-show --remote --json
castloop publish-show my-show --expect-preview REVIEWED_HASH
cd my-show
castloop create-episode first
# Edit episode-first.toml and prepare audio.mp3.
castloop preview-episode first audio.mp3 --remote --json
castloop publish-episode first audio.mp3 --expect-preview REVIEWED_HASH
```

`create-*` and `preview-*` do not publish. `publish-*` performs validation, media placement and explicit publication in one command. A successful response contains `changed` or `unchanged` and the current `revision_id`; it is not a queued-job acknowledgement. Identical content does not create history, generations or cache purges. Publication jobs and the old `update-*`, `operation-*`, `job-status`, `progress` and `watch` commands have been removed.

For metadata-only updates, edit TOML and run `publish-episode ID` without MP3. To change audio, supply `publish-episode ID new.mp3`; first publication requires MP3. Preserve GUID and publication date. Published audio and revision history remain available across normal updates.

MP3s are limited to **300,000,000 bytes**, covers to **5,000,000 bytes**. The CLI freezes/validates local media and compares it with the published reference: unchanged media is reused without any R2 request, while changed or initial media is PUT once with source consumption plus the PUT HTTP 200/`success`/key/size acknowledgement. It does not download the uploaded body again; the DO does not read or copy media during publication. If a publication is interrupted after a successful PUT, rerunning the same inputs simply PUTs the same content to the same content-hash key again. Unreferenced media is not automatically deleted.

The feed is `<public_base_url>/podcasts/my-show/feed.xml`. Cover URLs remain stable; changing a published cover's extension is unsupported. Builtin websites have 20-Episode listing pages, short Episode URLs, optional CSS and `site_timezone`; feeds/HTML are generated on demand from committed SQLite content. See the [website guide](docs/show_website.md).

## Scheduled publication

```sh
castloop preview-episode-schedule first audio.mp3 --workspace . --show my-show --at '2026-11-01T10:00:00Z' --json
castloop schedule-episode first audio.mp3 --workspace . --show my-show --at '2026-11-01T10:00:00Z' --expect-preview APPROVAL_HASH
castloop schedule-list my-show
castloop schedule-status my-show SCHEDULE_UUID
```

Schedules freeze metadata and concrete media references, not local drafts. `scheduled` means accepted, not published. The Show Alarm commits publication and `dispatched` with its `revision_id` in the same transaction. Base revision conflicts and custom domain changes suspend schedules as `needs_approval`; ordinary code-only `deploy` preserves schedules. Existing cancel/reschedule/reapprove commands require reviewed hashes and versions. An unknown creation response must be checked with `schedule-list`, not blindly recreated.

Scheduled time is separate from `published_at`. Future `published_at` does not delay immediate publication; non-interactive immediate publication needs `--allow-future-published-at`. Optional `castloop-admin.toml` sets the CLI timezone. See [configuration and scheduling](docs/admin_configuration.md).

## Inspect, restore and diagnose

```sh
castloop list-shows
castloop list-episodes my-show --json
castloop preview-episode-lifecycle my-show first unpublish > plan.json
castloop lifecycle-execute plan.json REQUEST_SHA256 confirm
castloop diagnose my-show --json
castloop verify my-show --episode first --json
```

Listings use 20-entry pages and `next_cursor`. Lifecycle `restore` uses saved content rather than local edits; Show restore does not revive individually unpublished Episodes. Unpublish retains payloads. **Physical deletion is not implemented.**

`list-*-revisions`, `preview-*-revision` and `revision-execute` support adoption of saved revisions without uploading media. Adopting an already-current desired state is unchanged. Metadata/RSS exports never overwrite files. See [published-content review](docs/published_content_review.md) and [diagnostics](docs/observability.md).

## RSS import and statistics

```sh
castloop import-rss imported-show https://old-host.example/feed.xml --dry-run
castloop import-rss imported-show https://old-host.example/feed.xml --output /path/to/import
# Review downloaded metadata, cover, MP3s and warnings.
castloop publish-rss-import /path/to/import
castloop stats imported-show --json
```

Imports create a new Show and preserve GUIDs/dates. A retained batch record tracks sequential Show/Episode publication; already-committed identical content is unchanged on rerun. Recurring sync, existing-Show adoption and subscriber migration are not provided. See [RSS usage](docs/rss_migration.md).

`stats` reports server-observed audio requests, bytes and Range/HEAD/bot classifications, not listener counts. `unmeasured` and `pruned` are not zero. `stats-retention SHOW DAYS` adjusts daily retention while preserving lifetime totals. See [statistics](docs/delivery_statistics.md).

## Availability, domains and Worker updates

To stop public delivery of a Show or Episode, use lifecycle `unpublish` and `restore`. Separate runtime Pause/Resume commands (`show-pause`, `show-resume`, etc.) have been removed. Media placement alone never publishes. See [availability controls](docs/show_availability.md).

Ordinary Worker code updates are a single-step deployment without pausing Shows or writing a local journal:

```sh
castloop deploy
castloop service-status
```

Use code-only `deploy` only with matching configuration, namespace and persisted formats; R2 media objects are never modified or deleted during deployment, and an interrupted `deploy` can simply be run again. Dedicated domain `add`/`list`/`status`/`continue`/`remove` operations support one subdomain in an active/full Cloudflare DNS zone and save the previous and target configurations so interrupted domain changes can be continued cleanly; use the [domain guide](docs/sqlite_custom_domains.md), not ordinary deploy.

## Backup, agents and failures

Keep `castloop.toml`, local originals and private git-ignored `.castloop/` state together. TOML alone is not a complete workspace. Offline `backup-create`, `backup-verify`, `backup-restore-preview` and `backup-restore` preserve configuration, administrator keys, records and metadata; include MP3 originals explicitly with `--include-audio`. Old records remain eligible for backup but do not restore removed publication workflows. See [backup](docs/workspace_backup.md).

Agents can use `describe`, `schema`, `template`, `validate`, `doctor --local` and the bundled Skill (`skill export castloop --output DIR`). Specify `--workspace`, Episode `--show`, `--non-interactive --json`, review inputs and bind publication to `--expect-preview`. See [agent usage](docs/agent_usage.md).

For an unknown content-publication response, inspect current content and rerun the same approved inputs: identical content is unchanged; different content with a stale base returns 409. Interrupted `init`, `deploy`, `create-show`, and `domain continue` operations check current state via API and can be re-run to completion. Management GETs retain bounded transient retries. No install, build, test or historical approval authorizes deployment, publication, cleanup or deletion.

## Disclaimer and contribution

castloop creates resources in your Cloudflare account. You are responsible for costs, availability and compliance. It is early-beta software, supplied "AS IS" under the [MIT License](LICENSE), and is not affiliated with Cloudflare. Keep [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with redistributed binaries.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [Code of Conduct](CODE_OF_CONDUCT.md), [changelog](CHANGELOG.md) and [design index](design/README.md). Local tests do not establish native performance or full Free-plan compatibility.
