import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2/show-investigation'
WORKER = 'castloop-rssperf-1012-r2-0f9dbe46'
os.umask(0o077)
assert not (E / 'graphql-timing-summary.json').exists(), 'Preserve earlier query'
source = '''query ShowPublicationTiming($accountTag: String!, $worker: String!) {
  viewer { accounts(filter: {accountTag: $accountTag}) {
    workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: "2026-10-12T11:34:00Z", datetime_leq: "2026-10-12T11:36:00Z", scriptName: $worker}) {
      dimensions { datetime status coloCode scriptVersion usageModel }
      sum { requests errors cpuTimeUs wallTime subrequests clientDisconnects }
    }
  } }
}'''
request = Request('https://api.cloudflare.com/client/v4/graphql', method='POST',
    data=json.dumps({'query': source, 'variables': {'accountTag': os.environ['CLOUDFLARE_ACCOUNT_ID'], 'worker': WORKER}}).encode(),
    headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'], 'Content-Type': 'application/json'})
try:
    with urlopen(request, timeout=60) as response:
        raw, status = response.read(), response.status
except HTTPError as error:
    raw, status = error.read(), error.code
(E / 'graphql-timing-private.json').write_bytes(raw)
data = json.loads(raw)
summary = {'http_status': status, 'error_count': len(data.get('errors') or []), 'read_only': True,
    'units': {'cpuTimeUs': 'microseconds', 'wallTime': 'raw API value; unit not established by schema description'},
    'limitations': 'Invocation kind and job ID unavailable. Row metrics are aggregated; dates are request timestamps, not exception occurrence timestamps.'}
if status == 200 and not data.get('errors'):
    rows = data['data']['viewer']['accounts'][0]['workersInvocationsAdaptive']
    summary['row_count'] = len(rows)
    summary['non_success_rows'] = sorted(
        [row for row in rows if row['dimensions']['status'] != 'success' or row['sum']['errors']],
        key=lambda row: row['dimensions']['datetime'])
(E / 'graphql-timing-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
