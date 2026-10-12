import datetime
import hashlib
import json
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'evidence/rss-performance-a8c7e54'
REPO = ROOT / 'publish/castloop-v2-worker-update-upload-only'
PREFIX = 'design/acceptance/worker-update/20261012-upload-only-timeout'
DEST = REPO / PREFIX
assert not DEST.exists(), 'Never overwrite an exported snapshot'
replacements = {}
secrets = set()


def key_name(key):
    return re.sub('[^a-z0-9]', '', key.lower())


def sensitive(key):
    return any(word in key_name(key) for word in ['token', 'secret', 'password', 'adminkey', 'authorization'])


def collect(value, private=False):
    if isinstance(value, str) and private and len(value) >= 12:
        secrets.add(value)
        replacements[value] = '[REDACTED_SECRET]'
    elif isinstance(value, dict):
        secret_binding = value.get('type') == 'secret_text' or sensitive(str(value.get('name', '')))
        for key, item in value.items():
            if key_name(key) in ['accountid', 'zoneid', 'executionid', 'certid', 'domainid', 'nextcursor'] and isinstance(item, str):
                replacements[item] = '[REDACTED_RESOURCE_OR_EXECUTION_ID]'
            collect(item, private or sensitive(key) or secret_binding and key_name(key) in ['text', 'value'])
    elif isinstance(value, list):
        for item in value:
            collect(item, private)


for name in ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']:
    if os.environ.get(name):
        secrets.add(os.environ[name])
        replacements[os.environ[name]] = '[REDACTED_CREDENTIAL_OR_ACCOUNT]'
for path in SOURCE.rglob('*'):
    if path.is_file() and path.suffix in ['.json', '.stdout']:
        text = path.read_text()
        if text.strip().startswith(('{', '[')):
            collect(json.loads(text), path.name == 'secrets.json')


def clean_text(text):
    for value, marker in sorted(replacements.items(), key=lambda row: len(row[0]), reverse=True):
        text = text.replace(value, marker)
    text = text.replace(str(ROOT), '[LOCAL_TEST_ROOT]')
    text = re.sub(r'[REDACTED_LOCAL_PATH]"\'<>]+', '[REDACTED_LOCAL_PATH]', text)
    text = re.sub(r'[REDACTED_FIXTURE_PATH]"\'<>]+', '[REDACTED_FIXTURE_PATH]', text)
    text = re.sub(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[REDACTED_EMAIL]', text)
    return re.sub(r'(https?://[^\s"\'<>?]+)\?[^\s"\'<>]+', r'\1?[REDACTED_QUERY]', text)


def clean_json(value):
    if isinstance(value, dict):
        output = {}
        secret_binding = value.get('type') == 'secret_text' or sensitive(str(value.get('name', '')))
        for key, item in value.items():
            normalized = key_name(key)
            if sensitive(key) or normalized == 'executionid' or secret_binding and normalized in ['text', 'value']:
                output[key] = '[REDACTED]'
            elif normalized in ['accountid', 'zoneid', 'certid', 'domainid', 'nextcursor'] and item is not None:
                output[key] = '[REDACTED_RESOURCE_OR_CURSOR]'
            elif normalized in ['title', 'description', 'author', 'ownername', 'owneremail', 'email']:
                output[key] = '[OMITTED_METADATA]'
            else:
                output[clean_text(key)] = clean_json(item)
        return output
    if isinstance(value, list):
        return [clean_json(item) for item in value]
    return clean_text(value) if isinstance(value, str) else value


manifest = []


def save(source, relative, text, treatment):
    text = '\n'.join(line.rstrip() for line in text.splitlines()).rstrip() + '\n' if text else ''
    path = REPO / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    manifest.append({'repository_path': relative, 'local_source': str(source.relative_to(ROOT)),
        'treatment': treatment, 'published_sha256': hashlib.sha256(text.encode()).hexdigest()})


def export(path, relative, treatment='sanitized diagnostic evidence; private originals retained'):
    text = path.read_text()
    if path.suffix == '.json' or path.suffix == '.stdout' and text.strip().startswith(('{', '[')):
        text = json.dumps(clean_json(json.loads(text)), ensure_ascii=False, indent=2)
    else:
        text = clean_text(text)
    save(path, relative, text, treatment)


log = ROOT / 'test-20261012.log'
log.write_text(datetime.datetime.now(datetime.timezone.utc).isoformat() + ' Worker更新upload-only停止のGitHub報告準備\n'
    'ユーザーが新Issue作成と調査記録共有を承認。base a8c7e54の専用branch '
    'test-evidence/worker-update-upload-only-20261012へ停止証跡/診断code/模擬試験/活動log/計画を秘密除去して保存しpush。'
    '30秒GET timeout後にupload receiptだけ残りupdatingから復帰できない課題を#10と別Issueで報告。'
    '製品source追加変更、deploy/activate/resume/強制解除、その他live操作なし。\n\n' + log.read_text())

for path in sorted(SOURCE.iterdir()):
    if not path.is_file() or 'private' in path.name or path.name.startswith(('issue10-', 'publication-')):
        continue
    relative = PREFIX + '/evidence/' + path.name
    if path.name.startswith('bun-test') and path.suffix in ['.stderr', '.stdout']:
        if path.suffix == '.stderr':
            lines = [line.strip() for line in path.read_text().splitlines()
                if re.match(r'\s*\d+ (pass|fail|expect\(\) calls)', line) or line.startswith('Ran ')]
            save(path, relative + '-summary.txt', '\n'.join(lines), 'aggregate product test counts only')
        continue
    export(path, relative)

investigation = SOURCE / 'update-investigation'
for path in sorted(investigation.iterdir()):
    if not path.is_file() or 'private' in path.name:
        continue
    export(path, PREFIX + '/investigation/' + path.name)

# The upload-only journal is essential to this issue; publish a redacted copy,
# not the private directory or a restorable recovery record.
for path in sorted((SOURCE / 'stopped-private-update-journals').glob('*.json')):
    export(path, PREFIX + '/journals/' + path.name,
        'redacted upload-only journal for analysis; NOT usable for restoration or recovery')

for directory, relative in [(SOURCE / 'harness-source', 'evidence/harness-source'),
        (investigation / 'harness-source', 'investigation/harness-source')]:
    for path in sorted(directory.iterdir()):
        assert path.is_file() and path.suffix in ['.py', '.ts', '.md']
        export(path, PREFIX + '/' + relative + '/' + path.name, 'historical diagnostic helper snapshot with local path placeholders')

for name in ['test-20261012.log', 'test-plan-rss-performance-a8c7e54.md']:
    export(ROOT / name, PREFIX + '/logs/' + name, 'sanitized activity/plan snapshot')
for name in ['rss-performance-a8c7e54.py', 'rss-performance-tail.ts', 'rss_performance_wait.py',
        'test_rss_performance_wait.py', 'dns-direct.py', 'rss-a8c7e54-update-investigate.ts',
        'rss-a8c7e54-update-recovery.test.ts']:
    export(ROOT / 'diagnostics' / name, PREFIX + '/diagnostics/' + name,
        'local diagnostic/helper source only; adapt placeholders/import locations before use')
export(ROOT / 'prepare-public-evidence-worker-update-upload-only.py', PREFIX + '/diagnostics/publication-sanitizer.py',
    'sanitization/export source, not product code; uses local path placeholders')

readme = '''# Worker update: uploaded version, settings GET timeout, no supported resume

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
The mock test uses dedicated `[REDACTED_FIXTURE_PATH] fixtures, preserved locally, not the live workspace.

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
'''
save(ROOT / 'prepare-public-evidence-worker-update-upload-only.py', PREFIX + '/README.md', readme,
    'publication index with safety/snapshot qualifications')
(DEST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

for entry in manifest:
    path = REPO / entry['repository_path']
    text = path.read_text()
    assert not any(value in text for value in secrets), 'Credential scan failed'
    assert ('/' + 'home' + '/') not in text and ('/' + 'tmp/opencode/' + 'castloop-') not in text, 'Absolute local path scan failed'
    assert not re.search(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', text), 'Email scan failed'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['published_sha256']
    if path.suffix == '.json':
        json.loads(text)
assert {str(path.relative_to(REPO)) for path in DEST.rglob('*') if path.is_file()} == {
    entry['repository_path'] for entry in manifest} | {PREFIX + '/manifest.json'}
print('Prepared and validated', len(manifest) + 1, 'sanitized evidence files; product source unchanged')
