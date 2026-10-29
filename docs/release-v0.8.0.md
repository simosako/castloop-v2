# castloop v0.8.0

This release completes the architecture simplification described in Phases 1–4. The release is intended for fresh SQLite services; it does not migrate or adopt services created with earlier internal formats.

## Changes

- **Synchronous atomic publication.** Show and Episode metadata plus media references are committed directly to the Show Durable Object after validation and required cache purges. A publication either commits atomically or fails without a partially published state.
- **Direct media placement.** New audio and cover files are uploaded once to content-addressed keys in private R2. Staging copies, full upload readbacks, publication job ledgers and their progress/retry commands are removed.
- **On-demand delivery.** RSS feeds and builtin-site HTML are rendered from committed SQLite content when requested and then cached. Published audio remains immutable during ordinary updates.
- **Simpler administration.** `publish-show` and `publish-episode` replace the old update/job workflow. Worker code deployment is one operation with readiness verification. Availability is controlled through lifecycle publication/unpublication rather than Pause/Resume controls. Show publication state remains isolated in each Show Durable Object.
- **Focused CLI and tests.** Obsolete operation, staging, recovery and observation mechanisms were removed; the release workflow now smoke-tests the current CLI commands.

## Compatibility and safety

- Requires a fresh service configuration with `schema_version = 2`, `publication_protocol = "sqlite-sequential-v1"`, and `storage_layout = "show-v1"`, plus internal queue/content formats **14/13**. Existing services using earlier internal formats, including v0.7.6 services, are not migrated or updated by installing this release.
- Show and Episode metadata continue to use content schema version 1. This is independent of the service and internal storage formats.
- Installing this release does not deploy a Worker or mutate Cloudflare resources. Do not deploy it onto an older service format.

## Verification and limitations

- `bun test` and `npm run check` pass. The tag workflow builds and smoke-tests native binaries on Linux x64, macOS Apple Silicon and Windows x64 before publishing release assets.
- A small, isolated Cloudflare smoke test used a private R2 bucket, a `workers.dev` Worker and Cloudflare Access restricted to the reviewer. It verified service initialization, Show publication, three Episode publications and builtin-site playback. The reviewer confirmed playback and Tokyo timezone display in the browser.
- Native Cloudflare performance, full Free-plan compatibility, broad production behavior, and mobile/keyboard browser acceptance have not been established by this smoke test.

## Downloads

Download the Linux, macOS and Windows binaries, `SHA256SUMS`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and optional `castloop-skill.tar.gz` from the [v0.8.0 GitHub release](https://github.com/simosako/castloop-v2/releases/tag/v0.8.0). Verify the checksums before installation. Binaries are unsigned; see the [distribution guide](cli_binary_distribution.md).
