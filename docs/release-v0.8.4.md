# castloop v0.8.4

This maintenance release updates the pinned GitHub Actions used by the release CI. The CLI and Worker have no functional changes from v0.8.3.

## Highlights

- Updated the pinned release actions to current releases that run on the Node 24 action runtime: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `actions/upload-artifact` v7.0.2, and `actions/download-artifact` v8.0.2. This clears the Node.js 20 deprecation warnings after GitHub removed Node 20 from Actions runners.
- Every pin remains a full 40-character commit SHA verified against the action's own `action.yml` before the update, following the [release CI security guide](https://github.com/simosako/castloop-v2/blob/v0.8.4/docs/development/ci_security.md).

## Requirements and updates

Service configuration and supported internal formats are unchanged from v0.8.3. To get started, follow the [installation guide](https://github.com/simosako/castloop-v2/blob/v0.8.4/docs/installation.md) and the [first publication guide](https://github.com/simosako/castloop-v2/blob/v0.8.4/docs/getting_started.md). The guides are also available in [Japanese](https://github.com/simosako/castloop-v2/blob/v0.8.4/docs/README_ja.md).

To update an existing installation, follow the [CLI update instructions](https://github.com/simosako/castloop-v2/blob/v0.8.4/docs/installation.md#update-the-cli). The bundled Worker has no functional changes from v0.8.3.

## Verification

GitHub Actions runs type checking and automated tests on Linux and smoke-tests the release binaries on Linux x64, macOS arm64, and Windows x64. The pull request CI run for the action updates completed with no Node.js 20 deprecation warnings. No live Cloudflare testing was performed.

## Download

Download the file for your operating system from the [v0.8.4 GitHub Release](https://github.com/simosako/castloop-v2/releases/tag/v0.8.4).
