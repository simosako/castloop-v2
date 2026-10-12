import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-import-retest-a19efb4'
W = ROOT / 'workspaces/rss-20261012-run1'
I = ROOT / 'imports/rss-20261012-run1'
S = ROOT / 'build/castloop-v2-rss-a19efb4'
CLI = ROOT / 'bin/castloop-linux-x64-a19efb4'
CURSOR = Path('.castloop/rss-imports/rsstest-1012-r1/908efe60-3585-4a6a-af01-f1c5d8afb206.json')
os.umask(0o077)

def save(name, value):
    (E / name).write_text(json.dumps(value, indent=2) + '\n')

def log(text):
    p = ROOT / 'test-20261012.log'
    p.write_text(datetime.datetime.now(datetime.timezone.utc).isoformat() + ' Issue #10 a19efb4 再試験\n' + text + '\n\n' + p.read_text())

def run(name, args, cwd=W, parse=True):
    assert not (E / (name + '.exit-code')).exists(), 'Do not repeat recorded operations'
    with (E / (name + '.stdout')).open('wb') as out, (E / (name + '.stderr')).open('wb') as err:
        result = subprocess.run(args, cwd=cwd, stdout=out, stderr=err)
    (E / (name + '.exit-code')).write_text(str(result.returncode) + '\n')
    if result.returncode:
        log(f'{name}: exit={result.returncode}。エラー時停止、記録保持。')
        raise RuntimeError(f'{name} failed; inspect saved stderr')
    return json.loads((E / (name + '.stdout')).read_text()) if parse else None

def cli(name, *args):
    return run(name, [str(CLI), *args])

def hashes(path):
    result = {}
    for p in sorted(path.rglob('*')):
        if p.is_file():
            with p.open('rb') as f:
                result[str(p.relative_to(path))] = {'sha256': hashlib.file_digest(f, 'sha256').hexdigest(), 'bytes': p.stat().st_size}
    return result

stage = sys.argv[1]
if stage == 'build':
    E.mkdir(exist_ok=False)
    log('ユーザーが修正commit a19efb4のCLI/Worker両方更新と既存import続行を指示。修正差分/最新手順確認。未開始更新のみCLIが厳密確認し旧command_requestedを復旧、未知変更再送拒否は維持。計画保存。')
    for name, args in [('npm-ci', ['npm', 'ci']), ('check', ['npm', 'run', 'check']), ('bun-test', ['bun', 'test']), ('build', ['bun', 'scripts/build-cli.ts', 'linux-x64'])]:
        run(name, args, cwd=S, parse=False)
    assert not CLI.exists()
    shutil.copy2(S / 'dist/castloop-linux-x64', CLI)
    save('build-identity.json', {'commit': 'a19efb4cfc95507787fa54c335c67b5722de414b', 'sha256': hashlib.sha256(CLI.read_bytes()).hexdigest(), 'formal_worker_embedded': True})
    shutil.copy2(S / 'docs/rss_migration.md', E / 'rss_migration.md')
elif stage == 'before':
    backup = E / 'private-workspace-backup'
    backup.mkdir()
    shutil.copy2(W / 'castloop.toml', backup / 'castloop.toml')
    shutil.copytree(W / '.castloop', backup / '.castloop')
    inputs = hashes(I)
    save('input-before.json', inputs)
    assert inputs == json.loads((ROOT / 'evidence/rss-import-retest-dc33f75/input-before.json').read_text())
    save('cursor-before.json', json.loads((W / CURSOR).read_text()))
    cli('before-service', 'service-status')
    shows = cli('before-shows', 'list-shows', '--include-deleted', '--json')
    assert shows['next_cursor'] is None and [s['show_id'] for s in shows['shows']] == ['otftalk-rss']
    cli('before-target', 'target-episode', 'otftalk-rss', 'ep-3b2c6d1cdea50d1a3c6d4d9fbaaf8ea9507ada9ef5796891d8b717bf5635cdc0')
    log('私有workspace backup作成のみ（復元なし）。全116入力hash/size前回一致。cursor/service/全Show/停止Episode照会を保存。')
elif stage == 'update':
    status = cli('pre-pause-service', 'service-status')
    admission = status['admission']
    assert admission['state'] in ['open', 'paused']
    pause_id = admission['pause_id'] if admission['state'] == 'paused' else str(uuid.uuid4())
    save('pause-id.json', {'pause_id': pause_id})
    if admission['state'] == 'open':
        cli('pause', 'service-pause', pause_id)
    paused = cli('paused-service', 'service-status')
    assert paused['admission']['state'] == 'paused' and paused['admission']['pause_id'] == pause_id
    assert paused['admission']['invocations'] == []
    target = cli('paused-target', 'target-show', 'otftalk-rss')
    assert target['unfinished_show_operation'] is False
    before = (W / 'castloop.toml').read_bytes()
    cli('deploy', 'deploy')
    after = cli('deployed-service', 'service-status')
    assert after['admission']['state'] == 'paused' and after['admission']['invocations'] == []
    assert after['worker_version_id'] != status['worker_version_id']
    ready = after['admission']['runtime_readiness']
    assert ready['worker_version_id'] == after['worker_version_id'] and ready['cutover_verified'] is True
    assert after['external_episode_guids'] is True and before == (W / 'castloop.toml').read_bytes()
    domains = cli('deployed-domains', 'domain', 'list')
    assert domains['configuration_matches'] is True and domains['connections_match'] is True and domains['local_operations'] == []
    log('全Show unfinished=false、pause/drain後deploy成功。新Worker runtime verified、paused、設定byte不変/domain整合。明示resume待ち。')
elif stage == 'resume':
    pause_id = json.loads((E / 'pause-id.json').read_text())['pause_id']
    cli('resume', 'service-resume', pause_id)
    status = cli('resumed-service', 'service-status')
    assert status['admission']['state'] == 'open' and status['admission']['invocations'] == [] and status['external_episode_guids'] is True
    log('CLI/Worker更新後明示resume成功。既存記録を保持した元publish-rss-importを一度続行する。')
elif stage == 'publish':
    assert hashes(I) == json.loads((E / 'input-before.json').read_text())
    try:
        result = cli('publish-continued', 'publish-rss-import', str(I))
        save('publication-result.json', result)
        assert result['result'] == 'rss-import-published' and result['episode_count'] == 36
        log('元publish-rss-import exit0、全36件公開完了応答。独立配信照合は次工程。')
    finally:
        save('cursor-after.json', json.loads((W / CURSOR).read_text()))
        shutil.copytree(W / '.castloop', E / 'private-after-journals')
        unchanged = hashes(I) == json.loads((E / 'input-before.json').read_text())
        save('input-after-validation.json', {'unchanged': unchanged})
        assert unchanged
elif stage == 'publish-followup-1':
    assert hashes(I) == json.loads((E / 'input-before.json').read_text())
    cursor = json.loads((W / CURSOR).read_text())
    assert cursor['phase'] == 'waiting' and cursor['step'] == 76
    assert cursor['waiting_job_id'] == '9c26524d-d0d1-4d2d-85eb-024f2a5ccf01'
    save('followup-1-cursor-before.json', cursor)
    log('管理者が速度調査より動作検証の継続を優先。追加調査/回帰を止め、全36件公開完了を先に確認する。CLI内120秒上限は変更せず、既知waiting jobから同じコマンドを一度続行。外側の実行時間制限なし。再エラーなら停止。')
    try:
        result = cli('publish-followup-1', 'publish-rss-import', str(I))
        save('publication-result.json', result)
        assert result['result'] == 'rss-import-published' and result['episode_count'] == 36
        log('元publish-rss-import followup-1 exit0、全36件公開完了応答。追加回帰なし、最小限の独立照合へ。')
    finally:
        save('followup-1-cursor-after.json', json.loads((W / CURSOR).read_text()))
        shutil.copytree(W / '.castloop', E / 'private-followup-1-journals')
        unchanged = hashes(I) == json.loads((E / 'input-before.json').read_text())
        save('followup-1-input-validation.json', {'unchanged': unchanged})
        assert unchanged
elif stage == 'after':
    cli('after-service', 'service-status')
    cli('after-target', 'target-show', 'otftalk-rss')
    cli('after-episodes', 'list-episodes', 'otftalk-rss', '--json')
    cli('after-domains', 'domain', 'list')
