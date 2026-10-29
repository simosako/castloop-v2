# Agent Guide for castloop

## Engineering principles: evidence-driven simplicity

Prefer the simplest correct implementation that satisfies the actual requirements. Optimize for correctness, clarity, maintainability, and minimal complexity, not hypothetical robustness or speculative future needs. Every added abstraction, defensive check, dependency, or layer of indirection must justify its complexity.

**Complexity is a cost, not a sign of engineering quality.** These principles do not override the project-specific safety boundaries, documented invariants, or required checks below.

### 1. Implement only what is required
- Implement the requested behavior, not imagined future requirements.
- Follow existing codebase conventions and reuse existing mechanisms.
- Prefer small, focused changes and direct, readable code over broad refactoring or unnecessarily abstract designs.
- Do not introduce frameworks, architectural layers, wrappers, factories, interfaces, configuration options, or dependencies without a concrete need.
- Do not generalize code for hypothetical reuse or create helpers or classes merely to make short, straightforward code appear more structured.

### 2. Evidence-based defensive programming
Add defensive logic only when justified by at least one of:
- An explicit requirement or documented invariant.
- A realistic failure mode supported by the current architecture.
- An observed bug or test failure.
- A concrete security threat crossing a trust boundary.
- A well-established correctness requirement of the language, runtime, or API.

A theoretically possible failure alone is not sufficient justification. In particular:
- Do not add redundant validation for values already guaranteed by types, contracts, or trusted internal callers, or multiple validation layers for the same invariant without justification.
- Do not add speculative fallbacks, retries, timeouts, or recovery mechanisms.
- Do not swallow exceptions or turn unexpected failures into apparent success.
- Do not add compatibility logic for unsupported or imaginary environments.
- Do not add concurrency controls without a credible concurrent execution path and a concrete shared-state risk.
- Do not add defensive branches for impossible states unless the invariant is genuinely untrusted or externally controlled.

Mention an unjustified hypothetical edge case briefly only when materially relevant; do not implement code for it.

### 3. Concurrency and security
Assess concurrency and security risks using the actual execution model and trust boundaries.

Before adding concurrency protection, identify:
- Which operations can execute concurrently.
- Which mutable state or resource they share.
- What concrete failure could occur.
- Why existing mechanisms are insufficient.

Before adding security-specific complexity, identify:
- The trust boundary.
- The attacker-controlled input or capability.
- The plausible exploit or failure.
- The smallest effective mitigation.

Never remove or bypass established security controls, required authorization, input validation at trust boundaries, or essential data-integrity guarantees merely to simplify code.

### 4. Scope and change discipline
- Make the smallest coherent change that fully resolves the task.
- Preserve existing behavior unless a change is explicitly requested; do not refactor unrelated code.
- Do not add dependencies without a clear benefit.
- Do not create speculative extension points or implement unrequested features.
- Prioritize tests for realistic behavior, regressions, and documented requirements, not imaginary scenarios.
- If a broader change is genuinely necessary, explain why before expanding the scope.

### 5. Implementation decision rule
For each proposed abstraction, defensive mechanism, or architectural addition, ask:
1. What concrete requirement or realistic failure does this address?
2. What evidence shows the problem is relevant here?
3. Can the same goal be achieved with less code or fewer moving parts?
4. Would removing this mechanism compromise correctness, security, or a documented requirement?

If there is no convincing justification, omit the mechanism. Prefer proven simplicity over speculative completeness.

### 6. Verification
- Run the relevant existing checks as specified in "Repository and checks" below.
- Verify the requested behavior and realistic failure paths; do not expand the implementation merely to satisfy hypothetical test cases.
- Before finishing, review the diff for unnecessary abstractions, defensive branches, dependencies, and unrelated changes. Remove unjustified complexity discovered during that review.

### 7. Communication
- Clearly distinguish observed facts from assumptions and hypothetical concerns; do not present speculative risks as established problems.
- Explain significant implementation trade-offs concisely.
- Mention an unaddressed, low-probability edge case outside the requirements only when materially relevant.
- Prefer working, straightforward code over elaborate explanations or defensive implementations.

## Repository and checks
- `packages/cli/src/`: the Bun single-executable CLI; `packages/shared/src/`: shared utilities; `src/`: Cloudflare Worker services.
- Run `bun test` and `npm run check` for automated tests and TypeScript validation. Skip both for documentation-only or other changes that do not affect code, builds, or runtime behavior.
- When a test or command fails, establish the root cause from its output, logs, or other evidence before changing conditions or making assumptions. If diagnostics are insufficient, add focused, privacy-safe logging and rerun the same reproduction; fix the evidenced cause rather than working around unexplained failures.
- No lint or formatter is configured. Do not add tooling without an explicit request.
- Update the relevant design and usage docs when behavior changes.
- After writing or updating a specification or plan, reread it and fix any unnatural, ambiguous, or hard-to-understand wording. Explain unfamiliar terms and avoid unexplained shorthand.

## Read documentation by task
- Use [design/README.md](design/README.md) to locate relevant documents; do not read all design docs or historical records on every task.
- Current architecture: [design/initial_design.md](design/initial_design.md). Usage: [README.md](README.md).
- Development supports only fresh SQLite service configs (`schema_version=2`, `sqlite-sequential-v1`, required `storage_layout="show-v1"`); `init` uses this by default. Reject service schema version 1 and legacy layouts before IO or local state changes. Never add migration, legacy layout support, resource adoption or fallback. Shared content/request schema version 1 is independent and remains supported.
- The production Worker entrypoint is `src/sqlite-worker.ts`; embed only that Worker. Preserve existing DO/cache class names, bindings, compatibility date and persisted SQLite formats during code-only cleanup.

| When working on | Read the relevant contract |
| --- | --- |
| Overall architecture or simplification | [Architecture simplification review](design/architecture_simplification_review_20261028.md), [Phase 1](design/phase1_atomic_publication_and_ondemand_delivery_plan.md), [Phase 2](design/phase2_direct_media_and_cli_simplification_plan.md), [Phase 3](design/phase3_deploy_and_runtime_control_simplification_plan.md) |
| SQLite publication, lifecycle or updates | [SQLite guide](docs/sqlite_sequential_development.md), [Phase 2 plan](design/phase2_direct_media_and_cli_simplification_plan.md), [Phase 3 plan](design/phase3_deploy_and_runtime_control_simplification_plan.md) |
| Show isolation or service control | [Show separation contract](design/do_show_separation_options.md), [Phase 3 plan](design/phase3_deploy_and_runtime_control_simplification_plan.md). Keep publication and delivery local to each Show DO; the control DO handles only Show registration, catalog listing and custom domain state |
| Custom domain changes | [SQLite domain guide](docs/sqlite_custom_domains.md), [Phase 3 plan](design/phase3_deploy_and_runtime_control_simplification_plan.md). Concurrent external changes to the same hostname/DNS/Worker domain are unsupported |
| Removed Queue code or v0.5.x history | [Removal plan](design/schema_v1_removal_plan.md), [v0.5.x Queue guide](docs/queue_service.md), [archived architecture](design/archive/initial_design_v052.md) |
| Lifecycle, deletion or retention | [SQLite guide](docs/sqlite_sequential_development.md), [approved retention and safety policy](design/m6_review_queue.md). Physical deletion is not implemented; do not transplant archived Queue operations |
| Public delivery or caching | [Current architecture](design/initial_design.md), [Phase 1 plan](design/phase1_atomic_publication_and_ondemand_delivery_plan.md) |
| RSS import or publication | [RSS migration guide](docs/rss_migration.md), [RSS design](design/m7_rss_import_plan.md) |
| Live environments or past acceptance claims | [Cleanup outcome and retained environment](design/archive/cloudflare_test_environment_cleanup_20261017.md), then the relevant measurement record linked from the design index |

- `design/archive/` is historical evidence, not a task queue or current operational authorization. Consult it only for relevant history. The former long-form agent storage notes and milestones are preserved in [this snapshot](design/archive/agent_storage_and_milestones_20261017.md).
- Do not append chronological progress logs, environment inventories, benchmark samples or completed one-time approvals here. Put them in the appropriate design/evidence document and update its index; keep only durable cross-cutting rules here.

## Safety boundaries
- Code changes, tests, commits, pushes and past approvals do not authorize live Cloudflare changes. Deployment, publication, migration, resource creation/deletion, domains, permissions, billing/CPU limits and local evidence cleanup need explicit authorization for the target and scope. Do not request a Paid-plan upgrade as a workaround.
- Keep every live test deployment private to the explicitly authorized reviewer by default. Before uploading or publishing sample content, verify Cloudflare Access protection for every content path (HTML, feeds, images and audio), an exact reviewer identity policy without bypass, private R2 and no unprotected alternate hostname or preview URL. Preserve administrator-key authentication, and recheck anonymous GET/HEAD/conditional/Range denial after deployment or publication. Do not use an unlisted URL or noindex as access control; stop if protection cannot be verified. See [private trial procedure](design/show_website_private_trial_plan.md). Any broader access requires separate explicit approval.
- Preserve the retained `sq16r-6ec01dc6` service, non-test `otftalk.com` DNS, shared certificates, local originals and private evidence. Completed old-environment cleanup is not permission for further mutations or cleanup.
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
