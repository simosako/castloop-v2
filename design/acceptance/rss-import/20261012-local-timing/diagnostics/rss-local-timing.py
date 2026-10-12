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
E = ROOT / 'evidence/rss-local-timing-20261012'
W = ROOT / 'workspaces/rss-20261012-run1'
S = ROOT / 'build/castloop-v2-rss-local-timing'
CLI = ROOT / 'bin/castloop-linux-x64-a19efb4-local-timing'
STANDARD = ROOT / 'bin/castloop-linux-x64-a19efb4'
CURSOR = W / '.castloop/rss-imports/rsstest-1012-r1/908efe60-3585-4a6a-af01-f1c5d8afb206.json'
os.umask(0o077)

def save(name, value):
    (E / name).write_text(json.dumps(value, indent=2) + '\n')

def log(message):
    path = ROOT / 'test-20261012.log'
    path.write_text(datetime.datetime.now(datetime.timezone.utc).isoformat() + ' RSS単一jobローカル計測\n' + message + '\n\n' + path.read_text())

def run(name, args, cwd=W, parse=True, timing=True):
    assert not (E / (name + '.exit-code')).exists(), 'Never repeat a recorded operation'
    env = os.environ.copy()
    if timing:
        env['CASTLOOP_LOCAL_TIMING_FILE'] = str(E / (name + '.timing.jsonl'))
    start = time.monotonic()
    at = time.time_ns() // 1_000_000
    with (E / (name + '.stdout')).open('wb') as out, (E / (name + '.stderr')).open('wb') as err:
        result = subprocess.run(args, cwd=cwd, env=env, stdout=out, stderr=err)
    save(name + '.elapsed.json', {'started_at_ms': at, 'elapsed_ms': (time.monotonic() - start) * 1000, 'exit_code': result.returncode})
    (E / (name + '.exit-code')).write_text(str(result.returncode) + '\n')
    print(name, 'exit', result.returncode, flush=True)
    if result.returncode:
        log(name + ' failed; stop, preserve evidence and owners.')
        raise RuntimeError(name + ' failed; inspect private stderr')
    return json.loads((E / (name + '.stdout')).read_text()) if parse else None

def cli(name, *args, binary=CLI, cwd=W):
    return run(name, [str(binary), *args], cwd=cwd)

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def baseline_hashes():
    paths = [W / 'castloop.toml', CURSOR, *sorted((W / 'otftalk-rss').glob('*.toml')),
        *sorted((ROOT / 'imports/rss-20261012-run1').rglob('*'))]
    return {str(path.relative_to(ROOT)): digest(path) for path in paths if path.is_file()}

def target():
    return json.loads((E / 'selection.json').read_text())['episode_id']

def feed(name):
    spec = importlib.util.spec_from_file_location('direct_dns', ROOT / 'diagnostics/dns-direct.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.HOST = 'castloop-rss-r1.otftalk.com'
    answer = module.query(1, 'UDP')
    assert answer['rcode'] == 0
    ip = next(value['address'] for value in answer['addresses'] if value['type'] == 'A')
    save(name + '.dns.json', answer)
    run(name, ['curl', '--silent', '--show-error', '--fail', '--noproxy', '*', '--resolve', module.HOST + ':443:' + ip,
        '--max-time', '60', '-H', 'Cache-Control: no-cache', 'https://' + module.HOST + '/podcasts/otftalk-rss/feed.xml'], parse=False, timing=False)

def r2get(name, key):
    base = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID']
    url = base + '/r2/buckets/castloop-rss-20261012-run1/objects/' + quote(key, safe='/')
    with urlopen(Request(url, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']}), timeout=60) as response:
        data = response.read()
    (E / name).write_bytes(data)
    return data

stage = sys.argv[1]
if stage == 'build':
    E.mkdir(exist_ok=False)
    log('ユーザーが1job精密計測とlocal-only debug追加を承認。別detached worktreeにCLI/Worker計測、元36件Showの同一metadata-only再公開1jobを計測。正式pause/deploy/resume後に実施し、idle確認後無計測Workerへ戻す。source/binaryをcommit/pushしない。')
    for name, args in [('check', ['npm', 'run', 'check']), ('bun-test', ['bun', 'test']), ('build', ['bun', 'scripts/build-cli.ts', 'linux-x64'])]:
        run(name, args, cwd=S, parse=False, timing=False)
    assert not CLI.exists()
    shutil.copy2(S / 'dist/castloop-linux-x64', CLI)
    run('source-diff', ['git', 'diff'], cwd=S, parse=False, timing=False)
    save('build-identity.json', {'base_commit': 'a19efb4cfc95507787fa54c335c67b5722de414b', 'sha256': digest(CLI), 'local_only': True})
elif stage == 'before':
    backup = E / 'private-workspace-backup'
    shutil.copytree(W, backup)
    assert json.loads(CURSOR.read_text())['phase'] == 'completed'
    save('baseline-hashes.json', baseline_hashes())
    state = cli('before-service', 'service-status', binary=STANDARD)
    assert state['admission']['state'] == 'open' and state['admission']['invocations'] == []
    shows = cli('before-shows', 'list-shows', '--include-deleted', '--json', binary=STANDARD)
    assert shows['next_cursor'] is None
    for index, show in enumerate(shows['shows']):
        value = cli('before-show-' + str(index), 'target-show', show['show_id'], binary=STANDARD)
        assert value['unfinished_show_operation'] is False
    episode_id = sorted((W / 'otftalk-rss').glob('episode-*.toml'))[0].stem.removeprefix('episode-')
    save('selection.json', {'show_id': 'otftalk-rss', 'episode_id': episode_id, 'mode': 'unchanged-metadata-only', 'expected_episode_count': 36})
    cli('before-episode', 'target-episode', 'otftalk-rss', episode_id, binary=STANDARD)
    r2get('before-metadata-private.toml', f'public/episodes/otftalk-rss/{episode_id}/metadata.toml')
    feed('before-feed-private')
    log('completed cursor/全入力/全ローカルTOMLのhash保存、workspaceコピーbackupのみ。全Show idle/service open/drained、変更前feed/current metadata取得。')
elif stage == 'verify-input':
    script = '''import { parseEpisodeDraft, parseEpisodeRevision } from "./packages/shared/src/index";
import { readFileSync } from "node:fs";
const draft = parseEpisodeDraft(readFileSync(process.argv[1], "utf8"));
const revision = parseEpisodeRevision(readFileSync(process.argv[2], "utf8"));
for (const [key, value] of Object.entries(draft)) {
  if (JSON.stringify(value) !== JSON.stringify(revision[key])) throw new Error("Metadata differs: " + key);
}
console.log(JSON.stringify({ unchanged_normalized_draft: true }));'''
    run('verify-input', ['bun', '-e', script, str(W / 'otftalk-rss' / ('episode-' + target() + '.toml')),
        str(E / 'before-metadata-private.toml')], cwd=S, timing=False)
elif stage in ('install', 'restore'):
    binary = CLI if stage == 'install' else STANDARD
    status = cli(stage + '-pre-service', 'service-status', binary=binary)
    assert status['admission']['state'] == 'open' and status['admission']['invocations'] == []
    value = cli(stage + '-pre-show', 'target-show', 'otftalk-rss', binary=binary)
    assert value['unfinished_show_operation'] is False
    pause_id = str(uuid.uuid4())
    save(stage + '-pause-id.json', {'pause_id': pause_id})
    cli(stage + '-pause', 'service-pause', pause_id, binary=binary)
    paused = cli(stage + '-paused', 'service-status', binary=binary)
    assert paused['admission']['state'] == 'paused' and paused['admission']['invocations'] == []
    cli(stage + '-deploy', 'deploy', binary=binary)
    updated = cli(stage + '-updated', 'service-status', binary=binary)
    assert updated['admission']['state'] == 'paused' and updated['admission']['invocations'] == []
    ready = updated['admission']['runtime_readiness']
    assert ready['worker_version_id'] == updated['worker_version_id'] and ready['cutover_verified'] is True
    assert updated['worker_version_id'] != status['worker_version_id']
    cli(stage + '-resume', 'service-resume', pause_id, binary=binary)
    resumed = cli(stage + '-resumed', 'service-status', binary=binary)
    assert resumed['admission']['state'] == 'open' and resumed['admission']['invocations'] == []
    log(stage + ': 正式pause/drain→deploy/verified→resume完了。設定/旧環境変更なし。')
elif stage == 'error-inspect':
    state = cli('after-argument-error-service', 'service-status', binary=STANDARD)
    show = cli('after-argument-error-show', 'target-show', 'otftalk-rss', binary=STANDARD)
    assert state['admission']['state'] == 'open' and state['admission']['invocations'] == []
    assert show['unfinished_show_operation'] is False
    unchanged = baseline_hashes() == json.loads((E / 'baseline-hashes.json').read_text())
    assert unchanged
    save('argument-error-stop.json', {'cause': 'harness used internal arguments rather than public CLI Show-directory convention',
        'failed_command_elapsed_ms': json.loads((E / 'measured-metadata-stage.elapsed.json').read_text())['elapsed_ms'],
        'failed_command_no_http_trace': not (E / 'measured-metadata-stage.timing.jsonl').exists(),
        'publication_not_started': not (E / 'measured-job.json').exists(), 'original_inputs_cursor_toml_unchanged': unchanged,
        'service_open_drained': True, 'unfinished_show_operation': False, 'instrumented_worker_remains_installed': True,
        'corrected_harness_not_executed': True})
    log('計測commandの引数誤りで54ms/exit1、HTTP計測出力なし、ステージング/公開開始前に停止。実仕様はShow directoryでEpisode IDのみ。helperの引数のみ修正したが未再実行。読み取り確認でservice open/drained、Show未完了なし、元入力/cursor/TOML不変。計測Workerはinstalled、無計測Workerへまだ戻していない。ユーザー確認待ち。')
elif stage == 'measure-corrected':
    assert baseline_hashes() == json.loads((E / 'baseline-hashes.json').read_text())
    log('ユーザーが引数修正後の計測続行を承認。Show directoryでupdate-episode/publish-episodeへEpisode IDのみ渡す。前回54msの引数拒否記録は保持し、同一metadata-only1jobを新規に計測する。')
    cli('measured-metadata-stage-corrected', 'update-episode', target(), cwd=W / 'otftalk-rss')
    result = cli('measured-publication-commit', 'publish-episode', target(), cwd=W / 'otftalk-rss')
    assert result['result'] == 'publication-committed'
    save('measured-job.json', result)
    job_id = result['job_id']
    deadline = time.monotonic() + 300
    for index in range(300):
        if time.monotonic() >= deadline:
            raise RuntimeError('Known job exceeded 300 seconds; preserve owner and stop')
        status = cli(f'measured-poll-{index:03}', 'operation-status', 'publication', job_id)
        server = status['server_status']
        if (server.get('status') or {}).get('state') in ('failed', 'abandoned') or server['ownership'] == 'superseded':
            raise RuntimeError('Job failure; stop')
        if (server.get('status') or {}).get('state') == 'published' and server['ownership'] == 'released':
            save('completion.json', {'job_id': job_id, 'observed_at_ms': time.time_ns() // 1_000_000, 'poll_index': index})
            break
        time.sleep(1)
    else:
        raise RuntimeError('Inspection limit exceeded')
    state = cli('after-service', 'service-status')
    assert state['admission']['state'] == 'open' and state['admission']['invocations'] == []
    current = cli('after-show', 'target-show', 'otftalk-rss')
    assert current['unfinished_show_operation'] is False
    r2get('after-metadata-private.toml', f'public/episodes/otftalk-rss/{target()}/metadata.toml')
    before = tomllib.loads((E / 'before-metadata-private.toml').read_text())
    after = tomllib.loads((E / 'after-metadata-private.toml').read_text())
    for key in ('revision_id', 'updated_at'):
        before.pop(key, None)
        after.pop(key, None)
    assert before == after, 'Published contents changed'
    feed('after-feed-private')
    assert (E / 'before-feed-private.stdout').read_bytes() == (E / 'after-feed-private.stdout').read_bytes(), 'Feed changed'
    assert baseline_hashes() == json.loads((E / 'baseline-hashes.json').read_text())
    save('preservation.json', {'feed_byte_unchanged': True, 'metadata_except_revision_updated_at_unchanged': True,
        'inputs_cursor_local_toml_unchanged': True, 'service_open_drained': True, 'unfinished_show_operation': False})
    log('計測1job published/released。metadataはrevision_id/updated_at以外同一、feed byte同一、全入力/cursor/ローカルTOML同一、service open/drained。計測trace取得・無計測Workerへの正式更新待ち。')
elif stage == 'collect':
    base = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID']
    prefix = 'system/diagnostics/local-timing/20261012-one-job/'
    url = base + '/r2/buckets/castloop-rss-20261012-run1/objects?prefix=' + quote(prefix, safe='') + '&limit=1000'
    with urlopen(Request(url, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']}), timeout=60) as response:
        assert not response.headers.get('cf-r2-list-cursor'), 'Trace listing requires pagination; stop'
        listing = json.loads(response.read())
    save('trace-listing-private.json', listing)
    assert listing['success'] is True
    assert not listing.get('result_info', {}).get('cursor'), 'Trace listing cursor remains; stop'
    rows = listing['result']
    if isinstance(rows, dict):
        rows = rows['objects']
    count = 0
    for row in rows:
        key = row['key']
        assert key.startswith(prefix) and key.endswith('.json')
        report = json.loads(r2get('queue-' + key.rsplit('/', 1)[1], key))
        count += 1
    assert count > 0, 'No trace yet; stop, do not replay publication'
    print('Queue trace files:', count)
elif stage == 'final':
    assert (E / 'restore-resumed.exit-code').read_text().strip() == '0'
    state = cli('final-service', 'service-status', binary=STANDARD)
    current = cli('final-show', 'target-show', 'otftalk-rss', binary=STANDARD)
    domains = cli('final-domains', 'domain', 'list', binary=STANDARD)
    assert state['admission']['state'] == 'open' and state['admission']['invocations'] == []
    assert current['unfinished_show_operation'] is False
    assert domains['configuration_matches'] is True and domains['connections_match'] is True and domains['local_operations'] == []
    assert baseline_hashes() == json.loads((E / 'baseline-hashes.json').read_text())
    source_snapshot = E / 'local-only-source'
    source_snapshot.mkdir(exist_ok=False)
    for relative in ['src/local-timing.ts', 'src/local-timing.test.ts', 'src/worker.ts', 'src/publication-episode-runner.ts',
        'src/publication-consumer.ts', 'src/service-admission.ts', 'src/lifecycle-worker-effects.ts',
        'packages/cli/src/local-timing.ts', 'packages/cli/src/index.ts', 'packages/cli/src/staging-rest.ts']:
        destination = source_snapshot / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(S / relative, destination)
    save('final-state.json', {'worker_restored_to_standard_a19efb4': True, 'worker_version_id': state['worker_version_id'],
        'service_open_drained': True, 'unfinished_show_operation': False, 'domains_match': True,
        'original_inputs_cursor_toml_unchanged': True, 'local_source_and_binary_not_committed_or_pushed': True,
        'private_R2_diagnostic_records_retained': True})
    log('単一metadata-only job精密計測完了。Queue message→consumer 940ms、Worker96727ms、R2 binding484回（GET419/HEAD45/list3/PUT17）。guard8回26949ms、GUID7566ms、RSS全件入力20616ms、cache invalidate RPC173ms。標準a19efb4 Workerへ正式pause/deploy/resumeで復帰済み、最終service open/drained・Show未完了なし・domain整合・元入力/cursor/TOML不変。公開feed byte同一。計測source/binaryはlocal-only、commit/pushなし。詳細 timing-analysis.json/detailed-breakdown.json/result.md。')
else:
    raise RuntimeError('Unknown stage')
