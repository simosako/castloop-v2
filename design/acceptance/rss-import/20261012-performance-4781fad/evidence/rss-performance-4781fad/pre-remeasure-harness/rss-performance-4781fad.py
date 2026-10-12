import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import tomllib
from urllib.parse import quote
from urllib.request import Request, urlopen
import uuid

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-performance-4781fad'
W = ROOT / 'workspaces/rss-20261012-run1'
S = ROOT / 'build/castloop-v2-rss-4781fad'
CLI = ROOT / 'bin/castloop-linux-x64-4781fad'
OLD = ROOT / 'bin/castloop-linux-x64-a19efb4'
CURSOR = W / '.castloop/rss-imports/rsstest-1012-r1/908efe60-3585-4a6a-af01-f1c5d8afb206.json'
EPISODE = 'ep-004c1392e01cd19ddc26e5c90cfb53446b4cecacda00c1cb03d82371b87ae915'
COMMIT = '4781fadbbd8a7b5dd1d4957024b165d774e7e2c1'
os.umask(0o077)

def save(name, value):
    (E / name).write_text(json.dumps(value, indent=2) + '\n')

def log(message):
    path = ROOT / 'test-20261012.log'
    path.write_text(datetime.datetime.now(datetime.timezone.utc).isoformat() + ' RSS性能追試4781fad\n' + message + '\n\n' + path.read_text())

def run(name, args, cwd=W, parse=True):
    assert not (E / (name + '.exit-code')).exists(), 'Never replay recorded operation'
    start = time.monotonic()
    at = time.time_ns() // 1_000_000
    with (E / (name + '.stdout')).open('wb') as out, (E / (name + '.stderr')).open('wb') as err:
        result = subprocess.run(args, cwd=cwd, stdout=out, stderr=err)
    save(name + '.elapsed.json', {'started_at_ms': at, 'elapsed_ms': (time.monotonic() - start) * 1000, 'exit_code': result.returncode})
    (E / (name + '.exit-code')).write_text(str(result.returncode) + '\n')
    print(name, 'exit', result.returncode, flush=True)
    if result.returncode:
        log(name + '失敗。変更処理を再送せず、記録/ownerを維持して停止。')
        raise RuntimeError(name + ' failed; inspect private stderr')
    return json.loads((E / (name + '.stdout')).read_text()) if parse else None

def cli(name, *args, binary=CLI, cwd=W):
    return run(name, [str(binary), *args], cwd=cwd)

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def hashes():
    paths = [W / 'castloop.toml', CURSOR, *sorted((W / 'otftalk-rss').glob('*.toml')), *sorted((ROOT / 'imports/rss-20261012-run1').rglob('*'))]
    return {str(path.relative_to(ROOT)): digest(path) for path in paths if path.is_file()}

def r2get(name, key):
    url = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/r2/buckets/castloop-rss-20261012-run1/objects/' + quote(key, safe='/')
    with urlopen(Request(url, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']}), timeout=60) as response:
        data = response.read()
    (E / name).write_bytes(data)
    return data

def feed(name):
    spec = importlib.util.spec_from_file_location('direct_dns', ROOT / 'diagnostics/dns-direct.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.HOST = 'castloop-rss-r1.otftalk.com'
    answer = module.query(1, 'UDP')
    assert answer['rcode'] == 0
    ip = next(row['address'] for row in answer['addresses'] if row['type'] == 'A')
    save(name + '.dns.json', answer)
    run(name, ['curl', '--silent', '--show-error', '--fail', '--noproxy', '*', '--resolve', module.HOST + ':443:' + ip,
        '--max-time', '60', '-H', 'Cache-Control: no-cache', 'https://' + module.HOST + '/podcasts/otftalk-rss/feed.xml'], parse=False)

def idle(name):
    state = cli(name + '-service', 'service-status')
    assert state['admission']['state'] == 'open' and state['admission']['invocations'] == []
    shows = cli(name + '-shows', 'list-shows', '--include-deleted', '--json')
    assert shows['next_cursor'] is None
    for index, show in enumerate(shows['shows']):
        value = cli(name + '-show-' + str(index), 'target-show', show['show_id'])
        assert value['unfinished_show_operation'] is False
    return state

def measure():
    assert hashes() == json.loads((E / 'baseline-hashes.json').read_text())
    cli('measured-metadata-stage', 'update-episode', EPISODE, cwd=W / 'otftalk-rss')
    result = cli('measured-publication-commit', 'publish-episode', EPISODE, cwd=W / 'otftalk-rss')
    assert result['result'] == 'publication-committed'
    save('measured-job.json', result)
    deadline = time.monotonic() + 300
    for index in range(300):
        if time.monotonic() >= deadline:
            raise RuntimeError('Known job exceeded 300 seconds; retain records/owners')
        status = cli(f'measured-poll-{index:03}', 'operation-status', 'publication', result['job_id'])['server_status']
        state = (status.get('status') or {}).get('state')
        if state in ('failed', 'abandoned') or status['ownership'] == 'superseded':
            raise RuntimeError('Publication failed; stop')
        if state == 'published' and status['ownership'] == 'released':
            save('completion.json', {'job_id': result['job_id'], 'observed_at_ms': time.time_ns() // 1_000_000, 'poll_index': index})
            break
        time.sleep(1)
    else:
        raise RuntimeError('Inspection limit exceeded')
    # Show release precedes service invocation release. Read-only wait for that distinct boundary.
    for index in range(20):
        state = cli(f'after-drain-{index:02}', 'service-status')
        assert state['admission']['state'] == 'open'
        if state['admission']['invocations'] == []:
            break
        time.sleep(1)
    else:
        raise RuntimeError('Service invocation did not drain; no further mutations')
    idle('after')
    r2get('after-metadata-private.toml', f'public/episodes/otftalk-rss/{EPISODE}/metadata.toml')
    before = tomllib.loads((E / 'before-metadata-private.toml').read_text())
    after = tomllib.loads((E / 'after-metadata-private.toml').read_text())
    for key in ('revision_id', 'updated_at'):
        before.pop(key, None)
        after.pop(key, None)
    assert before == after, 'Published content changed'
    feed('after-feed-private')
    assert (E / 'before-feed-private.stdout').read_bytes() == (E / 'after-feed-private.stdout').read_bytes()
    assert hashes() == json.loads((E / 'baseline-hashes.json').read_text())
    domains = cli('final-domains', 'domain', 'list')
    assert domains['configuration_matches'] and domains['connections_match'] and domains['local_operations'] == []
    save('preservation.json', {'feed_byte_unchanged': True, 'metadata_except_revision_updated_at_unchanged': True,
        'inputs_cursor_local_toml_unchanged': True, 'service_open_drained': True, 'all_shows_idle': True, 'domains_match': True})

stage = sys.argv[1]
if stage == 'build':
    E.mkdir(exist_ok=False)
    log('4781fad性能改善の追試を承認。無改変CLI/Workerを別worktreeでbuildし既存RSS環境へ正式更新。前回と同一36件Show/同一Episode/metadata-only1job。計測は正式Worker Logsライブtail、秘密を保存しないallowlist。旧環境/音源/元取り込み記録を保持。test-plan-rss-performance-4781fad.md。')
    for name, args in [('npm-ci', ['npm', 'ci']), ('check', ['npm', 'run', 'check']), ('bun-test', ['bun', 'test']), ('build', ['bun', 'scripts/build-cli.ts', 'linux-x64'])]:
        run(name, args, cwd=S, parse=False)
    assert not CLI.exists()
    shutil.copy2(S / 'dist/castloop-linux-x64', CLI)
    head = run('source-head', ['git', 'rev-parse', 'HEAD'], cwd=S, parse=False)
    assert (E / 'source-head.stdout').read_text().strip() == COMMIT
    run('source-status', ['git', 'status', '--porcelain'], cwd=S, parse=False)
    assert not (E / 'source-status.stdout').read_text().strip()
    save('build-identity.json', {'commit': COMMIT, 'cli_sha256': digest(CLI), 'unmodified_source': True})
elif stage == 'prepare-install':
    shutil.copytree(W, E / 'private-workspace-backup')
    assert json.loads(CURSOR.read_text())['phase'] == 'completed'
    save('baseline-hashes.json', hashes())
    initial = idle('before')
    save('selection.json', {'show_id': 'otftalk-rss', 'episode_id': EPISODE, 'mode': 'unchanged-metadata-only', 'episode_count': 36})
    cli('before-episode', 'target-episode', 'otftalk-rss', EPISODE)
    r2get('before-metadata-private.toml', f'public/episodes/otftalk-rss/{EPISODE}/metadata.toml')
    feed('before-feed-private')
    script = '''import { parseEpisodeDraft, parseEpisodeRevision } from "./packages/shared/src/index";
import { readFileSync } from "node:fs";
const draft = parseEpisodeDraft(readFileSync(process.argv[1], "utf8"));
const revision = parseEpisodeRevision(readFileSync(process.argv[2], "utf8"));
for (const [key, value] of Object.entries(draft)) if (JSON.stringify(value) !== JSON.stringify(revision[key])) throw new Error("Metadata differs: " + key);
console.log(JSON.stringify({ unchanged_normalized_draft: true }));'''
    run('verify-input', ['bun', '-e', script, str(W / 'otftalk-rss' / ('episode-' + EPISODE + '.toml')), str(E / 'before-metadata-private.toml')], cwd=S)
    pause_id = str(uuid.uuid4())
    save('install-pause-id.json', {'pause_id': pause_id})
    cli('install-pause', 'service-pause', pause_id)
    paused = cli('install-paused', 'service-status')
    assert paused['admission']['state'] == 'paused' and paused['admission']['invocations'] == []
    cli('install-deploy', 'deploy')
    updated = cli('install-updated', 'service-status')
    assert updated['admission']['state'] == 'paused' and updated['admission']['invocations'] == []
    ready = updated['admission']['runtime_readiness']
    assert ready['cutover_verified'] and ready['worker_version_id'] == updated['worker_version_id']
    assert updated['worker_version_id'] != initial['worker_version_id']
    cli('install-resume', 'service-resume', pause_id)
    final = idle('installed')
    save('installed-worker.json', {'commit': COMMIT, 'worker_version_id': final['worker_version_id'], 'open_drained': True})
    log('無改変4781fad CLI/Worker、正式pause/deploy/verified/resume完了。元記録不変/正規化metadata一致/全Show idle。Worker Logs接続後に1job測定する。')
elif stage == 'measure':
    assert not (E / 'tail.stdout').exists(), 'Never restart this measurement'
    with (E / 'tail.stdout').open('wb') as out, (E / 'tail.stderr').open('wb') as err:
        proc = subprocess.Popen(['bun', str(ROOT / 'diagnostics/rss-performance-tail.ts'), str(E)], cwd=ROOT, stdout=out, stderr=err)
        try:
            deadline = time.monotonic() + 90
            while not (E / 'tail-ready.json').exists():
                if proc.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Worker logs unavailable; stop before publication')
                time.sleep(0.2)
            measure()
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if proc.poll() is not None or (E / 'tail-unexpected-close.json').exists() or (E / 'tail-capture-error.json').exists():
                    raise RuntimeError('Log capture interrupted; do not replay publication')
                rows = [json.loads(line) for line in (E / 'worker-logs.jsonl').read_text().splitlines()] if (E / 'worker-logs.jsonl').exists() else []
                job = json.loads((E / 'measured-job.json').read_text())['job_id']
                if any(log.get('job_id') == job and log.get('phase') == 'publication.consumer' for row in rows for log in row['logs']):
                    break
                time.sleep(0.5)
            else:
                raise RuntimeError('Consumer phase log missing; preserve result, do not replay')
        finally:
            (E / 'tail-stop').write_text('Stop only this diagnostic stream\n')
            code = proc.wait(timeout=90)
            (E / 'tail.exit-code').write_text(str(code) + '\n')
            if code:
                raise RuntimeError('Worker logs process failed; inspect evidence')
    log('同一metadata-only1job published/released、service open/drained・全Show idle、feed byte一致/metadata同一/入力cursorTOML hash一致/domain整合。正式Worker Logsのconsumer終了記録取得、今回tail sessionのみ終了。4781fad Workerを維持、性能比較集計へ。')
else:
    raise RuntimeError('Unknown stage')
