import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys

ROOT = Path('[LOCAL_TEST_ROOT]')
spec = importlib.util.spec_from_file_location('helpers', ROOT / 'diagnostics/rss-retest-a19efb4.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
h.E = ROOT / 'evidence/rss-import-retest-a19efb4-timeout300'
h.CLI = ROOT / 'bin/castloop-linux-x64-a19efb4-timeout300'
h.S = ROOT / 'build/castloop-v2-rss-a19efb4-timeout300'

if sys.argv[1] == 'build300':
    h.E.mkdir(exist_ok=False)
    h.log('管理者が試験専用CLIで待機時間延長を承認。別worktree a19efb4で公開待機のみ120秒/120回→300秒/300回、対応テスト期待値のみ変更。Worker/安全確認/再送拒否/記録は変更しない。製品無改変commitそのものではない試験buildとして区別する。')
    diff = h.run('source-diff', ['git', 'diff', '--', 'packages/cli/src/rss-import-publication.ts', 'packages/cli/src/rss-import-publication.test.ts'], cwd=h.S, parse=False)
    for name, args in [('npm-ci', ['npm', 'ci']), ('check', ['npm', 'run', 'check']), ('bun-test', ['bun', 'test']), ('build', ['bun', 'scripts/build-cli.ts', 'linux-x64'])]:
        h.run(name, args, cwd=h.S, parse=False)
    assert not h.CLI.exists()
    shutil.copy2(h.S / 'dist/castloop-linux-x64', h.CLI)
    h.save('build-identity.json', {'base_commit': 'a19efb4cfc95507787fa54c335c67b5722de414b', 'test_only_patch': True,
        'publication_wait_seconds': 300, 'publication_max_inspections': 300,
        'sha256': hashlib.sha256(h.CLI.read_bytes()).hexdigest(), 'worker_redeployment': False})
elif sys.argv[1] == 'finish-build300':
    h.log('延長build初回自動試験964 pass/1 fail: 合計waits期待値123が残り実際303。上限延長の期待値漏れのみでlive未操作。期待値303へ修正し別証跡名でcheck/全試験/build再実行する。')
    h.run('source-diff-final', ['git', 'diff', '--', 'packages/cli/src/rss-import-publication.ts', 'packages/cli/src/rss-import-publication.test.ts'], cwd=h.S, parse=False)
    for name, args in [('check-final', ['npm', 'run', 'check']), ('bun-test-final', ['bun', 'test']), ('build-final', ['bun', 'scripts/build-cli.ts', 'linux-x64'])]:
        h.run(name, args, cwd=h.S, parse=False)
    assert not h.CLI.exists()
    shutil.copy2(h.S / 'dist/castloop-linux-x64', h.CLI)
    h.save('build-identity.json', {'base_commit': 'a19efb4cfc95507787fa54c335c67b5722de414b', 'test_only_patch': True,
        'publication_wait_seconds': 300, 'publication_max_inspections': 300,
        'sha256': hashlib.sha256(h.CLI.read_bytes()).hexdigest(), 'worker_redeployment': False})
elif sys.argv[1] == 'publish300':
    backup = h.E / 'private-workspace-backup'
    backup.mkdir()
    shutil.copy2(h.W / 'castloop.toml', backup / 'castloop.toml')
    shutil.copytree(h.W / '.castloop', backup / '.castloop')
    before = h.hashes(h.I)
    assert before == json.loads((ROOT / 'evidence/rss-import-retest-a19efb4/input-before.json').read_text())
    h.save('input-before.json', before)
    cursor = json.loads((h.W / h.CURSOR).read_text())
    assert cursor['phase'] == 'waiting' and cursor['step'] == 88
    assert cursor['waiting_job_id'] == 'ba010ab3-c35c-4a1c-b47e-6b61249daeb0'
    h.save('cursor-before.json', cursor)
    job = h.cli('before-waiting-job', 'operation-status', 'publication', cursor['waiting_job_id'])
    assert job['server_status']['status']['state'] == 'published' and job['server_status']['ownership'] == 'released'
    status = h.cli('before-service', 'service-status')
    assert status['admission']['state'] == 'open' and status['admission']['invocations'] == []
    h.log('延長試験buildのcheck/全自動試験/build成功。私有backup作成のみ、入力hash不変、既知21件目published/released、service open/drainedを確認。同じpublish-rss-importを一度続行。外側時間制限なし。')
    try:
        result = h.cli('publish-continued', 'publish-rss-import', str(h.I))
        h.save('publication-result.json', result)
        assert result['result'] == 'rss-import-published' and result['episode_count'] == 36
        h.log('300秒試験buildで全36件publish-rss-import exit0。標準120秒buildの合格と混同せず記録。独立RSS/代表配信確認待ち。')
    finally:
        h.save('cursor-after.json', json.loads((h.W / h.CURSOR).read_text()))
        shutil.copytree(h.W / '.castloop', h.E / 'private-after-journals')
        unchanged = h.hashes(h.I) == before
        h.save('input-after-validation.json', {'unchanged': unchanged})
        assert unchanged
