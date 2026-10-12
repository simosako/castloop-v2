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
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
import uuid
from rss_performance_wait import is_known_publication_read_conflict, wait_for_publication

ROOT = Path('[LOCAL_TEST_ROOT]')
BASE = ROOT / 'evidence/rss-performance-a8c7e54'
E = BASE
W = ROOT / 'workspaces/rss-20261012-run1'
S = ROOT / 'build/castloop-v2-rss-a8c7e54'
CLI = ROOT / 'bin/castloop-linux-x64-a8c7e54'
CURSOR = W / '.castloop/rss-imports/rsstest-1012-r1/908efe60-3585-4a6a-af01-f1c5d8afb206.json'
EPISODE = 'ep-004c1392e01cd19ddc26e5c90cfb53446b4cecacda00c1cb03d82371b87ae915'
COMMIT = 'a8c7e54e8c326ef238a2fcd9d672a27b002bec66'
os.umask(0o077)


def save(name, value):
    (E / name).write_text(json.dumps(value, indent=2) + '\n')


def log(message):
    path = ROOT / 'test-20261012.log'
    path.write_text(datetime.datetime.now(datetime.timezone.utc).isoformat() + ' RSS性能追試a8c7e54\n' + message + '\n\n' + path.read_text())


def run(name, args, cwd=W, parse=True, allow_read_conflict=False):
    assert not (E / (name + '.exit-code')).exists(), 'Never replay recorded operation'
    start = time.monotonic()
    at = time.time_ns() // 1_000_000
    with (E / (name + '.stdout')).open('wb') as out, (E / (name + '.stderr')).open('wb') as err:
        result = subprocess.run(args, cwd=cwd, stdout=out, stderr=err)
    save(name + '.elapsed.json', {'started_at_ms': at, 'elapsed_ms': (time.monotonic() - start) * 1000, 'exit_code': result.returncode})
    (E / (name + '.exit-code')).write_text(str(result.returncode) + '\n')
    print(name, 'exit', result.returncode, flush=True)
    if result.returncode:
        if allow_read_conflict and is_known_publication_read_conflict(result.returncode, args,
                (E / (name + '.stdout')).read_text(), (E / (name + '.stderr')).read_text()):
            save(name + '.retry.json', {'reason_code': 'publication_status_changed', 'read_only': True,
                'job_id': args[3], 'mutation_replayed': False})
            return None
        raise RuntimeError(name + ' failed; inspect private stderr; no mutation retry')
    return json.loads((E / (name + '.stdout')).read_text()) if parse else None


def cli(name, *args, cwd=W, allow_read_conflict=False):
    return run(name, [str(CLI), *args], cwd=cwd, allow_read_conflict=allow_read_conflict)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def hashes():
    paths = [W / 'castloop.toml', CURSOR, *sorted((W / 'otftalk-rss').glob('*.toml')),
        *sorted((ROOT / 'imports/rss-20261012-run1').rglob('*'))]
    return {str(path.relative_to(ROOT)): digest(path) for path in paths if path.is_file()}


def r2get(name, key, allow_missing=False):
    url = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/r2/buckets/castloop-rss-20261012-run1/objects/' + quote(key, safe='/')
    try:
        with urlopen(Request(url, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']}), timeout=60) as response:
            data = response.read()
    except HTTPError as error:
        if allow_missing and error.code == 404:
            save(name + '.missing.json', {'expected_http_status': 404, 'catalog_absent_before_initialization': True})
            return None
        raise
    (E / name).write_bytes(data)
    return data


def public(name, path, expected=200):
    spec = importlib.util.spec_from_file_location('direct_dns', ROOT / 'diagnostics/dns-direct.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.HOST = 'castloop-rss-r1.otftalk.com'
    answer = module.query(1, 'UDP')
    assert answer['rcode'] == 0
    ip = next(row['address'] for row in answer['addresses'] if row['type'] == 'A')
    save(name + '.dns.json', answer)
    body = E / (name + '.body-private')
    run(name, ['curl', '--silent', '--show-error', '--noproxy', '*', '--resolve', module.HOST + ':443:' + ip,
        '--max-time', '60', '-H', 'Cache-Control: no-cache', '--output', str(body), '--write-out', '%{http_code}',
        'https://' + module.HOST + path], parse=False)
    assert (E / (name + '.stdout')).read_text() == str(expected), 'Unexpected public HTTP status'
    return body.read_bytes()


def feed(name):
    return public(name, '/podcasts/otftalk-rss/feed.xml')


def idle(name):
    state = cli(name + '-service', 'service-status')
    assert state['admission']['state'] == 'open' and state['admission']['invocations'] == []
    shows = cli(name + '-shows', 'list-shows', '--include-deleted', '--json')
    assert shows['next_cursor'] is None
    for index, show in enumerate(shows['shows']):
        value = cli(name + '-show-' + str(index), 'target-show', show['show_id'])
        assert value['unfinished_show_operation'] is False
    return state


def metadata_normalized(source):
    value = tomllib.loads(source)
    for key in ('revision_id', 'updated_at'):
        value.pop(key, None)
    return value


def catalog(name, expected_job=None):
    control = json.loads(r2get(name + '-show-control-private.json', 'system/show-publications/otftalk-rss.json'))
    assert control.get('owner') is None
    value = json.loads(r2get(name + '-catalog-private.json', 'public/podcasts/otftalk-rss/episode-catalog.json'))
    entries = value['entries']
    assert value['schema_version'] == 1 and value['show_id'] == 'otftalk-rss'
    assert len(entries) == 36 and all(row['active'] for row in entries)
    assert len({row['revision']['guid'] for row in entries}) == 36
    assert len({row['revision']['episode_id'] for row in entries}) == 36
    assert control['episode_catalog_initialized'] is True
    assert control['feed_generation'] == value['feed_generation']
    assert control['last_feed_job_id'] == value['applied_job_id']
    if expected_job:
        assert value['applied_job_id'] == expected_job
        target = next(row['revision'] for row in entries if row['revision']['episode_id'] == EPISODE)
        assert target['revision_id'] == expected_job
        assert target == tomllib.loads((E / 'after-metadata-private.toml').read_text())
    save(name + '-catalog-validation.json', {'entry_count': 36, 'active_count': 36, 'unique_guids': True,
        'initialized': True, 'generation_matches': True, 'applied_job_id': value['applied_job_id'],
        'feed_generation': value['feed_generation'], 'bytes': (E / (name + '-catalog-private.json')).stat().st_size})
    return value


def build():
    BASE.mkdir(exist_ok=False)
    log('Issue #10追加改修a8c7e54/手順書確認。test-plan-rss-performance-a8c7e54.mdに従い無改変CLI/Worker更新、カタログ初回構築と通常更新の2jobを別測定。旧環境/公開内容/記録保持、他エラー停止、既知publication_status_changedのみread retry。GitHub共有は今回未実施。')
    for name, args in [('npm-ci', ['npm', 'ci']), ('check', ['npm', 'run', 'check']), ('bun-test', ['bun', 'test']), ('build', ['bun', 'scripts/build-cli.ts', 'linux-x64'])]:
        run(name, args, cwd=S, parse=False)
    assert not CLI.exists()
    shutil.copy2(S / 'dist/castloop-linux-x64', CLI)
    run('source-head', ['git', 'rev-parse', 'HEAD'], cwd=S, parse=False)
    assert (E / 'source-head.stdout').read_text().strip() == COMMIT
    run('source-status', ['git', 'status', '--porcelain'], cwd=S, parse=False)
    assert not (E / 'source-status.stdout').read_text().strip()
    save('build-identity.json', {'commit': COMMIT, 'cli_sha256': digest(CLI), 'unmodified_source': True})
    run('harness-tests', ['python', '-B', '-m', 'unittest', '-v', 'test_rss_performance_wait'], cwd=ROOT / 'diagnostics', parse=False)


def install():
    assert digest(CLI) == json.loads((BASE / 'build-identity.json').read_text())['cli_sha256']
    shutil.copytree(W, E / 'private-workspace-backup')
    assert json.loads(CURSOR.read_text())['phase'] == 'completed'
    assert hashes() == json.loads((ROOT / 'evidence/rss-performance-4781fad-remeasure1/baseline-hashes.json').read_text())
    save('baseline-hashes.json', hashes())
    initial = idle('before')
    assert initial['worker_version_id'] == '6d3d011d-e720-42b6-80b0-41f2830128ff'
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
    assert hashes() == json.loads((BASE / 'baseline-hashes.json').read_text())
    save('installed-worker.json', {'commit': COMMIT, 'worker_version_id': final['worker_version_id'], 'open_drained': True})
    log('a8c7e54無改変CLI/Workerの正式pause/deploy/cutover verified/resume完了。元入力/cursor/TOML hash不変、全Show idle・service open/drained。初回構築job準備へ。')


def prepare(mode):
    global E
    E = BASE / mode
    E.mkdir(exist_ok=False)
    assert hashes() == json.loads((BASE / 'baseline-hashes.json').read_text())
    assert digest(CLI) == json.loads((BASE / 'build-identity.json').read_text())['cli_sha256']
    for name in ('build-identity.json', 'installed-worker.json'):
        shutil.copy2(BASE / name, E / name)
    state = idle('before')
    assert state['worker_version_id'] == json.loads((BASE / 'installed-worker.json').read_text())['worker_version_id']
    cli('before-episode', 'target-episode', 'otftalk-rss', EPISODE)
    r2get('before-metadata-private.toml', f'public/episodes/otftalk-rss/{EPISODE}/metadata.toml')
    feed('before-feed-private')
    script = '''import { parseEpisodeDraft, parseEpisodeRevision } from "./packages/shared/src/index";
import { readFileSync } from "node:fs";
const draft = parseEpisodeDraft(readFileSync(process.argv[1], "utf8"));
const revision = parseEpisodeRevision(readFileSync(process.argv[2], "utf8"));
for (const [key, value] of Object.entries(draft)) if (JSON.stringify(value) !== JSON.stringify(revision[key])) throw new Error("Metadata differs: " + key);
console.log(JSON.stringify({ unchanged_normalized_draft: true }));'''
    run('verify-input', ['bun', '-e', script, str(W / 'otftalk-rss' / ('episode-' + EPISODE + '.toml')),
        str(E / 'before-metadata-private.toml')], cwd=S)
    if mode == 'initial-catalog':
        control = json.loads(r2get('before-show-control-private.json', 'system/show-publications/otftalk-rss.json'))
        assert not control.get('episode_catalog_initialized', False) and control.get('owner') is None
        assert r2get('before-catalog-private.json', 'public/podcasts/otftalk-rss/episode-catalog.json', allow_missing=True) is None
    else:
        assert all(json.loads((BASE / 'initial-catalog/preservation.json').read_text()).values())
        assert json.loads((BASE / 'initial-catalog/tail-closed.json').read_text())['success']
        catalog('before')
    save('selection.json', {'mode': mode, 'show_id': 'otftalk-rss', 'episode_id': EPISODE, 'episode_count': 36,
        'unchanged_metadata_only': True})


def measure(mode):
    prepare(mode)
    with (E / 'tail.stdout').open('wb') as out, (E / 'tail.stderr').open('wb') as err:
        proc = subprocess.Popen(['bun', str(ROOT / 'diagnostics/rss-performance-tail.ts'), str(E)], cwd=ROOT, stdout=out, stderr=err)
        try:
            deadline = time.monotonic() + 90
            while not (E / 'tail-ready.json').exists():
                if proc.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError('Worker logs unavailable; stop before publication')
                time.sleep(0.2)
            cli('measured-metadata-stage', 'update-episode', EPISODE, cwd=W / 'otftalk-rss')
            result = cli('measured-publication-commit', 'publish-episode', EPISODE, cwd=W / 'otftalk-rss')
            assert result['result'] == 'publication-committed'
            save('measured-job.json', result)
            index = wait_for_publication(lambda index: cli(f'measured-poll-{index:03}', 'operation-status',
                'publication', result['job_id'], allow_read_conflict=True), time.monotonic, time.sleep)
            save('completion.json', {'job_id': result['job_id'], 'observed_at_ms': time.time_ns() // 1_000_000, 'poll_index': index})
            for index in range(20):
                state = cli(f'after-drain-{index:02}', 'service-status')
                assert state['admission']['state'] == 'open'
                if state['admission']['invocations'] == []:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('Service invocation did not drain')
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if proc.poll() is not None or (E / 'tail-unexpected-close.json').exists() or (E / 'tail-capture-error.json').exists():
                    raise RuntimeError('Log capture interrupted; do not replay publication')
                rows = [json.loads(line) for line in (E / 'worker-logs.jsonl').read_text().splitlines()] if (E / 'worker-logs.jsonl').exists() else []
                if any(row.get('job_id') == result['job_id'] and row.get('phase') == 'publication.consumer'
                        for invocation in rows for row in invocation['logs']):
                    break
                time.sleep(0.5)
            else:
                raise RuntimeError('Consumer phase log missing; do not replay')
        finally:
            (E / 'tail-stop').write_text('Stop only this diagnostic stream\n')
            code = proc.wait(timeout=90)
            (E / 'tail.exit-code').write_text(str(code) + '\n')
            if code:
                raise RuntimeError('Worker logs process failed')
    idle('after')
    r2get('after-metadata-private.toml', f'public/episodes/otftalk-rss/{EPISODE}/metadata.toml')
    assert metadata_normalized((E / 'before-metadata-private.toml').read_text()) == metadata_normalized((E / 'after-metadata-private.toml').read_text())
    assert feed('after-feed-private') == (E / 'before-feed-private.body-private').read_bytes()
    assert hashes() == json.loads((BASE / 'baseline-hashes.json').read_text())
    value = catalog('after', result['job_id'])
    if mode == 'normal-update':
        before = json.loads((E / 'before-catalog-private.json').read_text())
        indexed = lambda source: {row['revision']['episode_id']: row for row in source['entries']}
        old, new = indexed(before), indexed(value)
        assert old.keys() == new.keys()
        for episode, entry in old.items():
            if episode != EPISODE:
                assert entry == new[episode], 'Unchanged catalog Episode changed'
            else:
                assert entry['active'] == new[episode]['active']
                normalize = lambda row: {key: val for key, val in row.items() if key not in ('revision_id', 'updated_at')}
                assert normalize(entry['revision']) == normalize(new[episode]['revision'])
        assert value['feed_generation'] == before['feed_generation'] + 1
    public('public-catalog-404', '/podcasts/otftalk-rss/episode-catalog.json', expected=404)
    domains = cli('final-domains', 'domain', 'list')
    assert domains['configuration_matches'] and domains['connections_match'] and domains['local_operations'] == []
    save('preservation.json', {'feed_byte_unchanged': True, 'metadata_except_revision_updated_at_unchanged': True,
        'inputs_cursor_local_toml_unchanged': True, 'service_open_drained': True, 'all_shows_idle': True,
        'domains_match': True, 'catalog_consistent': True, 'catalog_public_404': True})
    log(mode + ' job ' + result['job_id'] + ' published/released、service invocation解放、consumer終了ログ取得、今回tailのみ終了。Feed byte/metadata/元入力cursorTOML不変、36件カタログ世代/job整合・公開404、domain整合確認。')


if __name__ == '__main__':
    try:
        stage = sys.argv[1]
        if stage == 'build':
            build()
        elif stage == 'install':
            install()
        elif stage in ('initial-catalog', 'normal-update'):
            measure(stage)
        else:
            raise RuntimeError('Unknown stage')
    except Exception:
        if BASE.exists():
            log('試験段階 ' + sys.argv[1] + ' で停止。原本stderr/証跡/記録/ownerを保持、変更要求の再送/強制解放はしない。')
        raise
