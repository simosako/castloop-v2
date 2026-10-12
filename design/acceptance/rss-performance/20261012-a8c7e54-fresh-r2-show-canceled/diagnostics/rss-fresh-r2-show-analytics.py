import datetime
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2/show-investigation'
worker = 'castloop-rssperf-1012-r2-0f9dbe46'
os.umask(0o077)
assert not (E / 'graphql-query-status.json').exists(), 'Preserve earlier query'
query = '''query ShowPublicationMetrics($accountTag: String!, $since: Time!, $until: Time!, $worker: String!) {
  viewer { accounts(filter: {accountTag: $accountTag}) {
    workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: $since, datetime_leq: $until, scriptName: $worker}) {
      dimensions { datetime scriptName status }
      sum { requests errors }
    }
  } }
}'''
start = json.loads((E.parent / 'publish-import.elapsed.json').read_text())['started_at_ms']
since = datetime.datetime.fromtimestamp(start / 1000 - 60, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
until = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
payload = {'query': query, 'variables': {'accountTag': os.environ['CLOUDFLARE_ACCOUNT_ID'], 'since': since, 'until': until, 'worker': worker}}
request = Request('https://api.cloudflare.com/client/v4/graphql', data=json.dumps(payload).encode(),
    headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'], 'Content-Type': 'application/json'}, method='POST')
try:
    with urlopen(request, timeout=60) as response:
        raw = response.read(); status = response.status
except HTTPError as error:
    raw = error.read(); status = error.code
(E / 'graphql-response-private.json').write_bytes(raw)
data = json.loads(raw)
summary = {'http_status': status, 'read_only_analytics_query': True, 'from': since, 'to': until,
    'worker': worker, 'error_count': len(data.get('errors') or []), 'settings_changed': False, 'retries': 0}
if status == 200 and not data.get('errors'):
    rows = data['data']['viewer']['accounts'][0]['workersInvocationsAdaptive']
    summary['row_count'] = len(rows)
    summary['non_ok_rows'] = [row for row in rows if row['dimensions']['status'] != 'ok' or row['sum']['errors']]
(E / 'graphql-query-status.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
