# Worker update: uploaded version, settings GET timeout, no supported resume

Branch: `test-evidence/worker-update-upload-only-20261012`.
Base/product code: `a8c7e54e8c326ef238a2fcd9d672a27b002bec66`.
Related performance issue: https://github.com/simosako/castloop-v2/issues/10.
The new issue links to this snapshot; no product patch or recovery action is included.

## Outcome

The unmodified CLI passed build/check and 977 tests. During its formal compatible Worker update,
the version upload was acknowledged but a subsequent settings GET timed out. Local journal:
`deploy_requested`, upload receipt present, deployment receipt/target absent. Service remains
`updating`; the old 4781fad deployment was still active at 100% in the read-only observation.
No catalog construction or performance publication job ran. Existing import/cursor/input files
and the update journal were preserved.

The Cloudflare GET timeout is 30 seconds, distinct from the RSS job wait (300 seconds).
The 81.348-second failed deploy duration includes successful earlier work, not just one GET.
During investigation settings GET succeeded in 0.420s and matched the frozen metadata intent;
deployment GET succeeded in 1.093s. Versions-list GET then timed out at 30.002s and inspection stopped.
Latest-two-version order and live uploaded ETag were NOT fully reverified; network root cause is unknown.

The standard CLI cannot resume an upload-only update. Two fully mocked tests show that a failed
post-upload GET and an unknown activation POST both leave the same durable upload-only journal,
so blindly resending activation is unsafe. Existing update code/tests intentionally preserve
such incomplete/unknown writes. Update code is unchanged from 4781fad: this is not attributed
to the new catalog performance change or to the local measurement helper.

## Index

- [Investigation, code references, limitations and proposed next step](investigation/findings.md)
- [Stopped retest result](evidence/result.md)
- [Stopped state summary](evidence/stopped-summary.json)
- [Exact deploy error](evidence/install-deploy.stderr)
- [Deploy command duration](evidence/install-deploy.elapsed.json)
- [Redacted upload-only journal](journals/3ad4f8af-7552-40a2-9525-8bf434a6146e.json)
- [Service status after stopping](evidence/stopped-service-status.stdout)
- [Target inspection rejection](evidence/stopped-target-show.stderr)
- [Read-only observations and limits](investigation/partial-findings.json)
- [Three API read timings, including timeout](investigation/read-timings.json)
- [Mocked GET-failure case](investigation/offline-post-upload-settings-get.json)
- [Mocked activation-response-unknown case](investigation/offline-activation-post-response-unknown.json)
- [Final two passing simulation tests](investigation/offline-recovery-tests-attempt3.stderr)
- [Existing three passing product update tests](evidence/update-recovery-unit-tests.stderr)
- [Product build identity](evidence/build-identity.json)
- [977 passing product tests](evidence/bun-test.stderr-summary.txt)
- [Post-investigation preservation validation](investigation/investigation-validation.json)
- [Activity log](logs/test-20261012.log)
- [Performance test plan, not yet executed](logs/test-plan-rss-performance-a8c7e54.md)
- Diagnostic sources: `diagnostics/`, with measured snapshots under `evidence/harness-source/`
  and `investigation/harness-source/`. Product source is unchanged from the base.

## Interpretation and boundaries

The service-state observation is retained evidence, not a guarantee of present live state.
The investigation sent GETs only and did not upload, activate, complete, resume, unlock, edit journals,
change permissions/logging/DNS/Queue settings, delete resources, or run performance publications.
The mocked tests never delegate to real fetch; their two writes are simulated, not live requests.
Initial mock fixture failures (missing runtime readiness and mismatched Worker origin) are retained
separately, corrected only in the test fixture, and are NOT counted as product failures.

Do not restore redacted journals, infer execution ownership from this snapshot, or deploy this
evidence branch as a recovery tool. Published helper files have sanitized absolute-path placeholders
and source-worktree-relative imports: adapt paths/imports in an isolated local checkout before use.
The mock test uses dedicated `/tmp/opencode/` fixtures, preserved locally, not the live workspace.

## Publication policy

Private workspace backup, raw Worker settings/deployment responses, raw GitHub responses,
credential/config/metadata TOMLs, materials, binary and raw podcast content are excluded.
Credentials/account/zone/execution identifiers, personal metadata/email, URL query strings and
absolute local paths are redacted; operation/version IDs, upload number and script ETag remain
for correlation. The essential update journal is published only as a redacted diagnostic copy.
manifest.json provides SHA-256 for every other added file, not itself or unchanged base source.

Historical statements saying 'not pushed', 'no issue created', or 'GitHub_shared=false' describe the
PRE-publication state. The exported activity log includes publication preparation; completion entries
and the new issue response created after export remain local. There is no PR, merge or issue closure.
