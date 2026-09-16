# Agent Guide for castloop

This file guides agentic coding assistants working in this repo.
Follow the commands and conventions below.

## Repository overview
- Monorepo with workspaces under `packages/`.
- `packages/cli` contains the `castloop` CLI.
- `packages/lambda` contains Lambda handlers.
- `packages/shared` holds shared TOML schemas/utilities.
- `design/` holds product and system design docs.

## Lint/format commands
- No lint or formatter is configured yet.
- Do not add new tooling without explicit request.

## Test commands
- No automated tests are configured yet.

## Runtime targets
- Not decided yet.


## Data & storage conventions
- System bucket: `castloop-<serviceId>-system`.
- Show bucket: `castloop-<serviceId>-<showId>`.
- All S3 buckets are non-public; access via CloudFront OAC.
- Draft assets live under `temp/episodes/<episodeId>/`.
- Published assets live under `public/podcasts/<showId>/`.
- Published episode metadata is `public/episodes/<episodeId>/metadata.toml`.

## TOML and schema conventions
- TOML keys are snake_case to match metadata definitions.
- Parse TOML with `@iarna/toml` and validate with Zod.
- Use `parseServiceConfig`, `parseShowMetadata`, `parseEpisodeDraft`.
- Use `stringifyToml` for writing TOML back to S3.
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
- Lambda should return `{ status: "error", message }` and log errors.
- Avoid swallowing errors silently.

## File placement guidelines
- Shared utilities go in `packages/shared/src`.
- CLI commands live in `packages/cli/src`.
- Update design docs in `design/` when behavior changes.

## References
- Design docs: `design/`.
