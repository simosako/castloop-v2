# Issue #10 — Single-job publication timing evidence

Branch: `test-evidence/rss-local-timing-20261012`.
Base: `a19efb4cfc95507787fa54c335c67b5722de414b`.
Related: https://github.com/simosako/castloop-v2/issues/10

**Outcome: one unchanged metadata-only publication completed. The consumer took 96.727 seconds,
with 484 R2 binding operations (419 GET / 45 HEAD / 17 PUT / 3 LIST). Queue wait was about 0.940 seconds.**
This sample did NOT exceed 120 seconds. It measures a metadata-only update with 36 existing Episodes,
not an initial audio publication or a benchmark of a performance fix.

## Index

- [Detailed findings and measurement limits](evidence/result.md)
- [Timing analysis / all HTTP and Worker scopes](evidence/timing-analysis.json)
- [Non-overlapping phase breakdown / repeated-record GET counts](evidence/detailed-breakdown.json)
- [Original-publication preservation checks](evidence/preservation.json)
- [Standard Worker restored / final state](evidence/final-state.json)
- [Instrumented binary identity](evidence/build-identity.json)
- [Automated test counts: 967 pass / 0 fail](evidence/bun-test.stderr-summary.txt)
- [Activity log](logs/test-20261012.log)
- [Measurement plan](logs/test-plan-rss-local-timing.md)
- CLI/R2 timing traces: `evidence/measured-*.timing.jsonl`.
- Queue traces: `evidence/queue-*.json` (setup probe and measured publication).
- Diagnostic execution/analysis helpers: `diagnostics/` (local path placeholders, not directly run-ready).

## Instrumentation source

The repository source in this branch contains the EXACT ten source/test files used for measurement,
including the three new modules/tests. Compare this branch to the base commit above to review the patch.
Files: `src/local-timing.ts`, `src/local-timing.test.ts`, `src/worker.ts`,
`src/publication-episode-runner.ts`, `src/publication-consumer.ts`, `src/service-admission.ts`,
`src/lifecycle-worker-effects.ts`, `packages/cli/src/local-timing.ts`,
`packages/cli/src/index.ts`, `packages/cli/src/staging-rest.ts`.

**Temporary diagnostic instrumentation, NOT a production change or performance fix.**
The Worker sends timing details on explicitly requested authenticated admin responses; Queue timing
reports are written to private `system/diagnostics/local-timing/` after the measured work via waitUntil.
The CLI enables HTTP timing only when `CASTLOOP_LOCAL_TIMING_FILE` is set.
Do not deploy this branch to production. The acceptance environment has ALREADY been returned to
the standard, non-instrumented a19efb4 Worker using formal pause/deploy/verify/resume.

The administrator initially requested local-only code. AFTER measurement, they explicitly authorized
committing and pushing the measurement code and evidence. Statements saying local-only/not pushed
in historical results, logs and final-state snapshots describe the situation BEFORE this publication;
they are not the current publication status. Original measurement sources/worktrees were not reset.

## Boundaries

Source changes retain existing ownership, generation, CAS and replay checks. No performance optimization
was made. One history revision was added; Feed bytes, audio URLs, local TOML, original import input and
completed cursor were unchanged. The earlier helper argument error stopped before remote staging/publication;
the failed evidence is preserved, and corrected execution followed explicit administrator approval.

No private backups, credential/configuration TOML, raw metadata/Feed XML, Podcast materials, binary,
or raw Issue history is included. Credentials, account/zone/execution identifiers, personal metadata,
email addresses and local absolute paths are redacted from evidence. Trace/job IDs remain for correlation;
they are diagnostic identifiers, not credentials. Timing values and event order are retained.
Source snapshots have been checked byte-for-byte against the measured sources; measurement helpers
have local-path replacements and require adaptation. manifest.json hashes every other changed file,
including instrumentation source; it does not hash itself or the unchanged baseline repository files.

Worker clocks advance on I/O; these are wall/I/O checkpoints, not CPU profiling or pure R2 server latency.
Nested scope totals and per-operation overlapping durations must not be double-added. Cross-invocation
timestamp deltas include clock-skew uncertainty. No audio transfer/copy or location/root-cause test was done.
This snapshot precedes push/Issue-comment completion; later local publication-completion entries are not included.
No PR, live environment operation or Issue closure is performed by this publication.
