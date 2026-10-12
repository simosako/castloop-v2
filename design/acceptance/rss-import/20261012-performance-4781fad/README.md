# Issue #10 — 4781fad performance retest evidence

Branch: `test-evidence/rss-performance-4781fad-20261012`.
Product source/base: `4781fadbbd8a7b5dd1d4957024b165d774e7e2c1` (unmodified CLI and Worker).
Related issue: https://github.com/simosako/castloop-v2/issues/10

## Outcome

One unchanged metadata-only publication with the same 36-Episode Show completed.
The aligned consumer interval improved **96.179s -> 73.978s (23.08%)**;
eight guards **26.949s -> 12.543s (53.46%)**;
progress/status writes **16.831s -> 12.025s (28.55%)**;
CLI receipt-to-published/released observation **96.785s -> 75.635s (21.85%)**.
Total metadata-stage start to CLI completion **139.239s -> 119.520s (14.16%)**.
GUID/feed inventory and staging finish remain approximately unchanged.

The first attempt stopped at a known read conflict because the test helper lacked the formal RSS wait's
specific retry handling. That evidence is retained. With explicit approval, the helper was corrected;
the old acknowledged job was confirmed published/released before one NEW normal metadata-only update.
The repeat encountered one publication_status_changed and retried only that read. No mutation was replayed.
Consumer completion logs were captured before closing the temporary Tail session.

## Index

- [Successful remeasurement findings and limits](evidence/rss-performance-4781fad-remeasure1/result.md)
- [Full phase comparison and timeline](evidence/rss-performance-4781fad-remeasure1/performance-comparison.json)
- [End-to-end boundary and final Worker-version check](evidence/rss-performance-4781fad-remeasure1/measurement-validation.json)
- [Worker Logs, allowlisted event/phase/timing records](evidence/rss-performance-4781fad-remeasure1/worker-logs.jsonl)
- [Feed/input/cursor/runtime/domain preservation](evidence/rss-performance-4781fad-remeasure1/preservation.json)
- [Final local validation](evidence/rss-performance-4781fad-remeasure1/final-validation.json)
- [Initial acknowledged job confirmed completed](evidence/rss-performance-4781fad-remeasure1/previous-job-confirmed.json)
- [Initial stopped attempt and partial findings](evidence/rss-performance-4781fad/result.md)
- [Build identity](evidence/rss-performance-4781fad/build-identity.json)
- [971 passing product tests](evidence/rss-performance-4781fad/bun-test.stderr-summary.txt)
- [Six passing wait-helper tests](evidence/rss-performance-4781fad-remeasure1/harness-tests.stderr)
- [Activity log](logs/test-20261012.log)
- [Test plan and approved repeat](logs/test-plan-rss-performance-4781fad.md)
- Current helpers: `diagnostics/`; exact historical helper versions (with sanitized paths):
  `evidence/rss-performance-4781fad/pre-remeasure-harness/` and
  `evidence/rss-performance-4781fad-remeasure1/harness-source/`.

Baseline: [a19efb4 measured evidence, fixed commit c1ba87c](https://github.com/simosako/castloop-v2/tree/c1ba87c7521e706cbc4243f1eb86e73900fdcaaa/design/acceptance/rss-import/20261012-local-timing).
The previous 96.727s root includes 0.548s of route/readiness prelude excluded by the new consumer phase.
Original trace service-acquire start to release end gives the comparable 96.179s interval.

## Scope and safety

This is an **evidence-only branch**. No product source/instrumentation patch is added on top of 4781fad;
the developer's performance change is already in the base. Helpers contain local-path placeholders
and are diagnostic scripts, not directly run-ready production commands.

Each version has one full measured metadata-only sample, not a controlled concurrent A/B benchmark.
Worker clocks advance on I/O: wall/checkpoint times, not CPU profiles or pure storage processing times.
Nested phases and polling overlap the consumer and must not be added into its duration.
Live logs do not measure R2 operation counts; mock GET counts in developer docs are not live counts.
No audio upload/copy, complete migration rerun, worst-case 120s-timeout acceptance, location causality,
or release-readiness guarantee is claimed. The provisional 300s wait is not a speed improvement.

Feed bytes and metadata contents (except new revision/updated_at), original import inputs/completed cursor,
local TOML/configuration were unchanged. Service open/drained, all Shows idle, domain configuration and
connections consistent. Standard unmodified 4781fad Worker remains installed. DNS-dependent Feed checks
use explicit 1.1.1.1 and curl --resolve with TLS verification, never OS/router DNS changes.
Live log settings and permissions were not changed. Only the newly created Tail sessions were closed.
No old environments, immutable media/history or previous test records were deleted.

## Publication sanitization

Private workspace backups, credential/config TOML, raw Episode metadata/Feed XML, materials, binaries,
and raw GitHub responses are excluded. Credentials, account/zone/execution IDs, email/personal metadata,
absolute local paths and URL queries are redacted. Terminal status/progress TOMLs are published only as
sanitized parsed JSON. Job/Worker-version IDs and timing/event order are retained for correlation.
manifest.json hashes every other added file, not itself or unchanged repository baseline files.

Historical logs/results saying 'not pushed' describe the PRE-publication state, not the current status.
The activity snapshot includes sharing preparation; push/comment completion entries created after export
remain local. This publication performs no live operations, PR creation, issue closure, or product merge.
