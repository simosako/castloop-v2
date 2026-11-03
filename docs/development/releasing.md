# Releasing the CLI

Merge release preparation through a PR, then tag the commit on `main` to publish a GitHub Release. The CLI includes the delivery Worker.

## Scope and completion

A request to **release** includes preparation, the PR and merge, tagging, publication, and verification of the GitHub Release body and attachments. A request to **prepare a release** ends with a preparation PR and confirmation that its required CI checks pass; merging, tagging and publication remain outside that request. Ask the requester if the version is unclear.

Agents load the project-local `castloop-release` skill before starting. This document remains the authoritative release procedure.

Release verification uses the required PR and tag CI runs described below, including for documentation-only release changes. A full local rerun is not required. Code fixes made during release work still require `bun test` and `npm run check` as ordinary code changes under [AGENTS.md](../../AGENTS.md).

## 1. Prepare the release

1. Create a release preparation branch from the latest `main`.
2. Review the changes since the previous release. Decide the version, user-facing changes, compatibility information, and update instructions.
3. Update the following files and check their content and links:

| File | Update |
| --- | --- |
| `package.json`, `package-lock.json` | Set both versions to the new version. The CLI's `--version` uses `package.json`. |
| `docs/release-vX.Y.Z.md` | Write the new release notes in English, covering the main changes, requirements, update instructions, and verification performed. |
| `CHANGELOG.md` | Add a summary and link to the new notes, and organize unreleased entries. |
| `README.md`, `README_ja.md`, `CONTRIBUTING.md` | Check the latest version, release notes links, and compatibility information; update them as needed. |
| `skills/castloop/SKILL.md`, `skills/castloop/references/publish.md`, `packages/cli/src/admin-skill.test.ts` | Check version and requirements descriptions and their tests; update them as needed. |
| `docs/archive/releases/` | Move the previous release notes here and update its `README.md` index. Check relative links in the moved notes. |
| Other guides and indexes | Update descriptions of changed features and links to the latest or moved notes as needed. |

Write release notes in English only and keep the latest notes directly under `docs/`. CI uses `docs/release-vX.Y.Z.md` matching the tag as the GitHub Release body, so check links both in the repository and on GitHub Releases.

Describe the verification actually performed and its scope. Obtain explicit approval for the target and operations before live Cloudflare testing, and do not report unperformed checks as complete.

## 2. Create the PR and merge for publication

Commit and push the prepared changes, then create a PR targeting `main`. Confirm that all build and smoke jobs in [build-binaries.yml](../../.github/workflows/build-binaries.yml) pass. For a preparation-only request, stop here and report the PR and CI results. For a release request, merge the PR after these checks pass, then continue to tagging and publication.

CI runs type checking and the full local test suite on Linux, then builds and smoke-tests the CLI on Linux x64, macOS arm64, and Windows x64. It also checks version, help, checksums, input validation, local previews, Skill output, and more.

For optional early feedback or investigation during release work, use the [local checks](#local-checks). The ordinary checks for code fixes remain required as described above.

## 3. Tag and publish

1. Check `main` after the merge and identify the commit to release. Confirm that PR CI passed for the changes included in it. If fixes are needed after merging, make them through a PR as well.
2. Tag the release commit with `vX.Y.Z`, matching the version in `package.json`, and push the tag.
3. Confirm that the CI run triggered by the tag succeeds. CI builds and smoke-tests again, then creates the GitHub Release.
4. Check the GitHub Release body, links, and these attachments:

   - `castloop-linux-x64`, `castloop-macos-arm64`, `castloop-windows-x64.exe`
   - `castloop-skill.tar.gz`
   - `SHA256SUMS`, `SKILL_SHA256SUMS`
   - `LICENSE`, `THIRD_PARTY_NOTICES.md`

## Local checks

Set up the development environment using [CONTRIBUTING.md](../../CONTRIBUTING.md). The following example checks a Linux x64 build:

```sh
npm ci
npm run check
bun test
npm run build:cli -- linux-x64
node scripts/smoke-agent-cli.mjs dist/castloop-linux-x64
```

The executable is written to `dist/`. The [build script](../../scripts/build-cli.ts) embeds `src/sqlite-worker.ts` in the CLI.

## Maintain CI

Follow the [update guide](ci_security.md) when updating external actions. If you update the runtime environment, Bun, or Node.js, repeat the build and smoke checks for all three binaries.
