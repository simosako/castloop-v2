# Fresh-r2 Show publication canceled: residual execution blocks retries

Branch: `test-evidence/show-publication-canceled-20261012`.
Base/product source: `a8c7e54e8c326ef238a2fcd9d672a27b002bec66` (unchanged).
Related: [performance issue #10](https://github.com/simosako/castloop-v2/issues/10),
[separate Worker-update recovery issue #11](https://github.com/simosako/castloop-v2/issues/11).
The dedicated Show-publication issue links to this evidence commit. No product patch, PR or recovery operation.

## Latest confirmed result

Unmodified CLI/Worker, fresh service `rssperf-1012-r2`, hostname `castloop-rss-perf-r2.otftalk.com`.
Fresh init, domain verification and explicit resume succeeded. The first Show publication job
`69a619df-9115-42e8-87db-e98947635863` did not finish. The CLI stopped at its 300-second RSS wait limit
(whole command 354.900 seconds including preparation/staging/commit).

Dashboard logs now conclusively correlate the three attempts using the same requestId as each
target job publication_delivery:

| Attempt | Finished UTC | Queue outcome | Wall / CPU |
| --- | --- | --- | --- |
| 1 | 11:35:03.794 | canceled | 34,982 / 146 ms |
| 2 | 11:35:23.845 | exception | 3,781 / 9 ms |
| 3 | 11:35:28.342 | exception | 4,026 / 9 ms |

Both retry exceptions are `Another invocation still owns this lifecycle execution`.
Retry invocation-release timings succeed; the initial consumer/release terminal timings are absent.
R2 snapshots show processing/validating, progress feed (11:34:57 UTC), draft Show, execution token present,
service open with one residual invocation, and no published Show metadata/cover/feed/catalog.
The job's DLQ marker exactly matches its Show commit. State was unchanged at the 11:59 UTC snapshot.
The DLQ invocation finishes ok at 11:35:34.769, but that invocation record itself has no job ID.

**Why the first invocation was canceled is NOT established.** Detailed span analysis has not yet been
performed. Do not attribute it to DNS, API permissions, CPU limits, R2 faults, a Cloudflare defect or
the new catalog optimization based only on this snapshot.
36 Episode publication, 1.5GB MP3 upload and the planned performance comparison have NOT started.

## Index

- [Current findings and chronological updates](investigation/findings.md)
- [Fresh-environment test result](evidence/result.md)
- [Targeted Dashboard-log analysis and attempt correlation](investigation/dashboard-targeted-review/result.md)
- [Machine-readable attempt timings and exception confirmation](investigation/dashboard-targeted-review/summary.json)
- [Allowlisted Queue records](investigation/dashboard-targeted-review/target-job-queue-events.json)
- [Earlier export did not include the failure window](investigation/dashboard-log-review/result.md)
- [Both sanitized Dashboard exports and provenance](dashboard-logs/export-validation.json)
- [Targeted full export, 1,757 records including spans](dashboard-logs/logs-2026-10-12T12_14_27.128Z-sanitized.json)
- [Earlier full export, 2,000 records](dashboard-logs/logs-2026-10-12T12_06_15.809Z-sanitized.json)
- [R2/CLI stopped-state snapshot](investigation/snapshot-summary.json)
- [Matching DLQ marker check](investigation/dlq-summary.json)
- [Redacted Show control](investigation/show-control-sanitized.json)
- [Redacted service admission](investigation/service-admission-sanitized.json)
- [Final preservation/validation](investigation/final-validation.json)
- [Corrected GraphQL status classification](investigation/graphql-corrected-summary.json)
- [Offline a8c7e54, three cases](investigation/offline-a8c7e54/summary.json)
- [Offline 4781fad, three cases](investigation/offline-4781fad/summary.json)
- [Offline diagnostic source](diagnostics/rss-fresh-r2-show-offline.ts)
- [Activity log](logs/test-20261012.log)
- [Test plan](logs/test-plan-rss-performance-a8c7e54-fresh-r2.md)

## Interpretation and limitations

The six fully offline cases use the existing product Queue routes/fixtures with fetch forbidden.
A single injected R2 failure permits cleanup and successful same-job retry; persistent injected
failures also prevent catch/finally cleanup and reproduce residual tokens and blocked retries.
This is a MECHANISM simulation, not proof of the original live cancellation reason. Both commits
show the same behavior. Core Show runner/consumer/service cleanup/routing files are unchanged
between 4781fad and a8c7e54. Mock request counts are not production performance measurements.

Historical GraphQL summaries initially misclassified success as non-ok and one summary annotated
raw wallTime with an unverified unit. Original summaries are retained; corrected/withdrawn notes
are explicit in findings and final-validation. Dashboard wallTimeMs/cpuTimeMs above are explicit
fields, not those unverified raw-unit conversions. Read-only historical telemetry query returned
403/code10000 once; it is an inspection limitation, not proof of missing publication permissions.

`publication.status / success` means successful STATUS QUERY, not published job status.
Earlier 'logs unavailable', 'not pushed', 'github_published=false' statements describe that stage
of the investigation. Read the later targeted-export result for the latest known facts.

## Publication/privacy policy

Both Dashboard exports retain every record, original order, timestamps, request/trace/span linkage,
outcomes, durations, R2 operation/key/size/status and exception stack context, with sensitive fields
redacted. Account/zone/execution tokens, credentials, headers/cookies, network/IP/user-agent context,
request bodies other than size-only descriptors, custom metadata, personal names/emails, URL query
strings and absolute local paths are removed. Redacted exports are diagnostic views, not byte-exact
originals; provenance contains original hashes and record counts. Raw files remain local.

Private workspace backup/journals, podcast media, configuration/metadata TOMLs, binary, private
domain readiness body and raw GitHub responses are excluded. Essential small R2 control/status
records are included only as redacted copies; NEVER restore them to R2 or use them to unlock.
The initial/final snapshots are observations, not guarantees of current invocation liveness.

Only the acceptance directory is added. Product source is unchanged from the base. Diagnostic
source files contain sanitized local-path placeholders and must be adapted for an isolated local
checkout. They are not production patches or recovery tools. manifest.json covers hashes for
every other added file, not itself or unchanged base files.

The service, original input, cursor/journals, unfinished owner and old updating environment were
preserved. No retry/requeue/replay, forced unlock, journal reset, deploy, activation, cleanup,
permission/logging/DNS/Queue configuration change or live test was performed during publication.
Publication completion entries and GitHub response files created after export remain local.
