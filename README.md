# castloop

[![Latest release](https://img.shields.io/github/v/release/simosako/castloop-v2)](https://github.com/simosako/castloop-v2/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Serverless podcast hosting on Cloudflare, managed with a standalone CLI: one private R2 bucket and one Worker per service, multiple Shows.

**Early beta.** Commands and persisted formats can change incompatibly. v0.8.0 requires fresh services with internal queue/content formats **14/13**; older services are not migrated or adopted. Native performance, full Free-plan compatibility and broad production behavior remain unverified. See the [release notes](docs/release-v0.8.0.md) for compatibility and the limited live-verification scope.

The CLI validates local TOML/media, places content-addressed media in private R2, and explicitly sends metadata plus media references to the target Show DO. After validation and required cache purges, one SQLite transaction commits content, revisions and delivery generations. Each Show has independent SQLite state; a small control DO tracks Show registration, catalog listing and custom domain state. No Cloudflare Queues or D1 are used.

## Get started

Download the matching binary, `SHA256SUMS`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` from the [latest release](https://github.com/simosako/castloop-v2/releases/latest). Released binaries do not include unreleased branch changes.

| Platform | Binary |
| --- | --- |
| Linux x86-64, glibc | `castloop-linux-x64` |
| macOS Apple Silicon, macOS 11+ | `castloop-macos-arm64` |
| Windows x64, Windows 10+ | `castloop-windows-x64.exe` |

Verify the downloaded checksum before execution. Binaries are unsigned; follow the [installation guide](docs/installation.md) for OS-specific instructions and verification limits.

The administrator needs no Bun, Node.js, Wrangler, ffprobe or separate R2 S3 credentials. Supply `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with the required Worker/R2/SQLite DO permissions. The CLI never expands permissions or changes billing/CPU limits.

1. [Install the CLI](docs/installation.md).
2. [Create a service and publish your first Show and Episode](docs/getting_started.md).
3. Use the **[user guide index / 利用ガイド](docs/README.md)** for ongoing administration. Guides are written in Japanese.

See `castloop help COMMAND` for the syntax supported by your installed version.

## Guides

| Task | Guide |
| --- | --- |
| Publish or update content | [Publication](docs/publishing.md), [review and revisions](docs/published_content_review.md) |
| Schedule publication | [Scheduling and timezone settings](docs/scheduling.md) |
| Stop or restore delivery | [Unpublish and restore](docs/lifecycle.md) |
| Configure the builtin website | [Website, CSS and dates](docs/show_website.md) |
| Import an existing podcast | [RSS import](docs/rss_migration.md) |
| Inspect traffic | [Delivery statistics](docs/delivery_statistics.md) |
| Inspect state or handle interruptions | [Troubleshooting](docs/troubleshooting.md) |
| Preserve administrator state | [Workspace backup](docs/workspace_backup.md) |
| Update the Worker or public domain | [Maintenance](docs/maintenance.md), [custom domains](docs/custom_domains.md) |
| Work with an AI agent | [Agent usage and bundled Skill](docs/agent_usage.md) |

## Operational boundaries

- Creation and preview do not publish. Publication is explicit; future `published_at` values do not delay immediate publication. Use schedules to wait until a specified time.
- MP3s are limited to **300,000,000 bytes**, JPEG/PNG covers to **5,000,000 bytes**. Normal updates retain published audio and revision history. Physical deletion and automatic orphan-media cleanup are not implemented.
- Preserve local originals, `castloop.toml` and private, git-ignored `.castloop/` state together. Administrator keys cannot be reissued. Workspace backups do not export R2 or server-side SQLite.
- Run only one modifying CLI process at a time in a workspace or RSS import directory, and do not edit inputs while it runs. Follow the operation-specific interruption guidance rather than deleting state.
- No install, build, test or historical approval authorizes deployment, publication or resource deletion. Private trials require [protection of every content path before upload](design/security.md#非公開の実機試験).

## Development and documentation

- [CONTRIBUTING.md](CONTRIBUTING.md): source setup, tests and contribution rules.
- [Current design](design/README.md): architecture, components, storage, tables and schemas.
- [Development and release maintenance](docs/development/README.md): builds, CI and distribution.
- [Changelog](CHANGELOG.md), [current release](docs/release-v0.8.0.md) and [archived user documents](docs/archive/README.md): version-specific history, not current operating instructions.

## Disclaimer and contribution

castloop creates resources in your Cloudflare account. You are responsible for costs, availability and compliance. It is early-beta software, supplied "AS IS" under the [MIT License](LICENSE), and is not affiliated with Cloudflare. Keep [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with redistributed binaries.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [Code of Conduct](CODE_OF_CONDUCT.md), [changelog](CHANGELOG.md) and [design index](design/README.md). Local tests do not establish native performance or full Free-plan compatibility.
