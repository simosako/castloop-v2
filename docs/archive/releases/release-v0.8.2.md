# castloop v0.8.2

This maintenance release clarifies the release procedure. The CLI and Worker have no functional changes from v0.8.1.

## Highlights

- Documented which files to update during release preparation and the steps from creating a PR to checking the GitHub Release.
- Added the release procedure to `AGENTS.md` for reference when releasing.

## Requirements

The service configuration and supported internal formats are unchanged from v0.8.1. To get started, follow the current [installation guide](https://github.com/simosako/castloop-v2/blob/main/docs/installation.md), then [create a service and publish your first episode](https://github.com/simosako/castloop-v2/blob/main/docs/getting_started.md).

## Verification

GitHub Actions runs type checking and automated tests, and smoke-tests the release binaries on Linux x64, macOS arm64, and Windows x64. No live Cloudflare testing was performed.

## Download

Download the file for your operating system from the [v0.8.2 GitHub Release](https://github.com/simosako/castloop-v2/releases/tag/v0.8.2).
