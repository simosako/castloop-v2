# castloop v0.8.7

This release adds a decision cache to public delivery so repeat requests stop before the Show DO, cutting Durable Object requests per delivery. Storage formats and service configuration are unchanged; the reduction takes effect on existing services after updating the bundled delivery Worker.

## Highlights

- Public delivery now serves Show DO gate decisions (publication status, R2 keys, cache attributes) through a new cache-enabled `SqliteCachedDecisions` entrypoint. When the decision and body caches are warm, feed, cover, and site HTML requests reach the Show DO zero times, and audio requests cost one DO request for statistics recording only. Cold requests behave as before. See the [delivery design](https://github.com/simosako/castloop-v2/blob/v0.8.7/design/components/delivery.md).
- Only successful (200) decisions are cached: stopped shows and missing content keep bypassing the decision cache, and publications purge decision caches before body caches so unpublication remains immediate. The 300-second decision TTL is only a backstop for lost purges, not the correctness mechanism.
- The reduction was measured in an approved private live trial on 2026-11-01: repeating the same visit while caches were warm consumed 3 Show DO requests instead of 8 (−62.5%), while cold requests were unchanged; Workers requests are intentionally unchanged. The trial environment was disposed of after the measurement. The record is kept under [design/archive](https://github.com/simosako/castloop-v2/blob/v0.8.7/design/archive/issue118_decision_cache_live_trial_20261101.md).
- Documentation only: the architecture, delivery, Show DO, and testing design documents were aligned with the cached delivery decisions, and a [free-tier delivery scaling study](https://github.com/simosako/castloop-v2/blob/v0.8.7/design/delivery-free-tier-scaling.md) was recorded for issue #118, which remains open for further scaling work.

## Requirements and updates

Service configuration and supported internal formats are unchanged from v0.8.6. To get started, follow the [installation guide](https://github.com/simosako/castloop-v2/blob/v0.8.7/docs/installation.md) and the [first publication guide](https://github.com/simosako/castloop-v2/blob/v0.8.7/docs/getting_started.md). The guides are also available in [Japanese](https://github.com/simosako/castloop-v2/blob/v0.8.7/docs/README_ja.md).

To update an existing installation, follow the [CLI update instructions](https://github.com/simosako/castloop-v2/blob/v0.8.7/docs/installation.md#update-the-cli). The bundled Worker now exposes the decision-cache entrypoint; to get the request reduction on an existing service, update the delivery Worker as described in the [service maintenance guide](https://github.com/simosako/castloop-v2/blob/v0.8.7/docs/maintenance.md). No data migration is involved, and delivery behavior on services that are not yet updated stays as in v0.8.6.

## Verification

GitHub Actions runs type checking and the full local test suite on Linux and builds and smoke-tests the release binaries on Linux x64, macOS arm64, and Windows x64. The pull request CI run for this release completed successfully: the local test suite, the type check, and the three-platform build and smoke checks all passed. New decision-cache tests cover cacheable allowed decisions with body-cache tags versus uncached stops, requests that never reach the decision source or cache, cache restore and malformed-response rejection, canonical entrypoint addressing, and purge tag coverage.

The live trial measurement cited above was performed in a fresh isolated environment protected by Cloudflare Access and disposed of afterwards, on revision `cf839a5`, which contains the decision-cache implementation included in this release. No live Cloudflare testing was performed for this release itself.

## Download

Download the file for your operating system from the [v0.8.7 GitHub Release](https://github.com/simosako/castloop-v2/releases/tag/v0.8.7).
