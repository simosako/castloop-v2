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
spec = importlib.util.spec_from_file_location('measurement', ROOT / 'diagnostics/rss-performance-a8c7e54.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
BASE = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2'
W = ROOT / 'workspaces/rss-performance-20261012-r2'
I = ROOT / 'imports/rss-20261012-run1'
SERVICE = 'rssperf-1012-r2'
BUCKET = 'castloop-rss-perf-20261012-r2'
HOST = 'castloop-rss-perf-r2.otftalk.com'
m.BASE = m.E = BASE
m.W = W
m.CURSOR = W / '.castloop/rss-imports' / SERVICE / '908efe60-3585-4a6a-af01-f1c5d8afb206.json'
old_run = m.run


def run(name, args, cwd=W, parse=True, allow_read_conflict=False):
    return old_run(name, args, cwd=cwd, parse=parse, allow_read_conflict=allow_read_conflict)


def cli(name, *args, cwd=W, allow_read_conflict=False):
    return run(name, [str(m.CLI), *args], cwd=cwd, allow_read_conflict=allow_read_conflict)


def r2get(name, key, allow_missing=False):
    assert not allow_missing, 'No catalog deletion/rebuilding in fresh measurement'
    url = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/r2/buckets/' + BUCKET + '/objects/' + quote(key, safe='/')
    with urlopen(Request(url, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']}), timeout=60) as response:
        data = response.read()
    (m.E / name).write_bytes(data)
    return data


def public(name, path, expected=200):
    spec = importlib.util.spec_from_file_location('direct', ROOT / 'diagnostics/dns-direct.py')
    dns = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(dns)
    dns.HOST = HOST
    answer = dns.query(1, 'UDP')
    assert answer['rcode'] == 0 and not answer['truncated']
    ip = next(row['address'] for row in answer['addresses'] if row['type'] == 'A')
    m.save(name + '.dns.json', answer)
    body = m.E / (name + '.body-private')
    run(name, ['curl', '--disable', '--silent', '--show-error', '--noproxy', '*', '--resolve', HOST + ':443:' + ip,
        '--max-time', '60', '-H', 'Cache-Control: no-cache', '--output', str(body), '--write-out', '%{http_code}',
        'https://' + HOST + path], parse=False)
    assert (m.E / (name + '.stdout')).read_text() == str(expected)
    return body.read_bytes()


m.run, m.cli, m.r2get, m.public = run, cli, r2get, public


def inputs():
    return {str(p.relative_to(ROOT)): m.digest(p) for p in I.rglob('*') if p.is_file()}


def prepare():
    BASE.mkdir(exist_ok=False)
    assert not W.exists()
    W.mkdir()
    m.log('新規r2性能試験承認。本物36MP3/約1.5GBのrun1入力再利用、新service/独自hostへinit、旧updating環境には操作しない。test-plan-rss-performance-a8c7e54-fresh-r2.md。')
    identity = json.loads((ROOT / 'evidence/rss-performance-a8c7e54/build-identity.json').read_text())
    assert identity['commit'] == m.COMMIT and m.digest(m.CLI) == identity['cli_sha256']
    shutil.copy2(ROOT / 'evidence/rss-performance-a8c7e54/build-identity.json', BASE / 'build-identity.json')
    run('source-status', ['git', 'status', '--porcelain'], cwd=m.S, parse=False)
    assert not (BASE / 'source-status.stdout').read_text().strip()
    run('source-head', ['git', 'rev-parse', 'HEAD'], cwd=m.S, parse=False)
    assert (BASE / 'source-head.stdout').read_text().strip() == m.COMMIT
    baseline = json.loads((ROOT / 'evidence/rss-performance-a8c7e54/baseline-hashes.json').read_text())
    current = inputs()
    assert current == {key: val for key, val in baseline.items() if key.startswith('imports/')}
    m.save('input-before.json', current)
    m.save('selection.json', {'service_id': SERVICE, 'bucket_name': BUCKET, 'hostname': HOST,
        'episode_count': 36, 'audio_bytes': 1496055589, 'input_reused': True, 'old_environment_mutations': False})
    assert shutil.disk_usage(ROOT).free > 3_000_000_000
    os.environ.update(EVIDENCE=str(BASE), DOMAIN_HOST=HOST, SERVICE_ID=SERVICE, BUCKET_NAME=BUCKET)
    run('preflight', ['python', '-B', str(ROOT / 'preflight.py')], cwd=ROOT, parse=False)
    run('harness-tests', ['python', '-B', '-m', 'unittest', '-v', 'test_rss_performance_wait'], cwd=ROOT / 'diagnostics', parse=False)
    m.log('r2の未使用hostname/service/bucket/routeとactive/full ZoneをAPI GET確認。a8c7e54 CLI hash/source clean、元116file hash一致、helper6tests成功。新規init準備完了。')


def initialize():
    operation = str(uuid.uuid4())
    m.save('init-id.json', {'operation_id': operation})
    cli('init', 'init', '.', '--service-id', SERVICE, '--account-id', os.environ['CLOUDFLARE_ACCOUNT_ID'],
        '--bucket-name', BUCKET, '--workers-subdomain', 'simosako', '--operation-id', operation)
    status = cli('initialized-service', 'service-status')
    assert status['admission']['state'] == 'paused' and status['admission']['invocations'] == []
    assert status['external_episode_guids'] and status['admission']['runtime_readiness']['cutover_verified']
    m.save('installed-worker.json', {'commit': m.COMMIT, 'worker_version_id': status['worker_version_id'],
        'fresh_initialization': True, 'paused': True})


def domain(continuation=False):
    env = dict(os.environ, DOMAIN_HOST=HOST)
    prefix = 'dns-proxy-continued' if continuation else 'dns-proxy'
    ready = BASE / (prefix + '-ready.json')
    assert not ready.exists()
    with (BASE / (prefix + '.stdout')).open('wb') as out, (BASE / (prefix + '.stderr')).open('wb') as err:
        proc = subprocess.Popen(['python', '-B', str(ROOT / 'diagnostics/dns-tunnel.py'), str(ready),
            str(BASE / (prefix + '-connections.jsonl'))], env=env, stdout=out, stderr=err)
        try:
            deadline = time.monotonic() + 10
            while not ready.exists():
                assert proc.poll() is None and time.monotonic() < deadline
                time.sleep(.1)
            proxy = json.loads(ready.read_text())['proxy_url']
            os.environ.update(HTTPS_PROXY=proxy, https_proxy=proxy,
                NO_PROXY='api.cloudflare.com,.workers.dev,localhost,127.0.0.1',
                no_proxy='api.cloudflare.com,.workers.dev,localhost,127.0.0.1')
            if continuation:
                assert 'Domain DNS/TLS is not verified' in (BASE / 'domain-add.stderr').read_text()
                assert (BASE / 'domain-readiness-public.stdout').read_text() == '503'
                operation = json.loads((BASE / 'domain-id.json').read_text())['operation_id']
                m.log('DNS事前承認に従い1.1.1.1経由のDNS/TLS/paused503確認後、CLIが案内した同じdomain operationの検証だけを続行。未知変更の再送ではない。')
            else:
                operation = str(uuid.uuid4())
                m.save('domain-id.json', {'operation_id': operation})
            cli('domain-add-continued' if continuation else 'domain-add', 'domain', 'add', HOST, '--operation-id', operation)
        finally:
            proc.terminate()
            proc.wait(timeout=20)
            for key in ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']:
                os.environ.pop(key, None)
            m.save(prefix + '-closed.json', {'closed': True, 'tls_terminated': False, 'os_dns_changed': False})
    domains = cli('deployed-domains', 'domain', 'list')
    assert domains['configuration_matches'] and domains['connections_match'] and not domains['local_operations']
    status = cli('domain-paused-service', 'service-status')
    assert status['admission']['state'] == 'paused' and not status['admission']['invocations']
    cli('resume', 'service-resume', status['admission']['pause_id'])
    status = cli('open-service', 'service-status')
    assert status['admission']['state'] == 'open' and not status['admission']['invocations']
    m.log('新規a8c7e54 Worker/init・新独自domain追加・明示resume完了。TLS透過1.1.1.1 tunnelのみ終了、旧環境/権限/OS DNSに変更なし。36件を元入力から公開する。')


def publish():
    assert inputs() == json.loads((BASE / 'input-before.json').read_text())
    try:
        result = cli('publish-import', 'publish-rss-import', str(I))
        assert result['result'] == 'rss-import-published' and result['episode_count'] == 36
        m.save('publication-result.json', result)
    finally:
        if m.CURSOR.exists():
            m.save('cursor-after-publish.json', json.loads(m.CURSOR.read_text()))
        m.save('input-preservation.json', {'all_116_files_unchanged': inputs() == json.loads((BASE / 'input-before.json').read_text())})
    assert json.loads(m.CURSOR.read_text())['phase'] == 'completed'
    m.idle('published')
    m.catalog('published')
    m.public('catalog-public-404', '/podcasts/otftalk-rss/episode-catalog.json', 404)
    m.log('新規r2で本物36件publish-rss-import成功、completed cursor/input hash不変、service open/drained・全Show idle、36件catalog整合と公開404。独立配信照合・通常更新性能測定へ。')


def checks():
    folder = BASE / 'delivery-checks'
    folder.mkdir(exist_ok=False)
    for name in ['publication-result.json', 'deployed-domains.stdout']:
        shutil.copy2(BASE / name, folder / name)
    os.environ.update(RSS_RETEST_EVIDENCE=str(folder), RSS_RETEST_BASE='https://' + HOST, RSS_RETEST_SAMPLE_ONLY='1')
    run('delivery-checks', ['python', '-B', str(ROOT / 'diagnostics/rss-retest-public-checks.py')], cwd=ROOT, parse=False)
    assert json.loads((folder / 'public-validation.json').read_text())['passed']
    assert inputs() == json.loads((BASE / 'input-before.json').read_text())
    m.save('baseline-hashes.json', m.hashes())
    m.save('fresh-ready.json', {'36_episode_publication_complete': True, 'public_validation_passed': True,
        'original_inputs_preserved': True, 'catalog_built_during_initial_publication': True})
    m.log('r2全36RSS metadata/GUID/日時/新URL/length照合、coverと代表2MP3全量GET/hash/HEAD/Range・304/private404成功。全音源はCLI全量upload/readback済み、独立再GETは2件のみ。構築済み36件カタログで通常更新1jobの性能測定準備完了。')


def prepare_measure(mode):
    assert mode == 'normal-update'
    assert all(json.loads((BASE / 'fresh-ready.json').read_text()).values())
    m.E = BASE / mode
    m.E.mkdir(exist_ok=False)
    assert m.hashes() == json.loads((BASE / 'baseline-hashes.json').read_text())
    identity = json.loads((BASE / 'build-identity.json').read_text())
    assert m.digest(m.CLI) == identity['cli_sha256']
    for name in ['build-identity.json', 'installed-worker.json']:
        shutil.copy2(BASE / name, m.E / name)
    state = m.idle('before')
    assert state['worker_version_id'] == json.loads((BASE / 'installed-worker.json').read_text())['worker_version_id']
    config = tomllib.loads((W / 'castloop.toml').read_text())
    os.environ['CASTLOOP_PERF_TAIL_WORKER'] = config['worker_name']
    shutil.copytree(W, m.E / 'private-workspace-backup')
    cli('before-episode', 'target-episode', 'otftalk-rss', m.EPISODE)
    r2get('before-metadata-private.toml', f'public/episodes/otftalk-rss/{m.EPISODE}/metadata.toml')
    m.feed('before-feed-private')
    script = '''import { parseEpisodeDraft, parseEpisodeRevision } from "./packages/shared/src/index";
import { readFileSync } from "node:fs";
const draft = parseEpisodeDraft(readFileSync(process.argv[1], "utf8"));
const revision = parseEpisodeRevision(readFileSync(process.argv[2], "utf8"));
for (const [key, value] of Object.entries(draft)) if (JSON.stringify(value) !== JSON.stringify(revision[key])) throw new Error("Metadata differs: " + key);
console.log(JSON.stringify({ unchanged_normalized_draft: true }));'''
    run('verify-input', ['bun', '-e', script, str(W / 'otftalk-rss' / ('episode-' + m.EPISODE + '.toml')),
        str(m.E / 'before-metadata-private.toml')], cwd=m.S)
    m.catalog('before')
    m.save('selection.json', {'mode': mode, 'show_id': 'otftalk-rss', 'episode_id': m.EPISODE, 'episode_count': 36,
        'unchanged_metadata_only': True, 'fresh_service': True, 'cold_catalog_construction_measured': False,
        'worker_name': config['worker_name']})
    snapshot = m.E / 'harness-source'
    snapshot.mkdir()
    for name in ['rss-performance-fresh-r2.py', 'rss-performance-a8c7e54.py', 'rss-performance-tail.ts',
            'rss_performance_wait.py', 'test_rss_performance_wait.py']:
        shutil.copy2(ROOT / 'diagnostics' / name, snapshot / name)


def measure():
    m.prepare = prepare_measure
    m.measure('normal-update')


if __name__ == '__main__':
    try:
        stage = sys.argv[1]
        {'prepare': prepare, 'init': initialize, 'domain': domain,
            'domain-continue': lambda: domain(True), 'publish': publish,
            'checks': checks, 'measure': measure}[stage]()
    except Exception:
        if BASE.exists():
            m.log('新規r2の ' + sys.argv[1] + ' 段階で停止。変更要求は再送せず原本/journal/owner保持。')
        raise
