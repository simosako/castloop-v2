import datetime
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2/show-investigation'
WORKER = 'castloop-rssperf-1012-r2-0f9dbe46'
os.umask(0o077)
assert not (E / 'historical-logs-summary.json').exists(), 'Preserve earlier query'
milliseconds = lambda value: int(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
payload = {
    'queryId': str(uuid.uuid4()), 'dry': True, 'view': 'invocations', 'limit': 100,
    'timeframe': {'from': milliseconds('2026-10-12T11:34:00Z'), 'to': milliseconds('2026-10-12T11:36:00Z')},
    'parameters': {
        'filters': [{'key': '$metadata.service', 'operation': 'eq', 'type': 'string', 'value': WORKER}],
        'filterCombination': 'and'}}
(E / 'historical-logs-query.json').write_text(json.dumps(payload, indent=2) + '\n')
url = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/workers/observability/telemetry/query'
request = Request(url, data=json.dumps(payload).encode(), method='POST', headers={
    'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'], 'Content-Type': 'application/json'})
try:
    with urlopen(request, timeout=60) as response:
        raw = response.read()
        status = response.status
except HTTPError as error:
    raw = error.read()
    status = error.code
(E / 'historical-logs-private.json').write_bytes(raw)
data = json.loads(raw)
summary = {'http_status': status, 'success': data.get('success'), 'dry': True,
    'worker': WORKER, 'settings_changed': False, 'retries': 0,
    'error_codes': [error.get('code') for error in data.get('errors', [])],
    'result_keys': list(data.get('result', {})) if isinstance(data.get('result'), dict) else []}
(E / 'historical-logs-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
