# Agent Guide for castloop

castloop hosts podcasts in the administrator's Cloudflare account. Administrators use the standalone CLI to edit and publish shows; listeners retrieve feeds, media and the built-in site over HTTP.

## Hard rules (read first)
1. Choose the simplest implementation that satisfies the requested behavior, established contracts, and evidenced failure cases within supported operation. Additional complexity requires concrete justification; hypothetical future needs or failures outside the operating contract are not sufficient. See "Scope and complexity" below.
2. Complete the requested scope and verify its acceptance criteria before reporting completion. See "Task workflow".
3. Use CodeGraph before locating, reading or editing code when the working directory has a CodeGraph index. See "Code investigation".
4. Local code, test and documentation changes within the requested scope need no mid-task confirmation. Live operations and changes to protected local materials require explicit authorization (see "Safety boundaries").
5. Never add any of these without an explicit request:
   - new dependencies or tooling
   - speculative retry, backoff, fallback or recovery machinery
   - compatibility or migration paths for unsupported versions or layouts
   - fine-grained multi-phase state machines, `blocked` states or lockouts
   - configuration options, flags or extension points with no current use
   - wrappers, factories or interfaces around existing direct code
   - validation of values already guaranteed by types, contracts or trusted internal callers
   - edge-case handling without evidence ("Scope and complexity" defines the acceptable evidence)

Network timeouts and bounded retries for idempotent reads are established conventions. Never automatically resend a mutating request with an unknown outcome. The existing cache-purge handling of explicit rate-limit responses follows the [delivery contract](design/components/delivery.md#更新時のキャッシュ消去).

## Task workflow
1. Before starting, identify the acceptance criteria and applicable constraints. For a non-trivial change, briefly explain the criteria and change scope without omitting important decisions or constraints for brevity. Name expected files when that helps clarify the scope. Mention exclusions only when needed to clarify the request, and additional defensive behavior only with its evidence.
2. Use "Read documentation by task" below to load the applicable skill and contracts before acting.
3. Complete the requested scope. If it grows clearly beyond the agreed scope, stop and ask. If it is too large to finish in one pass, ask to split it before starting.
4. Check every acceptance criterion, run the applicable checks and review written documentation. Finish once these pass; expand investigation only for relevant failures or new evidence. Report unmet criteria as INCOMPLETE with the reason.
5. In the final report, state the changed files and results of verification actually performed. Report test results only when tests were run; omit notices that tests were not run. Mention remaining work only if there is any. If blocked, report the exact error and what was tried; do not report partial work as complete or defer requested work to "next steps".

## Code investigation
- In a checkout with a `.codegraph/` index, use `codegraph_explore` before searching for or reading code. Query the relevant file, symbols or flow; use the returned source and dependency information.
- Use direct reads or grep for documentation, configuration, details CodeGraph did not cover, or files explicitly flagged as stale. Follow the tool's freshness guidance.
- If CodeGraph is unavailable, try `codegraph explore`. If neither interface works, report the limitation and use direct tools. For an existing checkout without an index, use direct tools without creating one unless requested. Newly created worktrees follow "CodeGraph in Git worktrees" below.

## Scope and complexity

- Implement only the requested behavior and existing approved contracts.
  Do not turn possible failures into new requirements.

- Simplicity means minimizing unnecessary state, branches and dependencies while preserving required validation and safety guarantees, not merely reducing line count.

- Before adding defensive logic, identify either an explicit requirement
  or a concrete failure path in supported operation.
  For a failure path, name the real entry point, supported preconditions,
  existing protections, and resulting failure.

- Follow the [local input and serial-operation contract](docs/development/constraints.md#local-inputs-and-serial-operations). A failure that requires violating those preconditions is not, by itself, evidence for additional defensive logic. Preserve existing validation and server-side concurrency and data-protection guarantees.

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

## Repository and checks
- `packages/cli/src/`: the Bun single-executable CLI; `packages/shared/src/`: shared utilities; `src/`: Cloudflare Worker services.
- The production Worker entrypoint is `src/sqlite-worker.ts`. Before changing Worker embedding, deployment configuration or persisted formats, read the relevant [development constraints](docs/development/constraints.md).
- For ordinary code changes, run `bun test` and `npm run check`. Skip both for documentation-only or other changes that do not affect code, builds or runtime behavior.
- For release work, use the required CI verification in [the release procedure](docs/development/releasing.md); a full local rerun is not required. Code fixes made during release work still require the ordinary local checks. Documentation-only release changes still require the release CI checks.
- When a test or command fails, establish the root cause from its output, logs, or other evidence before changing conditions or making assumptions. If diagnostics are insufficient, add focused, privacy-safe logging and rerun the same reproduction; fix the evidenced cause rather than working around unexplained failures.
- No lint or formatter is configured.
- Update the relevant design and usage docs when behavior changes.

## Documentation
- Identify the reader and what they need to understand or do. Organize the text in that order, rather than the order of investigation or implementation.
- Usage guides explain operations in the order users perform them. Design documents describe the current system and the reasons needed to understand it. Plans and verification records hold pending work, performed checks and results. Keep AGENTS.md focused on durable working rules.
- Describe behavior and instructions directly. Include exclusions or negative statements when they prevent a likely misunderstanding or unsafe action, rather than routinely listing things a change does not do.
- Use familiar terms and consistent names. Explain unfamiliar terms and abbreviations on first use.
- Keep historical discussion and rejected alternatives separate from current instructions. Keep each procedure or contract in one authoritative place and link to it instead of copying it into skills or other guides.
- Keep `design/` outside `design/archive/` organized around the current design, not the work that produced it. Issue investigations, option comparisons, implementation plans and work or verification records belong in `design/archive/`. Temporary placement outside the archive is allowed during development; before any push or PR, move those documents into the archive, incorporate adopted decisions into the current design documents, and update links and indexes.
- Reread every document you write or update. Fix unclear wording and reading order; remove repetition, unnecessary preambles and irrelevant exclusions. Follow each document's language requirements; release notes are English only.

## Read documentation by task
- Start with the relevant entry below and read the sections needed for the task. Follow additional references when the change affects another contract, rather than reading every linked document. The design index owns the technical topic-to-document mapping.

| Task | Starting point |
| --- | --- |
| Implementation or ordinary local verification | [Design index](design/README.md#変更内容から探す) and relevant [development constraints](docs/development/constraints.md) |
| CLI release preparation or publication | Load `castloop-release`, then follow the [release procedure](docs/development/releasing.md) |
| Live Cloudflare operations or local evidence cleanup | [Live operation boundaries](design/live-operations.md), then the applicable procedure. For private trial preparation or execution, load `castloop-live-trial` to select the scenario |
| Historical investigation | [Archive index](design/archive/README.md), then the relevant record |

- Existing Queue/v0.5.x references: [Removal plan](design/archive/schema_v1_removal_plan.md), [v0.5.x Queue guide](docs/archive/queue_service.md), [archived architecture](design/archive/initial_design_v052.md).
- Verification records, release notes and archives describe historical context, not current implementation requirements or authorization. Do not turn their past failure modes or pending work into new requirements. The former long-form agent storage notes and milestones are preserved in [this snapshot](design/archive/agent_storage_and_milestones_20261017.md).
- Do not append chronological progress logs, environment inventories, benchmark samples or completed one-time approvals here. Put them in the appropriate design/evidence document and update its index; keep only durable cross-cutting rules here.

## Safety boundaries
- Live Cloudflare changes require explicit authorization for the target and operations. Local work, skill loading and past approvals do not authorize them.
- Before live operations or local evidence cleanup, read [live operation boundaries](design/live-operations.md) and the applicable procedure. Modify only approved targets; preserve shared resources, local originals and private evidence outside that approval.
- Live test content stays private to the approved reviewer. Verify protection before uploading or publishing; stop if it cannot be verified. Broader access requires separate approval.
- Preserve authentication, config/target/base and generation checks, explicit synchronous atomic publication, cache-safe delivery gates, published media and revision history. Follow the relevant design contracts for implementation details.
- Keep secrets out of Git and service TOML; keep local secrets in git-ignored `.castloop/` state. Record only allowlisted diagnostic codes/messages as defined in [security](design/security.md#ログと診断).
- Local tests do not establish native performance or full Free compatibility.

## Data and code conventions
- Local TOML is the editable source, Show DO SQLite is authoritative for committed metadata, and private R2 stores media. See [storage and retention](design/data/storage.md) for layout and retention details.
- Use strict Zod schemas, `@iarna/toml`, `parseSqliteServiceConfig`, `parseShowMetadata`, `parseEpisodeDraft` and `stringifyToml`. TOML keys are snake_case; TypeScript identifiers are camelCase.
- Prefer explicit, focused code and async/await. Avoid global state except shared clients, clever abstractions and unnecessary inline comments.
- Use ES module imports, grouped external, internal, then Node built-ins; prefer `node:` for built-ins. Avoid unused imports.
- Use PascalCase for types/classes and UPPER_SNAKE_CASE for constants. Prefer `type` aliases, explicit exported types and Zod inference; use `unknown` with narrowing instead of `any`.
- Match surrounding formatting: two spaces, double quotes and readable line lengths.
- Throw clear `Error`s in helpers; CLI handlers print errors and set `process.exitCode = 1`. Do not silently swallow failures.

## CodeGraph in Git worktrees
- The `.codegraph/` index is local and untracked; only `.codegraph/.gitignore` is tracked. Initialize each newly created worktree with `codegraph init -y` before agent work.
- Never symlink/copy the database from another checkout or query that checkout's index for code being edited here. Index contents and daemon files belong to their worktree.
- The index is removed with its worktree; no separate cleanup is needed.
