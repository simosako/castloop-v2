# castloop v0.7.3

> 旧版のリリース記録です。現行の操作は[利用ガイド](../../README.md)を参照してください。

Issue #68 adds dedicated custom subdomains for fresh SQLite services. The custom domain is separate from the management origin, and the CLI provides explicit add, list, status, continue, and remove operations.

## Changes

- Feed requests on the custom hostname use a gated 301 redirect; cover and audio requests use gated 307 redirects. The workers.dev origin remains available for management and recovery.
- Domain operations retain acknowledged mutation checkpoints and require explicit continuation. They do not automatically deploy, resume Shows, roll back uncertain external changes, or clean up certificates.
- Internal queue/content schemas advance to 6/7 with independent immutable Feed-generation reservations and matching health identifiers. Shared content/request schema version 1 remains unchanged.
- Existing released services are not migrated or adopted. Development supports only fresh matching SQLite services; do not change config fields to bypass compatibility checks.

## Verification and limitations

- The two-Show native functional trial passed publication, canonical delivery, redirects, updates/restore, domain-preserving deploy, and workers.dev restoration. Both Shows finished paused, ready, and drained. See the [trial record](../../../design/archive/sqlite_custom_domain_two_show_verification_20261024.md).
- Native API response differences are handled with allowlisted diagnostics and durable receipts; earlier uncertain operations were not adopted or replayed.
- This trial does not establish performance, full Cloudflare Free compatibility, or native fault-injection behavior. It does not authorize changes to any other live environment.
- Release and installation do not deploy or modify Cloudflare resources. Only Linux x86-64 CLI binaries are distributed.

Download `castloop-linux-x64`, `SHA256SUMS`, `LICENSE`, and `THIRD_PARTY_NOTICES.md` from the [v0.7.3 release](https://github.com/simosako/castloop-v2/releases/tag/v0.7.3). The optional Skill archive and its checksum are also available there.
