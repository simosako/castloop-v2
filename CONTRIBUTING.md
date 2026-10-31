# Contributing to castloop

Thank you for your interest in contributing to castloop. Bug reports, documentation improvements, and code contributions are welcome.

## Before you start

For a bug or usage problem, please use an [issue template](.github/ISSUE_TEMPLATE). For a larger change, open an issue first to discuss the approach. For a security vulnerability, follow the private reporting instructions in [SECURITY.md](SECURITY.md).

The [design documentation](design/README.md) describes how castloop works and is a useful starting point for implementation changes. The user guides in [docs/](docs/README.md) describe current behavior.

## Set up the development environment

The CI environment uses [Bun](https://bun.sh) 1.4.4 and Node.js 24 with npm. After cloning the repository, install the dependencies and run the checks:

```sh
npm ci
mkdir -p -m 700 /tmp/opencode
npm run check
bun test
```

Some tests use `/tmp/opencode` for temporary files; the command above creates it on Linux. The full test suite runs locally, using simulated Cloudflare services. CI runs it and the TypeScript check on Linux, and builds and smoke-tests the CLI on Linux, macOS, and Windows.

To build the Linux CLI locally:

```sh
npm run build:cli -- linux-x64
```

The binary is written to `dist/castloop-linux-x64`. See the [testing guide](design/testing.md) for test locations and checks for specific changes, and the [development documentation](docs/development/README.md) for build and release information.

## Make a change

1. Create a branch from `main` and keep the change focused.
2. Add or update tests for changes in behavior. Follow the surrounding code style; no formatter or linter is configured.
3. Update the relevant [user guides](docs/README.md) and [design documentation](design/README.md) when behavior changes. These documents are currently written in Japanese.
4. Run `npm run check` and `bun test`. For documentation-only changes, check the wording, links, and accuracy instead.
5. Open a pull request describing the change, its motivation, and how you tested it. Link the related issue when applicable.

Discuss new dependencies before adding them, and update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) if dependency notices change. Please discuss new lint or formatting tools before proposing them.

## Protect data and publication

castloop manages Cloudflare resources and podcast content. When working on changes:

- Keep credentials, `.castloop/` state, private URLs, and unpublished content out of issues, pull requests, and commits. Redact examples and logs before sharing them.
- Keep automated tests local and independent of live Cloudflare credentials and resources. Live testing requires authorization for the target environment and operations; see the [private trial procedure](design/security.md#非公開の実機試験).
- Preserve explicit publication, atomic updates, checks on reviewed inputs and delivery readiness, and published audio and revision history. Do not automatically retry mutating requests.
- Keep Worker diagnostics limited to the approved codes and messages; do not log secrets, content, email addresses, or arbitrary exceptions. See the [security design](design/security.md) and the relevant [component design](design/README.md) for details.

## Agent-assisted contributions

Contributions made with coding agents are welcome. The repository's [AGENTS.md](AGENTS.md) provides project-specific instructions for agents.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
