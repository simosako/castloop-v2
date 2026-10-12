import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tomllib

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2'
REPO = ROOT / 'publish/castloop-v2-show-publication-canceled'
PREFIX = 'design/acceptance/rss-performance/20261012-a8c7e54-fresh-r2-show-canceled'
DEST = REPO / PREFIX
BRANCH = 'test-evidence/show-publication-canceled-20261012'
assert not DEST.exists(), 'Never overwrite an exported snapshot'
replacements = {}
secrets = set()
metadata_values = set()
manifest = []


def normalized(key):
    return re.sub('[^a-z0-9]', '', key.lower())


def sensitive(key):
    key = normalized(key)
    return any(word in key for word in ['token', 'secret', 'password', 'adminkey', 'authorization']) or key in [
        'xcastloopkey', 'xauthkey', 'xauthtoken', 'cookie', 'setcookie', 'executionid', 'verificationid']


resource_keys = {'accountid', 'zoneid', 'certid', 'domainid', 'nextcursor'}
metadata_keys = {'title', 'description', 'author', 'ownername', 'owneremail', 'email'}
omitted_keys = {'header', 'headers', 'account', 'network', 'geo', 'server', 'useragent', 'custommetadata'}
technical_values = {'draft', 'active', 'owner', 'token', 'retry', 'finished', 'published', 'processing',
    'validating', 'feed', 'purge', 'visibility', 'open', 'held', 'waiting', 'paused', 'released', 'deleted',
    'updating', 'reserved', 'staged', 'true', 'false', 'admitted', 'success', 'error', 'Error'}


def schema_field(value):
    return isinstance(value, dict) and 'name' in value and isinstance(value.get('type'), dict) and 'kind' in value['type']


def collect(value, private=False):
    if isinstance(value, str) and private and len(value) >= 8:
        if value not in ['REDACTED', 'redacted', '[REDACTED]', '[REDACTED_SECRET]']:
            secrets.add(value)
            replacements[value] = '[REDACTED_SECRET]'
    elif isinstance(value, dict):
        secret_binding = value.get('type') == 'secret_text' or sensitive(str(value.get('name', '')))
        for key, item in value.items():
            norm = normalized(key)
            if norm in resource_keys and isinstance(item, str):
                replacements[item] = '[REDACTED_RESOURCE_ID]'
            if norm in metadata_keys and not schema_field(value) and isinstance(item, str) and len(item) >= 4 and item not in technical_values:
                metadata_values.add(item)
                replacements[item] = '[OMITTED_PERSONAL_METADATA]'
            if norm == 'account':
                if isinstance(item, str):
                    replacements[item] = '[REDACTED_ACCOUNT]'
                elif isinstance(item, dict) and isinstance(item.get('id'), str):
                    replacements[item['id']] = '[REDACTED_ACCOUNT_ID]'
            collect(item, private or sensitive(key) or secret_binding and norm in ['text', 'value'])
    elif isinstance(value, list):
        for item in value:
            collect(item, private)


for name in ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CASTLOOP_ADMIN_KEY']:
    if os.environ.get(name):
        secrets.add(os.environ[name])
        replacements[os.environ[name]] = '[REDACTED_CREDENTIAL_OR_ACCOUNT]'
for directory in [SOURCE, ROOT / 'evidence/rss-performance-a8c7e54', ROOT / 'workspaces']:
    for path in directory.rglob('*'):
        if not path.is_file() or path.suffix not in ['.json', '.stdout', '.toml']:
            continue
        text = path.read_text()
        if path.suffix == '.toml':
            try:
                collect(tomllib.loads(text))
            except tomllib.TOMLDecodeError:
                pass
        elif text.lstrip().startswith(('{', '[')):
            try:
                collect(json.loads(text), path.name in ['secrets.json', 'service-secrets.json'])
            except json.JSONDecodeError:
                pass
dashboard_inputs = [ROOT / 'logs-2026-10-12T12_06_15.809Z.json', ROOT / 'logs-2026-10-12T12_14_27.128Z.json']
for path in dashboard_inputs:
    collect(json.loads(path.read_text()))


def clean_text(text):
    for value, marker in sorted(replacements.items(), key=lambda pair: len(pair[0]), reverse=True):
        text = text.replace(value, marker)
    text = text.replace(str(ROOT), '[LOCAL_TEST_ROOT]')
    for prefix, marker in [('/' + 'home' + '/', '[REDACTED_LOCAL_PATH]'),
            ('/' + 'tmp/opencode' + '/', '[REDACTED_FIXTURE_PATH]')]:
        text = re.sub(re.escape(prefix) + r'[^\s"\'<>]+', marker, text)
    text = re.sub(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[REDACTED_EMAIL]', text)
    return re.sub(r'(https?://[^\s"\'<>?]+)\?[^\s"\'<>]+', r'\1?[REDACTED_QUERY]', text)


def clean_json(value):
    if isinstance(value, dict):
        output = {}
        secret_binding = value.get('type') == 'secret_text' or sensitive(str(value.get('name', '')))
        for key, item in value.items():
            norm = normalized(key)
            if norm in omitted_keys:
                output[key] = '[OMITTED_PRIVATE_CONTEXT]'
            elif norm == 'body':
                output[key] = {'size': item['size']} if isinstance(item, dict) and set(item) == {'size'} else '[OMITTED_BODY]'
            elif sensitive(key) and not isinstance(item, (bool, int, float)) or secret_binding and norm in ['text', 'value']:
                output[key] = '[REDACTED_SECRET_OR_EXECUTION_TOKEN]'
            elif norm in resource_keys and item is not None:
                output[key] = '[REDACTED_RESOURCE_ID]'
            elif norm in metadata_keys and not schema_field(value):
                output[key] = '[OMITTED_PERSONAL_METADATA]'
            elif norm in ['query', 'querystring']:
                output[key] = '[OMITTED_QUERY]'
            else:
                output[clean_text(key)] = clean_json(item)
        return output
    if isinstance(value, list):
        return [clean_json(item) for item in value]
    return clean_text(value) if isinstance(value, str) else value


def save(source, relative, text, treatment):
    text = '\n'.join(line.rstrip() for line in text.splitlines()).rstrip() + '\n' if text else ''
    destination = REPO / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    assert not destination.exists(), 'Never replace an existing export'
    destination.write_text(text)
    manifest.append({'repository_path': relative, 'local_source': str(source.relative_to(ROOT)),
        'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'treatment': treatment, 'published_sha256': hashlib.sha256(text.encode()).hexdigest()})


def export(path, relative, treatment='sanitized diagnostic evidence; private originals retained'):
    text = path.read_text()
    if path.suffix == '.json' or path.suffix == '.stdout' and text.lstrip().startswith(('{', '[')):
        try:
            text = json.dumps(clean_json(json.loads(text)), ensure_ascii=False, indent=2)
        except json.JSONDecodeError:
            text = clean_text(text)
    else:
        text = clean_text(text)
    save(path, relative, text, treatment)


def rewrite_markdown_links(entries):
    destinations = {(ROOT / entry['local_source']).resolve(): REPO / entry['repository_path'] for entry in entries}
    for entry in entries:
        source = ROOT / entry['local_source']
        if source.suffix != '.md':
            continue
        destination = REPO / entry['repository_path']
        def rewrite(match):
            link = match.group(2)
            if link.startswith(('http://', 'https://', '#')):
                return match.group(0)
            path, separator, anchor = link.partition('#')
            target = destinations.get((source.parent / path).resolve())
            if target is None:
                return match.group(0)
            updated = os.path.relpath(target, destination.parent) + (separator + anchor if separator else '')
            return match.group(1) + updated + match.group(3)
        text = re.sub(r'(\]\()([^)]+)(\))', rewrite, destination.read_text())
        destination.write_text(text)
        entry['published_sha256'] = hashlib.sha256(destination.read_bytes()).hexdigest()


log = ROOT / 'test-20261012.log'
log.write_text(datetime.datetime.now(datetime.timezone.utc).isoformat() + ' Show公開canceled残留問題のGitHub共有準備\n'
    'ユーザーが解析結果/ログのbranch pushとIssue共有を承認。#11は旧workspaceのWorker upload-only更新復帰問題、今回の新規r2 Show consumer canceled/残留tokenによるretry拒否は別Issueとし#11と相互参照する。base a8c7e54のbranch '
    + BRANCH + ' に新規環境準備/停止/読み取り調査/2commit模擬6case/2つのDashboard exportの秘密除去版/解析helper/活動log/計画/manifestを保存。初回取消理由は未確定、span追加解析未実施、性能比較未開始。製品変更/Cloudflare操作/再送/強制解除/PR/merge/closeなし。\n\n' + log.read_text())

for path in sorted(SOURCE.iterdir()):
    if path.is_file() and 'private' not in path.name:
        export(path, PREFIX + '/evidence/' + path.name)
for directory, relative in [(SOURCE / 'harness-source', 'evidence/harness-source'),
        (SOURCE / 'show-investigation', 'investigation')]:
    for path in sorted(directory.rglob('*')):
        if not path.is_file() or any(part in ['__pycache__'] for part in path.parts):
            continue
        if path.name in ['graphql-schema-types-private.json', 'graphql-schema-fields-3-private.json', 'graphql-schema-fields-9-private.json']:
            continue
        inner = str(path.relative_to(directory))
        if 'private' in path.name and not path.name.endswith('.missing.json'):
            if path.suffix not in ['.json', '.toml']:
                continue
            inner = inner.replace('-private.', '-sanitized.')
            treatment = 'redacted diagnostic snapshot; NOT a restorable owner/control record'
        else:
            treatment = 'sanitized historical diagnostic/helper snapshot'
        export(path, PREFIX + '/' + relative + '/' + inner, treatment)
for name in ['test-20261012.log', 'test-plan-rss-performance-a8c7e54-fresh-r2.md']:
    export(ROOT / name, PREFIX + '/logs/' + name, 'sanitized activity/plan snapshot')
helper_names = ['rss-performance-fresh-r2.py', 'rss-performance-fresh-r2-analyze.py', 'rss-performance-a8c7e54.py',
    'rss-performance-tail.ts', 'rss_performance_wait.py', 'test_rss_performance_wait.py',
    'rss-retest-public-checks.py', 'dns-direct.py', 'dns-tunnel.py']
helper_paths = [ROOT / 'diagnostics' / name for name in helper_names]
helper_paths += sorted((ROOT / 'diagnostics').glob('rss-fresh-r2-show-*.py'))
helper_paths += [ROOT / 'diagnostics/rss-fresh-r2-show-offline.ts',
    ROOT / 'diagnostics/rss-fresh-r2-dashboard-log-review.py',
    ROOT / 'diagnostics/rss-fresh-r2-dashboard-targeted-review.py']
for path in helper_paths:
    export(path, PREFIX + '/diagnostics/' + path.name, 'local diagnostic source; adapt sanitized paths/imports before use')
dashboard_summary = []
for path in dashboard_inputs:
    data = json.loads(path.read_text())
    cleaned = clean_json(data)
    relative = PREFIX + '/dashboard-logs/' + path.stem + '-sanitized.json'
    save(path, relative, json.dumps(cleaned, ensure_ascii=False, indent=2),
        'all original records retained in original order; credentials/account/headers/network/body/metadata redacted; traces preserved')
    assert len(cleaned) == len(data)
    for before, after in zip(data, cleaned):
        assert before['timestamp'] == after['timestamp']
        for key in ['requestId', 'traceId', 'spanId', 'parentSpanId']:
            if key in before.get('$metadata', {}):
                assert before['$metadata'][key] == after['$metadata'][key]
        for key in ['eventType', 'outcome', 'wallTimeMs', 'cpuTimeMs']:
            if key in before.get('$workers', {}):
                assert before['$workers'][key] == after['$workers'][key]
        for key in ['traceId', 'spanId', 'parentSpanId', 'name', 'startTime', 'endTime', 'durationMS']:
            if key in before.get('source', {}):
                assert before['source'][key] == after['source'][key]
    dashboard_summary.append({'source_file': path.name, 'source_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'record_count': len(data), 'timestamp_min': min(row['timestamp'] for row in data),
        'timestamp_max': max(row['timestamp'] for row in data), 'published_path': relative,
        'record_order_and_trace_identity_preserved': True})
save(Path(__file__), PREFIX + '/dashboard-logs/export-validation.json', json.dumps(dashboard_summary, indent=2),
    'dashboard export provenance, hashes, record count and trace-preservation checks')
export(Path(__file__), PREFIX + '/diagnostics/publication-sanitizer.py', 'sanitization/export source, not product code')

readme = '''# Fresh-r2 Show publication canceled: residual execution blocks retries

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
'''
save(Path(__file__), PREFIX + '/README.md', readme, 'current index, privacy and interpretation boundaries')
rewrite_markdown_links(manifest)
(DEST / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

for entry in manifest:
    path = REPO / entry['repository_path']
    text = path.read_text()
    assert not any(value in text for value in secrets), 'Credential/token scan failed'
    assert not any(value in text for value in metadata_values), 'Personal metadata scan failed'
    assert ('/' + 'home' + '/') not in text and ('/' + 'tmp/opencode' + '/') not in text, 'Absolute local path scan failed'
    assert not re.search(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', text), 'Email scan failed'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['published_sha256']
    if path.suffix == '.json':
        json.loads(text)
assert {str(path.relative_to(REPO)) for path in DEST.rglob('*') if path.is_file()} == {
    entry['repository_path'] for entry in manifest} | {PREFIX + '/manifest.json'}
for path in dashboard_inputs:
    before = next(row for row in dashboard_summary if row['source_file'] == path.name)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before['source_sha256']
print('Prepared', len(manifest) + 1, 'sanitized evidence files; original Dashboard exports and product source unchanged')
