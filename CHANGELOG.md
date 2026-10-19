# Changelog

All notable changes are documented in per-version release notes. This file is an **index**: each entry summarizes the linked note, and the note remains the authoritative record for that release.

Service configuration `schema_version = 1` (Queue/R2) features shipped in v0.5.x and earlier were **removed in v0.6.0**. Entries below describe the release that introduced a feature and do not imply it exists in the current release. There is no migration feature from schema version 1.

## Unreleased

- Nothing yet.

## v0.6.2 — [release note](docs/release-v0.6.2.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.6.2)

- Server-side operation records in the service DO's SQLite, durable upload checkpoint recovery (resume from an acknowledged PUT), operation cancellation, and previewed cleanup of unused staging objects.
- Requires the matching v0.6.2 Worker; service and content/request schema versions are unchanged.

## v0.6.1 — [release note](docs/release-v0.6.1.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.6.1)

- Apple-standard per-field input limits for new Show/Episode metadata. Stored schemas and schema versions unchanged.

## v0.6.0 — [release note](docs/release-v0.6.0.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.6.0)

- Restructured to SQLite services only: Queue/R2 service support (service schema version 1), its Worker bundle and commands removed. `init` now defaults to schema version 2. No schema-version-1 migration feature; existing Queue services require the v0.5.x CLI/Worker.

## v0.5.2 — [release note](docs/release-v0.5.2.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.5.2)

- SQLite Worker update verification continuation, CLI upload source completion ordering, Cloudflare REST URL encoding, native administrator-key comparison, removal of duplicate domain-probe R2 reads; documentation reorganized. Queue path maintained.

## v0.5.1 — [release note](docs/release-v0.5.1.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.5.1)

- Hardened RSS text validation, safe workspace configuration reading, removal of unreachable code found in review and consolidation of shared handling. Queue and SQLite paths both maintained.

## v0.5.0 — [release note](docs/release-v0.5.0.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.5.0)

- Introduced the SQLite-backed Durable Object sequential publication method alongside the existing Queue method.

## v0.4.0 — [release note](docs/release-v0.4.0.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.4.0)

- One-time RSS migration into a new Show, publication performance improvements and stall diagnostics, limited Worker update continuation. Listings, lifecycle and custom-domain features from v0.3.0 maintained.

## v0.3.0 — [release note](docs/release-v0.3.0.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.3.0)

- Custom domain add/lookup/delete (Queue-era services; not available in the current SQLite-only release).

## v0.2.1 — [release note](docs/release-v0.2.1.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.2.1)

- Read-only Show/Episode listings.

## v0.2.0 — [release note](docs/release-v0.2.0.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.2.0)

- M6 lifecycle features: publish, unpublish, restore and delete.

## v0.1.2 — [release note](docs/release-v0.1.2.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.1.2)

- Patch fixes for the MVP release.

## v0.1.1 — [release note](docs/release-v0.1.1.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.1.1)

- Patch release for the administrator-operated MVP.

## v0.1.0 — [release note](docs/release-v0.1.0.md) · [release](https://github.com/simosako/castloop-v2/releases/tag/v0.1.0)

- First administrator-operated MVP release for Linux x86-64: standalone binary managing a Cloudflare-hosted podcast service with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` only.
