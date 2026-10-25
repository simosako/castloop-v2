# castloop v0.7.5

This release adds authenticated published-content comparisons, Show/Episode revision history and explicit adoption of saved revisions without uploading media again (Issue #64).

## Changes

- **Published/local/staged comparisons.** `preview-show` and `preview-episode` retrieve authenticated metadata and media identities, display field-level changes and distinguish media reuse from replacement. Initialized workspaces use remote reads by default; `--local` explicitly performs offline checks. Failed reads are errors, not empty diffs.
- **Reviewed-base binding.** `--expect-preview` binds local inputs, staged receipts and the reviewed remote runtime, admission window, lifecycle, revision and Feed generation. Changed inputs or bases require another preview before a new publication request is frozen.
- **Revision history and adoption.** `list-*-revisions` and `preview-*-revision` provide read-only history and candidate comparisons. After explicit confirmation, `revision-execute` creates a new revision using saved metadata and immutable audio/cover objects, preserving past history, GUID and initial publication time. This is distinct from lifecycle `restore`, which republishes the latest saved content after unpublishing.
- **Local previews and exports.** `--rss-output FILE` renders candidate RSS inside the CLI with the production renderer. `sync-local-metadata` exports reviewed current metadata to a new TOML file. Neither overwrites existing files, publishes staging objects nor creates temporary public preview URLs. Original metadata is not automatically changed after adoption.
- **Observation integration.** `progress` and `watch` also resolve revision-adoption journals, distinguish prepared plans from unknown submissions and terminal results, and remain read-only. Unknown POST outcomes are never automatically replayed.

See the [review and revision guide](published_content_review.md), [observability guide](observability.md) and [approved design and storage measurements](../design/published_diff_and_revision_restore_plan.md).

## Compatibility and safety

- **Fresh services only:** internal queue/content formats **7/8** and `revision_history="sqlite-revisions-v1"` are required. Service configuration remains schema 2 / `sqlite-sequential-v1` / `storage_layout="show-v1"`. Existing v0.7.4 format-7/7 services and earlier databases are not migrated or adopted. Installing this CLI does not make an old service compatible; do not redeploy it onto an incompatible service.
- Publication remains explicit. Required Feed/cover cache purges must succeed before the current content and revision history commit atomically in SQLite. Existing delivery gates, immutable media/history and privacy-safe diagnostic allowlists remain in force.
- Release and installation do not deploy, resume, publish to or change any Cloudflare resource.

## Verification and limitations

- The local reference suite passed **760 tests across 86 files**, TypeScript checks, the Linux standalone build and empty-PATH offline smoke checks. PR #82 passed native build and standalone smoke jobs on Linux x64, macOS Apple Silicon and Windows x64; the tag release workflow repeats those checks before publication.
- Regression coverage includes metadata-only/audio-only/combined changes, stale bases and lifecycle conflicts, authentication and Show isolation, history paging, media reuse, non-overwriting exports, unknown-submit observation and failure-time delivery/history preservation.
- No live Cloudflare verification was performed for Issue #64. CPU time, full Free-plan compatibility, large-scale performance and live fault injection remain unmeasured. macOS/Windows checks do not establish full publication, concurrency or filesystem-safety behavior on those platforms. See the [binary distribution scope](cli_binary_distribution.md).

Download the three platform binaries, `SHA256SUMS`, `LICENSE` and `THIRD_PARTY_NOTICES.md` from the [v0.7.5 release](https://github.com/simosako/castloop-v2/releases/tag/v0.7.5). The optional `castloop-skill.tar.gz` and `SKILL_SHA256SUMS` are also provided. Verify checksums before installation.
