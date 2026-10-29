# Contributing to castloop

Thank you for considering a contribution. castloop is a safety-sensitive tool: it deploys and manages real Cloudflare resources, and its local state contains secrets. The rules below exist to keep contributions reviewable and to make it impossible to leak credentials through the repository.

## Project status

castloop is an **early beta** (v0.8.0). Only fresh service configurations using `schema_version = 2`, `sqlite-sequential-v1`, and `storage_layout = "show-v1"` with internal formats 14/13 are supported. Older internal formats are not migrated; Queue/R2 services need the separate v0.5.x line. Check [README.md](README.md) and the [design index](design/README.md) before proposing changes so your idea is not already covered or intentionally excluded.

## Development setup

Requirements:

- [Bun](https://bun.sh) 1.4.2 (runtime and test runner)
- Node.js 24 and npm (for `npm ci` and TypeScript)
- No Wrangler, no Cloudflare account, and no API tokens: the test suite is fully local and never touches Cloudflare.

```sh
npm ci
mkdir -p -m 700 /tmp/opencode   # scratch workspace some tests use
npm run check                   # TypeScript, must be clean
bun test                        # full local test suite
```

To build the Linux binary: `npm run build:cli -- linux-x64` (output: `dist/castloop-linux-x64`). The executable embeds only `src/sqlite-worker.ts`.

There is **no lint step and no formatter configured**; please do not add tooling. Match the surrounding code style instead: two-space indent, double quotes, ES module imports grouped as external → internal → Node built-ins (`node:` prefix), camelCase identifiers, PascalCase types, UPPER_SNAKE_CASE constants.

## Safety rules for every change

- **Never commit** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, anything from `.castloop/` (administrator key, journals), unpublished audio, or real service URLs from your own account. These paths are git-ignored; keep them that way.
- Tests must stay local. Do not add tests that require live Cloudflare credentials, deployments, or network access to your own resources.
- Worker diagnostics must stay on the allowlisted diagnostic codes; do not log arbitrary exceptions, content text, email addresses or secrets.
- Preserve the safety gates when touching related code: explicit publication (create/update/upload must not publish), `failed`/`blocked` distinction, no automatic retry of POST/PUT mutations, immutable published audio during normal updates, and the delivery/caching gates. If you believe a gate should change, open an issue first.
- When behavior changes, update the relevant documents under `docs/` or `design/` in the same pull request. Design and operations documents are currently written in Japanese; English translations of unchanged content are welcome as separate pull requests.

## How to propose a change

1. **Open an issue first** for anything that is not an obvious bug fix — especially changes to the publication protocol, lifecycle behavior, or anything that touches the frozen-request/recovery model. Wait for alignment before investing in a large implementation.
2. Create a feature branch from `main`, named after the issue (for example `feat/issue-40-operation-recovery`).
3. Keep pull requests focused: one behavior per PR, with tests that fail before and pass after.
4. Run `npm run check` and `bun test` locally; CI runs the same checks plus a smoke test of the built binary.
5. Write commit messages in the imperative mood with a type prefix (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `release:`), as the existing history does.

## Pull request checklist

- [ ] `npm run check` passes
- [ ] `bun test` passes
- [ ] No credentials, `.castloop/` content, or unpublished audio is included
- [ ] No new dependencies without prior discussion, and `THIRD_PARTY_NOTICES.md` updated if dependencies changed
- [ ] Relevant `docs/` / `design/` documents updated when behavior changed
- [ ] No new lint/format tooling introduced

## Agent-assisted contributions

Contributions authored with coding agents are welcome. The repository's [AGENTS.md](AGENTS.md) documents the durable rules agents must follow (documentation routing, safety boundaries, code conventions); point your agent at it before starting work.

## Reporting bugs and security issues

- Bugs and usage problems: use the [issue templates](.github/ISSUE_TEMPLATE). Redact tokens, keys, journals and private URLs.
- Security vulnerabilities: follow [SECURITY.md](SECURITY.md) — private vulnerability reporting only.

Licensing: by contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) that covers the project.
