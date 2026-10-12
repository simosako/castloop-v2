# Issue #10 a19efb4 retest and extended-timeout acceptance evidence

Base commit: `a19efb4cfc95507787fa54c335c67b5722de414b`.
Branch: `test-evidence/rss-import-retest-a19efb4-timeout300`.
Related: [Issue #10](https://github.com/simosako/castloop-v2/issues/10).

**Outcome: the original import completed all 36 Episodes using a TEST-ONLY 300-second CLI build.**
The unmodified 120-second CLI timed out twice. This is not an all-36 pass of the unmodified CLI.
CLI and Worker were updated to a19efb4; the old step25 command_requested record was reconciled by the
formal CLI after its strict unstarted-update checks, without deleting/restoring journals or manual cursor edits.
The later timeout patch only changed the CLI publication deadline/inspection limit (120 -> 300) and two test expectations.
No Worker redeployment was needed for this CLI-only patch. Original hosting and subscriber routing were unchanged.

## Index

- [Final outcome, scope and limitations](extended-300s/result.md)
- [Unmodified CLI attempts](standard-120s/result.md)
- [Test-only source patch](extended-300s/source-diff-final.stdout)
- [Binary identity](extended-300s/build-identity.json)
- [Publication result](extended-300s/publication-result.json)
- [Completed cursor](extended-300s/cursor-after.json)
- [Independent RSS validation](extended-300s/public-checks-attempt3/rss-metadata-validation.json)
- [Independent delivery validation](extended-300s/public-checks-attempt3/public-validation.json)
- [Activity log](logs/test-20261012.log)
- [300-second test plan](logs/test-plan-rss-retest-timeout300.md)
- [Timing investigation and corrected permission guidance](timing-investigation/findings.md)

965 automated tests passed for the formal a19efb4 build and final test-only build.
The extended build's first unit-test failure was a missed expected wait count; the final patch and rerun are retained.
Independent comparison attempts 1/2 incorrectly compared untrimmed TOML/RSS descriptions; shared metadata schemas
trim whitespace. The checker was corrected, the failed evidence retained, and attempt3 passed.

All 36 RSS items, Show metadata, GUIDs, dates, isPermaLink, descriptions and canonical audio URLs were independently checked.
Cover and TWO representative MP3s passed full GET/hash/size, HEAD and Range checks. Full independent downloads of all
36 MP3s, extra lifecycle/UUID regressions and final pause were not performed. Normal CLI staging readback verification
is not a substitute for independent all-audio verification. New environment was last observed open/drained and retained.
1.1.1.1 was explicitly used for independent DNS resolution, with TLS verification enabled; OS DNS settings were unchanged.

## Publication boundaries

Sanitized historical snapshots, not fresh live inspection or recovery authority.
No source RSS/XML, MP3, artwork, metadata TOML, binary, complete private backup, secrets.json or raw Worker settings/traces.
Completed journals are redacted and cannot be used for recovery. Unit output is replaced by aggregate counts.
Local paths, tokens/admin keys, account/zone/execution/resource IDs, email and descriptive metadata are redacted.
The telemetry query failed HTTP403/code10000; no root cause of the internal latency was established.
manifest.json records hashes of every other published file, not itself.
This snapshot precedes the push/Issue comment; later local publication-completion entries are not included.
No PR or Issue closure is performed by this publication.
