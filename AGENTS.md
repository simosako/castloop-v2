# Agent Guide for castloop

This file guides agentic coding assistants working in this repo.
Follow the commands and conventions below.

## Repository overview
- Monorepo with workspaces under `packages/`.
- `packages/cli` contains the `castloop` CLI.
- `packages/shared` contains shared utilities.
- `design/` holds product and system design docs.

## Lint/format commands
- No lint or formatter is configured yet.
- Do not add new tooling without explicit request.

## Test commands
- Run `bun test` for the automated test suite and `npm run check` for TypeScript validation.

## Runtime targets
- The CLI targets a Bun single executable; the public service runs on Cloudflare Workers.

## Data & storage conventions
- Each service has one private R2 bucket and one public Worker; shows share the bucket and are separated by show ID in object keys.
- The bucket name is configured at initialization. Its exact naming convention is not yet decided.
- Store non-secret service settings in `castloop.toml` at the working-directory root. Keep unpublished job IDs in a git-ignored local state file, not in service TOML.
- The public URL is a Worker URL; a custom domain is optional. Store `public_base_url` in the service config, never an R2 public URL in show metadata.
- Local TOML files are the editable source; R2 stores published snapshots and job status.
- M6 new Show registration claims a permanent `reservation_id` in the Show control record before completing its matching reservation record; block mutations while registration is incomplete, never recreate an advanced or deleted Show, and retain the identity after deletion. New Episode controls are initialized only under the exact Show staging owner after checking for orphan data. These internal paths do not authorize exposing M6 write commands before the release gates pass.
- `create-show` requires a real site URL supplied by the administrator and writes it into the local `show.toml`; publication requires `site_url`. `update-show` stages Show TOML and cover art in R2 without publishing; only `publish-show` creates its commit marker and starts publication.
- `create-episode` fills `published_at` with the current timestamp as a quoted RFC 3339 string including seconds and an offset. Render RSS pubDate as RFC 2822.
- Service and show metadata: `system/service.toml` and `system/shows/<showId>/show.toml`.
- Job status: `system/jobs/<jobId>/status.toml`.
- Show drafts: `staging/shows/<showId>/<jobId>/show.toml`, `cover.<ext>`, and `commit.json`. Episode drafts: `staging/episodes/<showId>/<episodeId>/<jobId>/episode.toml`, `audio.mp3`, and `commit.json`. On an existing episode, the unchanged metadata or audio may be reused from the published revision.
- `create-episode` creates a local TOML draft. `update-episode` stages only metadata, and `update-episode-audio` stages only MP3 audio in R2. Neither update command publishes. Only `publish-episode` validates the staged inputs and writes `commit.json` last; initial and subsequent publications both require an explicit publish command.
- Keep one job ID for an unpublished draft. After writing `commit.json`, freeze that draft; use a new job ID for later edits. Reject stale local metadata rather than silently publishing an older staged copy.
- Do not assume R2 binding CAS applies to the Cloudflare R2 REST object PUT endpoint. Dedicated M6 tests observed overwrites despite a mismatched If-Match header; this does not prove that aborted PUTs continue writing. The administrator decided on 2026-10-01 to retain simple REST single-object PUTs for M6 and assume that a PUT does not create or update an object later after client disconnection. Record this as an unverified assumption and unresolved concern U1 in design/m6_upload_recovery_options.md, not a Cloudflare guarantee. Do not require multipart uploads or resolution of U1 as an M6 release gate. Preserve upload admission, size/content verification and owner/generation-checked recovery; never release a still-running PUT or publication consumer merely because time elapsed or HEAD found no object. Do not contact Cloudflare support about U1.
- Keep the immutable published audio and revision history during normal publication. M6 explicit deletion is the approved exception, but do not expose it before admission, delivery, recovery and deletion gates pass. Decide staging audio retention separately from published media; do not apply a blanket expiration rule to active or recoverable drafts.
- The administrator approved M6 retention on 2026-10-01: explicitly delete payloads, but retain necessary small reservations, lifecycle/tombstone records, frozen requests, commit markers and job status/progress without automatic expiration. Do not copy titles, descriptions, email addresses or secrets into retained operational records. Persist only allowlisted diagnostic codes/messages, not arbitrary exception messages. Keep unfinished/recoverable job records; time-based audit cleanup is deferred. See design/m6_review_queue.md.
- Published feeds and media: `public/podcasts/<showId>/feed.xml`, `cover.<ext>`, and `episodes/<episodeId>/<revisionId>.mp3`.
- Current episode metadata: `public/episodes/<showId>/<episodeId>/metadata.toml`.
- Episode revision history: `public/episodes/<showId>/<episodeId>/revisions/<revisionId>.toml`.
- Deliver only approved public paths through the Worker; never expose `system/` or `staging/`.
- R2 notifications for Show and Episode commit markers in `staging/` feed the same managed Cloudflare Queue. Use one sequential consumer invocation at a time; do not assume FIFO delivery or exactly-once processing. Permit only one unfinished publication per show across Show and Episode jobs, with an atomic admission check and failure recovery; concurrency limiting alone is insufficient. Do not infer publication order from upload timestamps.
- Store MVP job status at `system/jobs/<jobId>/status.toml` in R2. Consider D1 only if later requirements justify it.
- Retry transient consumer failures through Cloudflare Queues for a finite number of attempts and route exhausted messages to one dead-letter queue. The current main consumer uses `max_retries: 2`, one-message batches, and concurrency one. Record permanent failure reasons without pointless retries. DLQ delivery does not update R2 status automatically; administrators inspect R2 status and DLQ markers and explicitly retry the same job. Preserve recovery data in R2 rather than relying on Queue retention. Published media and revision history are immutable; staging audio is removed only by explicit cleanup after a successful Episode publication. Queue retention defaults, broader staging/status retention policy, and a safe CLI operation to abandon permanently failed `reserved` jobs remain undefined. Never release a `processing` admission while an old consumer may still write.
- Preserve immutable media and revision history when updating current metadata. Episode and Show deletion/unpublishing are not supported through v0.1.2; they are the next milestone, M6. See design/m6_content_lifecycle_plan.md before implementing lifecycle changes. The R2 control-record approach is decided and foundational implementation has started; input Show/Episode TOML must not control publication state. Other policy and runtime gates remain documented in the plan. Do not implement deletion as direct prefix removal or as a separate marker check without atomic admission and cache-safe delivery gates.
- Use readable immutable slugs matching `[a-z0-9]+(?:-[a-z0-9]+)*`; service IDs are at most 20 characters, show IDs at most 32, and episode IDs at most 80. Show IDs are unique within a service; episode IDs are unique within a show. Auto-generated IDs do not eliminate the need to prevent collisions.
- Use CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for administration from the standalone CLI. Call Cloudflare's REST API directly for resources, Worker deployment, and R2 uploads; do not require Wrangler, Node.js, or separate R2 credentials on the administrator's machine. Do not store the API token in service TOML or Git. Limit MVP MP3 uploads to 300,000,000 bytes; reject larger files before uploading and verify the uploaded size and contents.
- Use Workers Caching for the public Worker. Validate cache-tag feed purging and GET/HEAD/Range delivery before the end-to-end MVP release.
- Overwrite the Show cover art at the approved `public/podcasts/<showId>/cover.<ext>` key on image updates and purge its cache tag. Do not mark a publication job as complete until feed and applicable cover-art Workers Cache purges succeed. Retry purge failures without duplicating published media.

## Milestones
- M0 validates Cloudflare authentication, resource creation, R2 media delivery, Workers Caching, MP3 upload/analysis, and the R2 event-to-Queue path.
- M1 delivers service initialization, local metadata models, ID validation, and show reservation.
- M2 publishes a show through `update-show`/`publish-show` and one episode end-to-end using separate metadata/audio staging, explicit publish, job status, feed generation, and media delivery.
- M3 supports multiple episodes, metadata-only and audio-only revisions, concurrency/retry handling, and cleanup.
- M4 delivers the Bun executable and usage documentation.
- M5 removes Wrangler from the build and administrator workflows and verifies binary-only publication and recovery. See design/initial_design.md and design/m5_implementation_log.md.
- M6 is the next milestone after v0.1.2: Episode and Show unpublishing/deletion, with explicit restoration proposed as the reversible counterpart. See design/m6_content_lifecycle_plan.md and design/m6_implementation_log.md. The R2 control-record approach is decided; strict schemas and atomic-admission/public-visibility primitives are implemented but not connected to live routes. Complete the cache/REST/upload/migration gates before exposing lifecycle commands.
- On 2026-10-03, the administrator approved separating fresh M6 initialization, compatible M6 Worker updates, and legacy data conversion needed only on demand. Fresh initialization and compatible updates have internal CAS/journal/REST implementations, not released CLI or HTTP routes. Share runtime verification without a generic operation state machine; keep legacy migration audit evidence separate from current-version runtime readiness. Finish paused and require explicit resume. Never infer runtime readiness from REST settings alone, adopt unknown resources, replay unknown deploys, or bypass unfinished upload/publication owners. See design/m6_fresh_initialization.md and design/m6_compatible_updates.md. Existing Cloudflare resources are not authorized for immediate deletion.
- The administrator decided on 2026-10-02 to use an isolated M6 test environment in the same Cloudflare account as existing services and to build migration around a planned maintenance window with temporary public-delivery and mutation downtime. Complete the full M6 feature set and release it as the next version; a limited pilot release and zero-downtime migration are not prerequisites. Defer cost and downtime measurement planning, and consideration of zero-downtime migration, until after MVP construction. Do not block ordinary implementation or feature completion on measurement approval. Preserve functional and safety acceptance, including correct 300 MB handling within runtime limits, old-IO quiescence, cache-safe delivery and owner/token-checked recovery. This does not authorize an immediate production migration, unverified destructive commands, unlimited spending or paid-plan changes. See design/m6_review_queue.md.
- Custom-domain work retains its approved plan and existing groundwork but follows M6. Do not expose domain add/remove before their existing migration and recovery gates pass. Lifecycle state must also be respected by future domain migration.

## TOML and schema conventions
- TOML keys are snake_case to match metadata definitions.
- Parse TOML with `@iarna/toml` and validate with Zod.
- Use `parseServiceConfig`, `parseShowMetadata`, `parseEpisodeDraft`.
- Use `stringifyToml` for writing TOML back to R2.
- Keep metadata validations strict (`.strict()` in Zod schemas).

## Code style: general
- Prefer explicit, readable code over clever abstractions.
- Use async/await and avoid promise chains.
- Keep functions focused and small where possible.
- Avoid global state except shared clients.
- Avoid inline comments unless requested.

## Code style: imports
- Use ES module `import` syntax.
- Group imports: external packages, then internal packages, then Node built-ins.
- Prefer `node:` prefix for built-ins.
- Avoid unused imports; keep lists sorted logically.

## Code style: naming
- Use camelCase for variables/functions.
- Use PascalCase for types/classes.
- Use UPPER_SNAKE_CASE for constants.
- For metadata fields, keep snake_case in TOML and map to camelCase in code.

## Code style: types
- Use explicit types for exported functions and shared models.
- Prefer `type` aliases for data shapes.
- Use Zod inference for runtime-validated types.
- Avoid `any`; use `unknown` and narrow.

## Code style: formatting
- Default formatting matches current code: 2-space indentation.
- Use double quotes for strings.
- Keep line length reasonable; break long template strings as in existing code.

## Error handling
- Throw `Error` with clear messages in helpers.
- CLI should catch and print errors, set `process.exitCode = 1`.
- Worker handlers should report errors clearly and log failures; Queue handlers must distinguish retryable failures from permanent ones.
- Avoid swallowing errors silently.

## File placement guidelines
- Shared utilities go in `packages/shared/src`.
- CLI commands live in `packages/cli/src`.
- Update design docs in `design/` when behavior changes.

## References
- Design docs: `design/`.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
