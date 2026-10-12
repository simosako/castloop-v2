# M7 RSS import live acceptance — 2026-10-12 run1

**Incomplete: sequential publication repeatedly stopped with an unverified operation-status error.** This archive supports the bug report; it is not a successful migration or recovery package.

## Start here

- [Result and retained environment](run1/result.md)
- [Activity log and decisions](logs/test-20261012.log)
- [Test plan](logs/test-plan-rss-run1.md)
- [Build/material preparation](run1/preparation-summary.json) / [960 pass, 0 fail](run1/unit-tests-summary.txt)
- [All 36 local Episode inputs checked](run1/local-import-validation.json)
- [Domain operation completed using 1.1.1.1](run1/domain-added-validation.json)

## Failure sequence

1. First `publish-rss-import` failed after the Show publication receipt: [stderr](run1/publish-import.stderr), [cursor](run1/publication-stopped-cursor.json), [saved state](run1/publication-stopped-current-state.json). Cursor remained `waiting`, step 4, with the known Show job ID. A later read showed `published` while ownership was still `held`.
2. Administrator authorized continuation. The same Show job was explicitly confirmed `published` / `released`, with no unfinished Show operation or service invocation: [confirmation](run1/publication-before-continue-validation.json).
3. Continuing the same import failed again after the first Episode publication receipt: [stderr](run1/publish-import-continued.stderr), [cursor](run1/publication-stop2-cursor.json), [summary](run1/publication-stop2-summary.json), [job status](run1/publication-stop2-job.json). Cursor remained `waiting`, step 8. Saved Episode state was `processing` / `held`; remaining 35 Episodes had not started.

Both failures reported:

```text
Operation status could not be verified; preserve records, locks and ownership without automatic retry or recovery
```

The internal cause is **not established**. No failing raw management-API response or internal exception reason was captured. An inconsistent changing snapshot, transport problem, or schema/identity failure must not be presented as a confirmed cause. No mutation replay, forced owner/lock/token release, fault injection, or old-host change was performed.

## Fixed source and scope

- Branch under test: `feat/m7-rss-import`
- Commit: `5413fba350f3ae340c94d63030eb37e41b5ca116`
- Binary SHA-256: `098565a1c5f0003920042d8b75bb642b3a80fa1bb725a9d0b01cdd8db912b073`
- Source: administrator-owned OTF Talk RSS, 36 items, 1,496,055,589 bytes of MP3 audio. All source GUIDs happened to be UUID-shaped; this is not live evidence for non-UUID GUIDs.
- New dedicated hostname: `castloop-rss-r1.otftalk.com`.
- New service: `rsstest-1012-r1`. Resources and private journals retained; saved final service state was open. Snapshots are observations at their recorded times, not claims about current live state.
- Old hosting, subscriber redirects, Podcast directory registrations, and previous trial resources were not changed. Full public-feed/media equivalence, later lifecycle/regression tests, and final pause are not completed.
- DNS/TLS verification used 1.1.1.1 with preserved hostname, SNI, and certificate checks. The domain-operation CONNECT tunnel did not decrypt TLS or change OS DNS and has been stopped. The RSS downloader's direct node:http/https route is distinct; its final new-feed check was not reached.

## Sanitization and integrity

This is a selected, redacted evidence snapshot. Audio, images, source RSS, editable metadata TOML, secrets.json, API tokens, administrator keys, and execution credentials are excluded. Account/Zone/domain/certificate/execution identifiers, email addresses, URL queries, local absolute paths, and metadata text are omitted or redacted. Operation/job/import IDs and content hashes remain for cross-referencing. Journal exports under `journals/` cannot be used for recovery.

[manifest.json](manifest.json) records each published file's SHA-256 and local source/treatment, excluding the manifest itself. HTTP headers are allowlisted; automated test output is aggregate-only. Private originals remain with the administrator.

The activity log was snapshotted before the final publication commit and new Issue URL existed. Those publication results are subsequently recorded in the local activity log; links in the Issue use a fixed commit.
