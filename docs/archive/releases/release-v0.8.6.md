# castloop v0.8.6

This maintenance release adds a reproducible procedure and verification script for private live trials, and hardens the release smoke script against transient Windows file locks. The CLI, service configuration, storage formats, and delivery behavior are unchanged from v0.8.5.

## Highlights

- A [private live trial runbook](https://github.com/simosako/castloop-v2/blob/v0.8.6/design/live-trial.md) and its verification script (`scripts/live-trial-verify.py`) now make approved private live trials reproducible from the procedure alone, covering explicit approval, asset selection, resource naming, Cloudflare Access setup, publication, and evidence recording. Requirements and principles remain in the [security design](https://github.com/simosako/castloop-v2/blob/v0.8.6/design/security.md); each run's outcome is recorded under [design/archive](https://github.com/simosako/castloop-v2/blob/v0.8.6/design/archive/README.md).
- The runbook and script were verified against a fresh private trial environment on 2026-11-01, and the two temporary live trial environments (including the v0.8.5 trial) were disposed of afterwards. The [development guide](https://github.com/simosako/castloop-v2/blob/v0.8.6/AGENTS.md) and design documents now point to the runbook.
- Release tooling only: the release smoke script now retries workspace cleanup while Windows briefly holds a lock on the spawned binary, so a transient cleanup error can no longer mask a passed smoke run. This does not affect the released CLI.

## Requirements and updates

Service configuration and supported internal formats are unchanged from v0.8.5. To get started, follow the [installation guide](https://github.com/simosako/castloop-v2/blob/v0.8.6/docs/installation.md) and the [first publication guide](https://github.com/simosako/castloop-v2/blob/v0.8.6/docs/getting_started.md). The guides are also available in [Japanese](https://github.com/simosako/castloop-v2/blob/v0.8.6/docs/README_ja.md).

To update an existing installation, follow the [CLI update instructions](https://github.com/simosako/castloop-v2/blob/v0.8.6/docs/installation.md#update-the-cli). The bundled Worker keeps the same storage formats; see the [service maintenance guide](https://github.com/simosako/castloop-v2/blob/v0.8.6/docs/maintenance.md) to update the delivery Worker when convenient.

## Verification

GitHub Actions runs type checking and the full local test suite on Linux and builds and smoke-tests the release binaries on Linux x64, macOS arm64, and Windows x64. The pull request CI run for this release completed successfully: the local test suite, the type check, and three-platform build and smoke checks all passed, including the updated Windows smoke cleanup.

The live trial runbook verification recorded under [design/archive](https://github.com/simosako/castloop-v2/blob/v0.8.6/design/archive/live_trial_runbook_verification_20261101.md) covers the runbook and script added in this release, performed in a fresh isolated environment protected by Cloudflare Access and disposed of afterwards. No live Cloudflare testing was performed for this release itself.

## Download

Download the file for your operating system from the [v0.8.6 GitHub Release](https://github.com/simosako/castloop-v2/releases/tag/v0.8.6).
