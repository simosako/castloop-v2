# Agent Guide for castloop

## Repository and checks
- `packages/cli/src/`: the Bun single-executable CLI; `packages/shared/src/`: shared utilities; `src/`: Cloudflare Worker services.
- Run `bun test` and `npm run check` for automated tests and TypeScript validation. Skip both for documentation-only or other changes that do not affect code, builds, or runtime behavior.
- No lint or formatter is configured. Do not add tooling without an explicit request.
- Update the relevant design and usage docs when behavior changes.

## Read documentation by task
- Use [design/README.md](design/README.md) to locate relevant documents; do not read all design docs or historical records on every task.
- Current architecture: [design/initial_design.md](design/initial_design.md). Usage: [README.md](README.md).
- Development supports only fresh SQLite service configs (`schema_version=2`, `sqlite-sequential-v1`, required `storage_layout="show-v1"`); `init` uses this by default. Reject service schema version 1 and legacy layouts before IO or local state changes. Never add migration, legacy layout support, resource adoption or fallback. Shared content/request schema version 1 is independent and remains supported.
- The production Worker entrypoint is `src/sqlite-worker.ts`; embed only that Worker. Preserve existing DO/cache class names, bindings, compatibility date and persisted SQLite formats during code-only cleanup.

| When working on | Read the relevant contract |
| --- | --- |
| SQLite publication, lifecycle or updates | [SQLite guide](docs/sqlite_sequential_development.md), [implementation plan](design/sqlite_sequential_publication_implementation_plan.md) |
| Show isolation, Pause/Resume or shared Worker maintenance | [Show separation contract](design/do_show_separation_options.md). Keep ordinary admission and delivery local to a Show; shared update membership and partial outcomes belong to the control DO |
| Worker update continuation | [SQLite recovery contract](design/sqlite_worker_update_recovery.md) |
| Removed Queue code or v0.5.x history | [Removal plan](design/schema_v1_removal_plan.md), [v0.5.x Queue guide](docs/queue_service.md), [archived architecture](design/archive/initial_design_v052.md) |
| Upload integrity or interrupted IO | [Single PUT and unresolved assumption U1](design/m6_upload_recovery_options.md) |
| Lifecycle, deletion or retention | [SQLite guide](docs/sqlite_sequential_development.md), [approved retention and safety policy](design/m6_review_queue.md). Physical deletion and custom domains are not implemented; do not transplant archived Queue operations |
| Public delivery or caching | [Current architecture](design/initial_design.md), [SQLite implementation contract](design/sqlite_sequential_publication_implementation_plan.md) |
| RSS import or publication | [RSS migration guide](docs/rss_migration.md), [RSS design](design/m7_rss_import_plan.md) |
| Live environments or past acceptance claims | [Cleanup outcome and retained environment](design/archive/cloudflare_test_environment_cleanup_20261017.md), then the relevant measurement record linked from the design index |

- `design/archive/` is historical evidence, not a task queue or current operational authorization. Consult it only for relevant history. The former long-form agent storage notes and milestones are preserved in [this snapshot](design/archive/agent_storage_and_milestones_20261017.md).
- Do not append chronological progress logs, environment inventories, benchmark samples or completed one-time approvals here. Put them in the appropriate design/evidence document and update its index; keep only durable cross-cutting rules here.

## Safety boundaries
- Code changes, tests, commits, pushes and past approvals do not authorize live Cloudflare changes. Deployment, resume/publication, migration, resource creation/deletion, domains, permissions, billing/CPU limits and local evidence cleanup need explicit authorization for the target and scope. Do not request a Paid-plan upgrade as a workaround.
- Preserve the retained `sq16r-6ec01dc6` service, non-test `otftalk.com` DNS, shared certificates, local originals, journals and private evidence. Completed old-environment cleanup is not permission for further mutations or cleanup.
- Never replay unknown PUT/POST/control/deployment outcomes, adopt unknown resources, promote uncertain journals, or steal/expire owner or execution tokens. Time elapsed, HEAD absence, DLQ delivery, an empty queue or a terminal job alone do not prove all previous IO has settled.
- Preserve exact runtime/config/target/base and owner/generation checks, atomic admission, upload settlement and cache-safe delivery gates. Do not replace lifecycle operations with direct prefix deletion or a separate non-atomic marker check.
- Keep publication explicit: create/update/upload alone must not publish. Freeze submitted drafts and request identities; reject stale local inputs. Acceptance (`accepted`/`queued`) is not publication success.
- Preserve immutable published audio and revision history during normal updates, and saved GUID/date/audio identities when restoring snapshots. Only supported, explicitly confirmed lifecycle deletion may remove payloads. Retain necessary small reservations, tombstones and recovery records; do not add blanket expiration to active/recoverable drafts or operational records.
- Deliver only approved public paths through lifecycle/readiness gates; never expose `system/` or `staging/`. Do not complete publication before required feed/cover cache purges succeed, or retry publication writes to hide purge failures.
- Keep MP3 uploads limited to 300,000,000 bytes; reject oversized inputs before upload and preserve size/content/object-identity verification. REST PUT is not R2 binding CAS. U1 is an unverified assumption, not a Cloudflare guarantee or a new release gate; do not contact Cloudflare support about it.
- Use `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with direct REST administration from the standalone CLI. Do not require Wrangler, Node.js or separate R2 credentials on the administrator's machine. Never store secrets in service TOML or Git; keep local secrets and unpublished job IDs in git-ignored `.castloop/` state.
- Persist only allowlisted diagnostic codes/messages, not arbitrary exceptions, content text, email addresses or secrets in operational records. Report missing measurement evidence honestly; local tests do not establish native performance, full Free compatibility or permanent Issue #13 resolution.

## Data and code conventions
- Local TOML is the editable source; R2 holds payloads and published snapshots. Each service has one private R2 bucket; show IDs partition object keys. Keep `public_base_url` in service config, not an R2 public URL in show metadata.
- Use strict Zod schemas, `@iarna/toml`, `parseSqliteServiceConfig`, `parseShowMetadata`, `parseEpisodeDraft` and `stringifyToml`. TOML keys are snake_case; TypeScript identifiers are camelCase.
- Prefer explicit, focused code and async/await. Avoid global state except shared clients, clever abstractions and unnecessary inline comments.
- Use ES module imports, grouped external, internal, then Node built-ins; prefer `node:` for built-ins. Avoid unused imports.
- Use PascalCase for types/classes and UPPER_SNAKE_CASE for constants. Prefer `type` aliases, explicit exported types and Zod inference; use `unknown` with narrowing instead of `any`.
- Match surrounding formatting: two spaces, double quotes and readable line lengths.
- Throw clear `Error`s in helpers; CLI handlers print errors and set `process.exitCode = 1`. Do not silently swallow failures. Worker diagnostics must follow the allowlist/privacy rule; preserve the SQLite failed/blocked distinction and never replay uncertain side effects.

## CodeGraph in Git worktrees
- The `.codegraph/` index is local and untracked; only `.codegraph/.gitignore` is tracked. Initialize each newly created worktree with `codegraph init -y` before agent work.
- Never symlink/copy the database from another checkout or query that checkout's index for code being edited here. Index contents and daemon files belong to their worktree.
- The index is removed with its worktree; no separate cleanup is needed.
