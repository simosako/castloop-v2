import datetime
import json
import os
from pathlib import Path
import subprocess
import time
import tomllib
from urllib.request import Request, urlopen

R = Path('[LOCAL_TEST_ROOT]')
E = R / 'evidence/rss-import-retest-a19efb4/timing-investigation'
W = R / 'workspaces/rss-20261012-run1'
J = R / 'evidence/rss-import-retest-a19efb4/private-after-journals'
os.umask(0o077)
E.mkdir(exist_ok=False)
base = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/r2/buckets/castloop-rss-20261012-run1/objects/'
rows = []
uploads = {}
for p in (J / 'staging-uploads').rglob('*.json'):
    v = json.loads(p.read_text())['upload']
    uploads.setdefault(v['draft_job_id'], []).append({'created_at': v['created_at'], 'assets': [x['asset'] for x in v['payloads']],
        'bytes': sum(x['length_bytes'] for x in v['payloads']), 'journal_finished_at': datetime.datetime.fromtimestamp(p.stat().st_mtime, datetime.timezone.utc).isoformat()})
for p in (J / 'publication-jobs').rglob('*.json'):
    v = json.loads(p.read_text())['publication']['request']
    if v['created_at'] < '2026-10-12T02:04:00Z':
        continue
    job = v['job_id']
    start = time.monotonic()
    with urlopen(Request(base + f'system/jobs/{job}/progress.toml', headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']}), timeout=60) as response:
        data = response.read()
        headers = {k: response.headers.get(k) for k in ['Last-Modified', 'CF-Ray', 'Date']}
    (E / (job + '-progress.toml')).write_bytes(data)
    progress = tomllib.loads(data.decode())
    rows.append({'job_id': job, 'publication_created_at': v['created_at'],
        'commit_ack_local_mtime': datetime.datetime.fromtimestamp(p.stat().st_mtime, datetime.timezone.utc).isoformat(),
        'progress_updated_at': progress['updated_at'], 'phase': progress['phase'], 'purge_confirmed': progress['purge_confirmed'],
        'uploads': uploads[job], 'rest_read_seconds': round(time.monotonic() - start, 3), 'response_headers': headers})
(E / 'timeline.json').write_text(json.dumps(sorted(rows, key=lambda x: x['publication_created_at']), indent=2) + '\n')
measurements = []
for name, args in [('service', ['service-status']), ('target', ['target-show', 'otftalk-rss']), ('publication', ['operation-status', 'publication', '9c26524d-d0d1-4d2d-85eb-024f2a5ccf01'])]:
    start = time.monotonic()
    with (E / (name + '.stdout')).open('wb') as out, (E / (name + '.stderr')).open('wb') as err:
        p = subprocess.run([str(R / 'bin/castloop-linux-x64-a19efb4'), *args], cwd=W, stdout=out, stderr=err)
    measurements.append({'command': name, 'elapsed_seconds': round(time.monotonic() - start, 3), 'exit_code': p.returncode})
    if p.returncode:
        (E / 'readonly-command-timings.json').write_text(json.dumps(measurements, indent=2) + '\n')
        raise RuntimeError(name + ' read failed; stop')
(E / 'readonly-command-timings.json').write_text(json.dumps(measurements, indent=2) + '\n')
print(json.dumps(measurements, indent=2))
