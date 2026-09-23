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
- No automated tests are configured yet.

## Runtime targets
- The CLI targets a Bun single executable; the public service runs on Cloudflare Workers.

## Data & storage conventions
- Each service has one private R2 bucket and one public Worker; shows share the bucket and are separated by show ID in object keys.
- The bucket name is configured at initialization. Its exact naming convention is not yet decided.
- Store non-secret service settings in `castloop.toml` at the working-directory root. Keep unpublished job IDs in a git-ignored local state file, not in service TOML.
- The public URL is a Worker URL; a custom domain is optional. Store `public_base_url` in the service config, never an R2 public URL in show metadata.
- Local TOML files are the editable source; R2 stores published snapshots and job status.
- `create-show` requires a real site URL supplied by the administrator and writes it into the local `show.toml`; publication requires `site_url`. `update-show` stages Show TOML and cover art in R2 without publishing; only `publish-show` creates its commit marker and starts publication.
- `create-episode` fills `published_at` with the current timestamp as a quoted RFC 3339 string including seconds and an offset. Render RSS pubDate as RFC 2822.
- Service and show metadata: `system/service.toml` and `system/shows/<showId>/show.toml`.
- Job status: `system/jobs/<jobId>/status.toml`.
- Show drafts: `staging/shows/<showId>/<jobId>/show.toml`, `cover.<ext>`, and `commit.json`. Episode drafts: `staging/episodes/<showId>/<episodeId>/<jobId>/episode.toml`, `audio.mp3`, and `commit.json`. On an existing episode, the unchanged metadata or audio may be reused from the published revision.
- `create-episode` creates a local TOML draft. `update-episode` stages only metadata, and `update-episode-audio` stages only MP3 audio in R2. Neither update command publishes. Only `publish-episode` validates the staged inputs and writes `commit.json` last; initial and subsequent publications both require an explicit publish command.
- Keep one job ID for an unpublished draft. After writing `commit.json`, freeze that draft; use a new job ID for later edits. Reject stale local metadata rather than silently publishing an older staged copy.
- Keep the immutable published audio and revision history. Decide staging audio retention separately from published media; do not apply a blanket expiration rule to active or recoverable drafts.
- Published feeds and media: `public/podcasts/<showId>/feed.xml`, `cover.<ext>`, and `episodes/<episodeId>/<revisionId>.mp3`.
- Current episode metadata: `public/episodes/<showId>/<episodeId>/metadata.toml`.
- Episode revision history: `public/episodes/<showId>/<episodeId>/revisions/<revisionId>.toml`.
- Deliver only approved public paths through the Worker; never expose `system/` or `staging/`.
- R2 notifications for Show and Episode commit markers in `staging/` feed the same managed Cloudflare Queue. Use one sequential consumer invocation at a time; do not assume FIFO delivery or exactly-once processing. Permit only one unfinished publication per show across Show and Episode jobs, with an atomic admission check and failure recovery; concurrency limiting alone is insufficient. Do not infer publication order from upload timestamps.
- Store MVP job status at `system/jobs/<jobId>/status.toml` in R2. Consider D1 only if later requirements justify it.
- Retry transient consumer failures through Cloudflare Queues for a finite number of attempts and route exhausted messages to one dead-letter queue. Record permanent failure reasons without pointless retries. Administrators inspect R2 job status and recover failed jobs explicitly. Reconcile DLQ entries with status; DLQ delivery does not update R2 status automatically. Keep recovery data in R2 rather than relying on Queue retention. Retry limits, retention periods, and safe release of per-show admission are still to be defined.
- Preserve immutable media and revision history when updating current metadata. Episode deletion is outside the MVP.
- Use readable immutable slugs matching `[a-z0-9]+(?:-[a-z0-9]+)*`; service IDs are at most 20 characters, show IDs at most 32, and episode IDs at most 80. Show IDs are unique within a service; episode IDs are unique within a show. Auto-generated IDs do not eliminate the need to prevent collisions.
- Use Wrangler OAuth login for interactive Cloudflare access and an API token supplied by environment variable for automation. Invoke Wrangler as a CLI subprocess for Cloudflare administration and R2 uploads. Do not store credentials in service TOML or Git. Limit MVP MP3 uploads to 300,000,000 bytes; reject larger files before uploading and verify the maximum supported upload in M0.
- Use Workers Caching for the public Worker. Validate cache-tag feed purging and GET/HEAD/Range delivery before the end-to-end MVP release.
- Overwrite the Show cover art at the approved `public/podcasts/<showId>/cover.<ext>` key on image updates and purge its cache tag. Do not mark a publication job as complete until feed and applicable cover-art Workers Cache purges succeed. Retry purge failures without duplicating published media.

## Milestones
- M0 validates Cloudflare authentication, resource creation, R2 media delivery, Workers Caching, MP3 upload/analysis, and the R2 event-to-Queue path.
- M1 delivers service initialization, local metadata models, ID validation, and show reservation.
- M2 publishes a show through `update-show`/`publish-show` and one episode end-to-end using separate metadata/audio staging, explicit publish, job status, feed generation, and media delivery.
- M3 supports multiple episodes, metadata-only and audio-only revisions, concurrency/retry handling, and cleanup.
- M4 delivers the Bun executable and usage documentation.

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
