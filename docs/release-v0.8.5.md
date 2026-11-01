# castloop v0.8.5

This maintenance release hardens media upload verification and local error handling, corrects agent-facing command descriptions, and simplifies internal validation. Service configuration, storage formats, and delivery behavior are unchanged from v0.8.4.

## Highlights

- Media uploads now verify the SHA-256 of the outgoing request stream against the inspected file hash while sending, so corrupted or truncated transfers fail before publication is committed.
- Corrupted local journal files (including `secrets.json`) now fail with a fixed message instead of echoing file fragments through a JSON parse error, keeping administrator keys out of terminal transcripts and logs.
- `describe deploy --json` no longer advertises `--operation-id`, matching the deploy command's actual option handling, and the `init` help now states the service ID limit (a lowercase slug of at most 20 characters).
- The guides now document that episode MP3 paths resolve relative to the show directory and that absolute paths are not supported (English and Japanese).
- Internal simplification with no behavior change: redundant revalidation of already type-checked service configurations and metadata limit paths was removed, duplicated logic across the Worker and CLI was consolidated, and unused code and duplicated test coverage were removed.

## Requirements and updates

Service configuration and supported internal formats are unchanged from v0.8.4. To get started, follow the [installation guide](https://github.com/simosako/castloop-v2/blob/v0.8.5/docs/installation.md) and the [first publication guide](https://github.com/simosako/castloop-v2/blob/v0.8.5/docs/getting_started.md). The guides are also available in [Japanese](https://github.com/simosako/castloop-v2/blob/v0.8.5/docs/README_ja.md).

To update an existing installation, follow the [CLI update instructions](https://github.com/simosako/castloop-v2/blob/v0.8.5/docs/installation.md#update-the-cli). The bundled Worker keeps the same storage formats; see the [service maintenance guide](https://github.com/simosako/castloop-v2/blob/v0.8.5/docs/maintenance.md) to update the delivery Worker when convenient.

## Verification

GitHub Actions runs type checking and the full local test suite on Linux and builds and smoke-tests the release binaries on Linux x64, macOS arm64, and Windows x64. The pull request CI run for this release completed successfully: 433 local tests, the type check, and three-platform build and smoke checks all passed.

Live verification was performed on 2026-11-01 in a fresh private trial environment protected by Cloudflare Access (a single reviewer-only Allow policy requiring account membership and Cloudflare login, verified before any upload). A new service was initialized (Worker, SQLite Durable Object, private R2 bucket), and a builtin-website show with three large episodes (62.9, 59.6, and 53.7 MB) was published through preview and explicit approval; all four publication jobs succeeded. Stored R2 audio matched the original SHA-256 values with full-content verification. Anonymous requests were denied with redirects to Access in 33 of 33 checks across GET, HEAD, conditional, and Range requests on the listing, feed, cover, episode pages, and audio. Unauthenticated admin health returned 401, and `/system/` and `/staging/` returned 404. The original local samples were unchanged.

## Download

Download the file for your operating system from the [v0.8.5 GitHub Release](https://github.com/simosako/castloop-v2/releases/tag/v0.8.5).
