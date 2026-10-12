import ast
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tomllib

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2/show-investigation'
os.umask(0o077)
assert not (E / 'final-validation.json').exists(), 'Preserve earlier validation'
spec = importlib.util.spec_from_file_location('inspection', ROOT / 'diagnostics/rss-fresh-r2-show-investigate.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
original = h.E
h.E = E / 'final-r2-snapshot'
h.E.mkdir(exist_ok=False)
h.h.m.E = h.E
for name, key in [
        ('status-private.toml', f'system/jobs/{h.JOB}/status.toml'),
        ('progress-private.toml', f'system/jobs/{h.JOB}/progress.toml'),
        ('show-control-private.json', 'system/show-publications/otftalk-rss.json'),
        ('service-admission-private.json', 'system/lifecycle-service.json')]:
    h.get_r2(name, key)
control = json.loads((h.E / 'show-control-private.json').read_text())
service = json.loads((h.E / 'service-admission-private.json').read_text())
status = tomllib.loads((h.E / 'status-private.toml').read_text())
progress = tomllib.loads((h.E / 'progress-private.toml').read_text())
server = {'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'status_state': status['state'], 'status_phase': status['phase'],
    'progress_phase': progress['phase'], 'progress_updated_at': progress['updated_at'],
    'show_lifecycle': control['lifecycle'], 'execution_present': bool(control.get('owner', {}).get('execution_id')),
    'service_state': service['state'], 'service_invocations': len(service['invocations']),
    'durable_objects_unchanged_from_first_snapshot': all(
        (h.E / name).read_bytes() == (original / name).read_bytes() for name in [
            'status-private.toml', 'progress-private.toml', 'show-control-private.json', 'service-admission-private.json'])}
assert server['status_state'] == 'processing' and server['status_phase'] == 'validating'
assert server['progress_phase'] == 'feed' and server['execution_present'] and server['service_invocations'] == 1
(h.E / 'summary.json').write_text(json.dumps(server, indent=2) + '\n')
assert server['durable_objects_unchanged_from_first_snapshot'], 'Investigate durable state changes; never overwrite'
baseline = json.loads((E.parent / 'input-before.json').read_text())
inputs = h.h.inputs()
assert inputs == baseline
before_journals = E.parent / 'stopped-private-journals'
after_journals = h.h.W / '.castloop'
digest = lambda value: hashlib.sha256(value.read_bytes()).hexdigest()
before = {str(path.relative_to(before_journals)): digest(path) for path in before_journals.rglob('*') if path.is_file()}
after = {str(path.relative_to(after_journals)): digest(path) for path in after_journals.rglob('*') if path.is_file()}
assert before == after, 'Local journals changed; preserve evidence'
source = ROOT / 'build/castloop-v2-rss-a8c7e54'
git = lambda *arguments: subprocess.check_output(['git', *arguments], cwd=source, text=True).strip()
assert git('rev-parse', 'HEAD') == 'a8c7e54e8c326ef238a2fcd9d672a27b002bec66'
assert not git('status', '--porcelain=v1')
paths = ['src/publication-show-runner.ts', 'src/publication-consumer.ts', 'src/lifecycle-consumer.ts',
    'src/service-admission.ts', 'src/m6-routes.ts', 'src/lifecycle-worker-effects.ts']
assert not git('diff', '4781fad', 'a8c7e54', '--', *paths)
cases = []
for label in ['a8c7e54', '4781fad']:
    value = json.loads((E / ('offline-' + label) / 'summary.json').read_text())
    assert value['network_calls'] == 0 and len(value['cases']) == 3 and all(case['passed'] for case in value['cases'])
    cases.extend(value['cases'])
helpers = sorted((ROOT / 'diagnostics').glob('rss-fresh-r2-show-*.py'))
for path in helpers:
    ast.parse(path.read_text(), filename=str(path))
destination = E / 'diagnostic-source'
destination.mkdir(exist_ok=False)
for path in [*helpers, ROOT / 'diagnostics/rss-fresh-r2-show-offline.ts']:
    shutil.copy2(path, destination / path.name)
value = {'completed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'server': server, 'input_116_files_unchanged': inputs == baseline,
    'local_journals_unchanged': before == after, 'local_journal_file_count': len(after),
    'source_clean': True, 'source_commit': git('rev-parse', 'HEAD'),
    'core_show_and_cleanup_files_unchanged_since_4781fad': paths,
    'offline_passed_cases': len(cases), 'offline_network_calls': 0,
    'wallTime_unit_correction': 'Initial timing summary milliseconds annotation is withdrawn. Schema does not establish its unit; raw values retained, no performance conversion used.',
    'initial_failure_root_cause_confirmed': False,
    'dlq_marker_matches_show_commit': json.loads((E / 'dlq-summary.json').read_text())['matches_commit_key'],
    'live_mutation_replayed': False, 'owner_force_released': False, 'github_published': False}
(E / 'final-validation.json').write_text(json.dumps(value, indent=2) + '\n')
h.h.m.log('新規r2 Show停止調査完了。対象commitと一致するDLQ markerをGET確認、processing/validating＋progress feed＋Show execution token＋service invocation1が調査完了時もbyte不変。公開先未作成、36Episode/MP3 upload/性能比較は未開始。GraphQL既存token200で同Worker例外2＋clientDisconnected1、job/eventkindなく直接原因確定不可。履歴logs dry照会1回403/code10000、権限/設定変更なし。2commit×3完全mock case=6成功/実HTTP0、継続IO失敗時catch/finallyも失敗すると実機残留状態と次consumer busyを再現、単発失敗はretrying/解放後成功。実機IO障害の証明ではなく前4781にも存在する仕組み。空Show R2呼出316→338、停止点まで112→113、catalog構築前。集計helperのsuccess/okとwallTime単位注記の誤りは原本保持して補正/撤回、製品無変更。元116input/local journal hash不変・a8source clean。再送/retry/解除/deploy/旧環境変更/GitHub共有なし。直接原因にはDashboard対象WorkerのUTC11:34〜11:36（JST20:34〜20:36）Queue/exceptionログが必要。詳細evidence/rss-performance-a8c7e54-fresh-r2/show-investigation/findings.md。')
print(json.dumps(value, indent=2))
