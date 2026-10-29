# Agent Guide for castloop

## Hard rules (read first)
1. Implement exactly the requested behavior. See "Scope and complexity" below.
2. Finish the entire requested task before replying. See "Completion contract".
3. For any non-trivial change, state the scope before coding. See "Task protocol".
4. Local code, test and documentation changes within the requested scope need no mid-task confirmation. Only live Cloudflare operations require explicit authorization (see "Safety boundaries").
5. Never add any of these without an explicit request:
   - new dependencies or tooling
   - speculative retry, backoff, fallback or recovery machinery; network timeouts and bounded retries for idempotent reads (as in the shared HTTP helpers) are established conventions, and never retry mutating calls automatically
   - compatibility or migration paths for unsupported versions or layouts
   - fine-grained multi-phase state machines, `blocked` states or lockouts
   - configuration options, flags or extension points with no current use
   - wrappers, factories or interfaces around existing direct code
   - validation of values already guaranteed by types, contracts or trusted internal callers
   - edge-case handling without evidence ("Scope and complexity" defines the acceptable evidence)

## Task protocol
Before writing code for a non-trivial change, state in five lines or fewer:
- the requested behavior in your own words (1–2 sentences),
- the files you expect to touch,
- any additional defensive behavior you intend to implement and its evidence; do not enumerate hypothetical edge cases,
- an explicit out-of-scope list.

If the change grows clearly beyond this during work, stop and ask instead of expanding silently.

## Completion contract (Definition of Done)
1. Complete the entire requested task before replying. A progress report is not a deliverable.
2. Before starting, restate the request's acceptance criteria as a short list. Before finishing, verify every item and list any unchecked item as INCOMPLETE with the reason.
3. The final report states the changed files, the `bun test` and `npm run check` results (skipped only for documentation-only changes), and anything intentionally left undone.
4. Never end with "next steps" that belong to the original request.
5. If blocked, report the exact error and what was tried. That is a failure report, not a partial success.
6. If the task is too large to finish in one pass, ask to split it before starting — not midway.

## Scope and complexity

- Implement only the requested behavior and existing approved contracts.
  Do not turn possible failures into new requirements.

- Before adding defensive logic, identify either an explicit requirement
  or a concrete failure path in supported operation.
  For a failure path, name the real entry point, supported preconditions,
  existing protections, and resulting failure.

- Artificial reproducibility alone is not evidence of production relevance.
  A failing test must be tied to a requirement or a supported execution path.
  Do not create tests or specifications merely to justify extra machinery.

- Fault injection is useful when it represents an evidenced runtime,
  dependency, or external-input failure. Bypassing trusted internal guarantees
  does not by itself justify additional production handling.

- Check existing validation and runtime guarantees before adding protection.
  Prefer existing mechanisms or a clear error over new recovery machinery.

- If relevance is unsupported, omit the additional mechanism and continue
  with the requested work. Ask only when the ambiguity materially affects
  required behavior, security, data integrity, or authorization.

- Generic best practices do not expand the requested scope.
  Preserve established security controls and data-integrity guarantees.

- Once acceptance criteria and required checks pass, finish.
  Expand investigation only for relevant failures or new evidence.

## Repository and checks
- `packages/cli/src/`: the Bun single-executable CLI; `packages/shared/src/`: shared utilities; `src/`: Cloudflare Worker services.
- Run `bun test` and `npm run check` for automated tests and TypeScript validation. Skip both for documentation-only or other changes that do not affect code, builds, or runtime behavior.
- When a test or command fails, establish the root cause from its output, logs, or other evidence before changing conditions or making assumptions. If diagnostics are insufficient, add focused, privacy-safe logging and rerun the same reproduction; fix the evidenced cause rather than working around unexplained failures.
- No lint or formatter is configured. Do not add tooling without an explicit request.
- Update the relevant design and usage docs when behavior changes.
- After writing or updating a specification or plan, reread it and fix any unnatural, ambiguous, or hard-to-understand wording. Explain unfamiliar terms and avoid unexplained shorthand.

## Read documentation by task
- Use [design/README.md](design/README.md) to locate relevant documents; do not read all design docs or historical records on every task.
- For implementation tasks, read only the contract documents listed for the task below, and only the sections relevant to the change. Verification records, release notes and `design/archive/` are history, not implementation inputs: do not justify new defensive code with failure modes recorded there.
- Current architecture: [design/initial_design.md](design/initial_design.md). Usage: [README.md](README.md).
- Development supports only fresh SQLite service configs (`schema_version=2`, `sqlite-sequential-v1`, required `storage_layout="show-v1"`); `init` uses this by default. Reject service schema version 1 and legacy layouts before IO or local state changes. Never add migration, legacy layout support, resource adoption or fallback. Shared content/request schema version 1 is independent and remains supported.
- The production Worker entrypoint is `src/sqlite-worker.ts`; embed only that Worker. Preserve existing DO/cache class names, bindings, compatibility date and persisted SQLite formats during code-only cleanup.

| When working on | Read the relevant contract |
| --- | --- |
| Overall architecture or simplification | [Architecture simplification review](design/architecture_simplification_review_20261028.md), [Phase 1](design/phase1_atomic_publication_and_ondemand_delivery_plan.md), [Phase 2](design/phase2_direct_media_and_cli_simplification_plan.md), [Phase 3](design/phase3_deploy_and_runtime_control_simplification_plan.md), [Phase 4](design/phase4_code_and_test_cleanup_plan.md) |
| SQLite publication, lifecycle or updates | [SQLite guide](docs/sqlite_sequential_development.md), [Phase 2 plan](design/phase2_direct_media_and_cli_simplification_plan.md), [Phase 3 plan](design/phase3_deploy_and_runtime_control_simplification_plan.md) |
| Show isolation or service control | [Show separation contract](design/do_show_separation_options.md), [Phase 3 plan](design/phase3_deploy_and_runtime_control_simplification_plan.md). Keep publication and delivery local to each Show DO; the control DO handles only Show registration, catalog listing and custom domain state |
| Custom domain changes | [SQLite domain guide](docs/sqlite_custom_domains.md), [Phase 3 plan](design/phase3_deploy_and_runtime_control_simplification_plan.md), [Phase 4 plan](design/phase4_code_and_test_cleanup_plan.md). Concurrent external changes to the same hostname/DNS/Worker domain are unsupported |
| Removed Queue code or v0.5.x history | [Removal plan](design/archive/schema_v1_removal_plan.md), [v0.5.x Queue guide](docs/queue_service.md), [archived architecture](design/archive/initial_design_v052.md) |
| Lifecycle, deletion or retention | [SQLite guide](docs/sqlite_sequential_development.md), [approved retention and safety policy](design/m6_review_queue.md). Physical deletion is not implemented; do not transplant archived Queue operations |
| Public delivery or caching | [Current architecture](design/initial_design.md), [Phase 1 plan](design/phase1_atomic_publication_and_ondemand_delivery_plan.md) |
| RSS import or publication | [RSS migration guide](docs/rss_migration.md), [RSS design](design/m7_rss_import_plan.md) |
| Live environments or past acceptance claims | [Retained service disposal 2026-10-29](design/archive/sq16r_environment_decommission_20261029.md), [2026-10-17 cleanup outcome](design/archive/cloudflare_test_environment_cleanup_20261017.md), then the relevant measurement record linked from the design index |

- `design/archive/` is historical evidence, not a task queue or current operational authorization. Consult it only for relevant history. The former long-form agent storage notes and milestones are preserved in [this snapshot](design/archive/agent_storage_and_milestones_20261017.md).
- Do not append chronological progress logs, environment inventories, benchmark samples or completed one-time approvals here. Put them in the appropriate design/evidence document and update its index; keep only durable cross-cutting rules here.

## Safety boundaries
- Code changes, tests, commits, pushes and past approvals do not authorize live Cloudflare changes. Deployment, publication, migration, resource creation/deletion, domains, permissions, billing/CPU limits and local evidence cleanup need explicit authorization for the target and scope. Do not request a Paid-plan upgrade as a workaround.
- Keep every live test deployment private to the explicitly authorized reviewer by default. Before uploading or publishing sample content, verify Cloudflare Access protection for every content path (HTML, feeds, images and audio), an exact reviewer identity policy without bypass, private R2 and no unprotected alternate hostname or preview URL. Preserve administrator-key authentication, and recheck anonymous GET/HEAD/conditional/Range denial after deployment or publication. Do not use an unlisted URL or noindex as access control; stop if protection cannot be verified. See [private trial procedure](design/show_website_private_trial_plan.md). Any broader access requires separate explicit approval.
- Preserve non-test `otftalk.com` DNS, shared certificates, local originals and private evidence. Completed old-environment cleanups (including the 2026-10-29 disposal of the retained `sq16r-6ec01dc6` service) are not permission for further mutations or cleanup; never reuse disposed resource names.
- Design updates, deployments and administrative operations to be idempotent and atomic (either complete or fail without corrupting committed state) so interrupted operations can simply be re-run from the beginning after checking current state via API. Do not build fine-grained multi-phase state machines, `blocked` states, `*_requested` lockouts, or step-by-step recovery commands. When an operation changes service configuration (such as custom domain changes), save the previous configuration so the target or previous state can be cleanly re-applied.
- Preserve config/target/base and generation checks, synchronous atomic publication, and cache-safe delivery gates.
- Keep publication explicit: create/preview/upload alone must not publish. Reject stale local inputs when base revisions have advanced.
- Preserve immutable published audio and revision history during normal updates, and saved GUID/date/audio identities when restoring snapshots. Never delete published audio or cover objects during deployments or failed updates.
- Deliver only approved public paths through lifecycle/readiness gates; never expose `system/` or `staging/`. Complete required feed/site cache purges before committing publication or domain changes.
- Keep MP3 uploads limited to 300,000,000 bytes; reject oversized inputs before upload and verify size and content hash.
- Use `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` with direct REST administration from the standalone CLI. Do not require Wrangler, Node.js or separate R2 credentials on the administrator's machine. Never store secrets in service TOML or Git; keep local secrets in git-ignored `.castloop/` state.
- Persist only allowlisted diagnostic codes/messages, not arbitrary exceptions, content text, email addresses or secrets in operational records. Report missing measurement evidence honestly; local tests do not establish native performance or full Free compatibility.

## Data and code conventions
- Local TOML is the editable source; R2 holds immutable media payloads (`audio/<sha256>.mp3`, `covers/<sha256>.jpg|png`) and `system/service.toml`; Show DO SQLite holds committed metadata, revision history, schedules and delivery statistics. Each service has one private R2 bucket; show IDs partition object keys. Keep `public_base_url` in service config, not an R2 public URL in show metadata.
- Use strict Zod schemas, `@iarna/toml`, `parseSqliteServiceConfig`, `parseShowMetadata`, `parseEpisodeDraft` and `stringifyToml`. TOML keys are snake_case; TypeScript identifiers are camelCase.
- Prefer explicit, focused code and async/await. Avoid global state except shared clients, clever abstractions and unnecessary inline comments.
- Use ES module imports, grouped external, internal, then Node built-ins; prefer `node:` for built-ins. Avoid unused imports.
- Use PascalCase for types/classes and UPPER_SNAKE_CASE for constants. Prefer `type` aliases, explicit exported types and Zod inference; use `unknown` with narrowing instead of `any`.
- Match surrounding formatting: two spaces, double quotes and readable line lengths.
- Throw clear `Error`s in helpers; CLI handlers print errors and set `process.exitCode = 1`. Do not silently swallow failures. Worker diagnostics must follow the allowlist/privacy rule.

## CodeGraph in Git worktrees
- The `.codegraph/` index is local and untracked; only `.codegraph/.gitignore` is tracked. Initialize each newly created worktree with `codegraph init -y` before agent work.
- Never symlink/copy the database from another checkout or query that checkout's index for code being edited here. Index contents and daemon files belong to their worktree.
- The index is removed with its worktree; no separate cleanup is needed.
