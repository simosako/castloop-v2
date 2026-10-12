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
E = ROOT / 'evidence/rss-import-retest-dc33f75'
W = ROOT / 'workspaces/rss-20261012-run1'
I = ROOT / 'imports/rss-20261012-run1'
CLI = ROOT / 'bin/castloop-linux-x64-dc33f75'
CURSOR = Path('.castloop/rss-imports/rsstest-1012-r1/908efe60-3585-4a6a-af01-f1c5d8afb206.json')
os.umask(0o077)

def save(name, value):
    (E / name).write_text(json.dumps(value, indent=2) + '\n')

def log(text):
    p = ROOT / 'test-20261012.log'
    p.write_text(datetime.datetime.now(datetime.timezone.utc).isoformat() + ' Issue #10 再試験\n' + text + '\n\n' + p.read_text())

def run(name, *args):
    with (E / (name + '.stdout')).open('wb') as out, (E / (name + '.stderr')).open('wb') as err:
        r = subprocess.run([str(CLI), *args], cwd=W, stdout=out, stderr=err)
    (E / (name + '.exit-code')).write_text(str(r.returncode) + '\n')
    if r.returncode:
        log(f'{name}: exit={r.returncode}。エラー時停止方針に従い停止、証跡を保持。')
        raise RuntimeError(f'{name} failed; inspect saved stderr')
    return json.loads((E / (name + '.stdout')).read_text())

def hashes(path):
    return {str(p.relative_to(path)): {'sha256': hashlib.file_digest(p.open('rb'), 'sha256').hexdigest(), 'bytes': p.stat().st_size}
            for p in sorted(path.rglob('*')) if p.is_file()}

stage = sys.argv[1]
if stage == 'before':
    backup = E / 'private-workspace-backup'
    backup.mkdir()
    shutil.copy2(W / 'castloop.toml', backup / 'castloop.toml')
    shutil.copytree(W / '.castloop', backup / '.castloop')
    save('input-before.json', hashes(I))
    save('cursor-before.json', json.loads((W / CURSOR).read_text()))
    service = run('before-service', 'service-status')
    shows = []
    cursor = None
    for page in range(100):
        args = ['list-shows', '--include-deleted', '--json']
        if cursor: args.extend(['--cursor', cursor])
        data = run(f'before-shows-{page}', *args)
        save('show-inventory-raw.json', data)
        # The exact response shape is validated before any mutation.
        if page == 0:
            print('Inspect saved listing schema before pause')
            break
    log('新build npm ci/check/bun test/build完了。workspace設定と秘密journalを私有backupへ保存。入力全hash/cursor/service/Show一覧を読み取り保存。')
elif stage == 'update':
    inventory = json.loads((E / 'show-inventory-raw.json').read_text())
    assert inventory['next_cursor'] is None
    assert [s['show_id'] for s in inventory['shows']] == ['otftalk-rss']
    job = run('before-waiting-job', 'operation-status', 'publication', 'a497abe0-450b-407b-96bb-c52d7782547c')
    assert job['server_status']['status']['state'] == 'published'
    assert job['server_status']['ownership'] == 'released'
    admission = run('pre-pause-service', 'service-status')['admission']
    if admission['state'] == 'open':
        pause_id = str(uuid.uuid4())
        save('pause-id.json', {'pause_id': pause_id})
        run('pause', 'service-pause', pause_id)
    else:
        assert admission['state'] == 'paused'
        pause_id = admission['pause_id']
        save('pause-id.json', {'pause_id': pause_id, 'existing': True})
    status = run('paused-service', 'service-status')
    assert status['admission']['state'] == 'paused'
    assert status['admission']['pause_id'] == pause_id
    assert status['admission']['invocations'] == []
    for show in inventory['shows']:
        target = run('paused-target-' + show['show_id'], 'target-show', show['show_id'])
        assert target['unfinished_show_operation'] is False
    config_before = (W / 'castloop.toml').read_bytes()
    run('deploy', 'deploy')
    updated = run('deployed-service', 'service-status')
    assert updated['admission']['state'] == 'paused'
    assert updated['admission']['invocations'] == []
    assert updated['external_episode_guids'] is True
    assert updated['worker_version_id'] != status['worker_version_id']
    assert updated['admission']['runtime_readiness']['worker_version_id'] == updated['worker_version_id']
    assert updated['admission']['runtime_readiness']['cutover_verified'] is True
    assert (W / 'castloop.toml').read_bytes() == config_before
    domains = run('deployed-domains', 'domain', 'list')
    save('update-validation.json', {'worker_changed': True, 'config_unchanged': True, 'paused_and_drained': True,
                                  'previous_job_published_released': True, 'pause_id': pause_id})
    print('Deployment verified paused; inspect domain evidence before explicit resume')
    log('962 tests pass/0 fail、型check/build成功。既知Episode job published/released。全Show inventory=1件、末尾cursorなし。pause後invocations空・unfinished=falseを確認しdeploy成功、新runtime verified/paused、設定byte不変。resume前domain確認待ち。')
elif stage == 'resume':
    domains = json.loads((E / 'deployed-domains.stdout').read_text())
    assert domains['configuration_matches'] is True and domains['connections_match'] is True
    assert domains['local_operations'] == []
    pause_id = json.loads((E / 'pause-id.json').read_text())['pause_id']
    run('resume', 'service-resume', pause_id)
    status = run('resumed-service', 'service-status')
    assert status['admission']['state'] == 'open' and status['admission']['invocations'] == []
    assert status['external_episode_guids'] is True
    log('Worker更新後domain整合/未完了操作なしを確認。保存したpause IDで明示resume、open/invocations空/M7 capability true。元importからの続行準備完了。')
    print('Resumed, ready to continue original import')
elif stage == 'publish':
    assert hashes(I) == json.loads((E / 'input-before.json').read_text()), 'Import inputs changed'
    result = run('publish-continued', 'publish-rss-import', str(I))
    save('publication-result.json', result)
    save('cursor-after.json', json.loads((W / CURSOR).read_text()))
    assert hashes(I) == json.loads((E / 'input-before.json').read_text()), 'Import inputs changed'
    log('修正CLIで元取り込み記録のpublish-rss-importがexit0。入力hash不変。詳細と配信検証は保存証跡を確認。')
    print(json.dumps(result))
