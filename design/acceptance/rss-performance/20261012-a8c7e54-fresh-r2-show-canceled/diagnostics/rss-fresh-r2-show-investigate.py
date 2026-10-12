import datetime
import importlib.util
import json
from pathlib import Path
import sys
import tomllib
from urllib.error import HTTPError
import urllib.parse
from urllib.request import Request, urlopen
import os

ROOT = Path('[LOCAL_TEST_ROOT]')
spec = importlib.util.spec_from_file_location('fresh', ROOT / 'diagnostics/rss-performance-fresh-r2.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
E = h.BASE / 'show-investigation'
JOB = '69a619df-9115-42e8-87db-e98947635863'
os.umask(0o077)


def get_r2(name, key, optional=False):
    url = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/r2/buckets/' + h.BUCKET + '/objects/' + urllib.parse.quote(key, safe='/')
    try:
        with urlopen(Request(url, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']}), timeout=60) as response:
            data = response.read()
            etag = response.headers.get('etag')
    except HTTPError as error:
        if optional and error.code == 404:
            h.m.save(name + '.missing.json', {'expected_or_possible_missing': True, 'http_status': 404})
            return None
        raise
    (E / name).write_bytes(data)
    return {'bytes': len(data), 'etag': etag}


def snapshot():
    E.mkdir(exist_ok=False)
    h.m.E = E
    h.m.log('ユーザー承認: 新規r2 Show公開jobの長時間processing/heldを調査。GETとローカル解析のみ、変更再送/owner解除は行わない。')
    status = h.cli('current-job', 'operation-status', 'publication', JOB, allow_read_conflict=True)
    service = h.cli('current-service', 'service-status')
    show = h.cli('current-show', 'target-show', 'otftalk-rss')
    summary = {'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'job_id': JOB,
        'job_status': (status['server_status'].get('status') or {}).get('state') if status else None,
        'job_phase': (status['server_status'].get('status') or {}).get('phase') if status else None,
        'ownership': status['server_status']['ownership'] if status else None,
        'service_state': service['admission']['state'], 'invocation_count': len(service['admission']['invocations']),
        'unfinished_show_operation': show['unfinished_show_operation'], 'worker_version_id': service['worker_version_id']}
    for name, key, optional in [
            ('status-private.toml', f'system/jobs/{JOB}/status.toml', False),
            ('progress-private.toml', f'system/jobs/{JOB}/progress.toml', False),
            ('show-control-private.json', 'system/show-publications/otftalk-rss.json', False),
            ('service-admission-private.json', 'system/lifecycle-service.json', False),
            ('catalog-private.json', 'public/podcasts/otftalk-rss/episode-catalog.json', True),
            ('feed-private.xml', 'public/podcasts/otftalk-rss/feed.xml', True),
            ('show-metadata-private.toml', 'system/shows/otftalk-rss/show.toml', True),
            ('cover-private.jpg', 'public/podcasts/otftalk-rss/cover.jpg', True)]:
        value = get_r2(name, key, optional)
        summary[name] = value or {'missing': True}
    progress = tomllib.loads((E / 'progress-private.toml').read_text())
    stored_status = tomllib.loads((E / 'status-private.toml').read_text())
    control = json.loads((E / 'show-control-private.json').read_text())
    summary['stored_status_phase'] = stored_status.get('phase')
    summary['stored_status_state'] = stored_status.get('state')
    summary['progress'] = {key: progress.get(key) for key in ['phase', 'updated_at', 'purge_confirmed', 'deleted_objects']}
    summary['show_lifecycle'] = control['lifecycle']
    summary['feed_generation'] = control['feed_generation']
    summary['catalog_initialized'] = control.get('episode_catalog_initialized', False)
    owner = control.get('owner')
    summary['owner'] = {key: owner.get(key) for key in ['job_id', 'kind', 'action', 'state']} if owner else None
    summary['execution_id_present'] = bool(owner and owner.get('execution_id'))
    summary['verification_id_present'] = bool(owner and owner.get('verification_id'))
    h.m.save('snapshot-summary.json', summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    snapshot()
