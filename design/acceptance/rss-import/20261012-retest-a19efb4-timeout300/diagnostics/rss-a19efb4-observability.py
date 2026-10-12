import datetime
import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

E = Path('[LOCAL_TEST_ROOT]/evidence/rss-import-retest-a19efb4/timing-investigation')
os.umask(0o077)
base = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID']
worker = 'castloop-rsstest-1012-r1-acb1fbca'

def call(label, path, body=None):
    assert not (E / (label + '.json')).exists()
    headers = {'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    request = Request(base + path, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urlopen(request, timeout=60) as response:
            data = response.read()
            status = response.status
    except HTTPError as error:
        data = error.read()
        status = error.code
    (E / (label + '.json')).write_bytes(data)
    (E / (label + '.http-status')).write_text(str(status) + '\n')
    value = json.loads(data)
    if status != 200 or value.get('success') is False:
        print(label, 'HTTP', status, 'failed; no retries or settings changes')
        raise RuntimeError('Read-only inspection failed; inspect private evidence')
    return value.get('result')

settings = call('worker-settings-private', '/workers/scripts/' + worker + '/settings')
print('Worker observability:', json.dumps(settings.get('observability')))
if settings.get('observability', {}).get('enabled') is not True:
    print('Historical logs are not enabled; do not change settings')
else:
    ms = lambda t: int(datetime.datetime.fromisoformat(t.replace('Z', '+00:00')).timestamp() * 1000)
    value = call('telemetry-private', '/workers/observability/telemetry/query', {
        'queryId': str(uuid.uuid4()), 'dry': True, 'view': 'invocations', 'limit': 100,
        'timeframe': {'from': ms('2026-10-12T02:04:00Z'), 'to': ms('2026-10-12T02:42:00Z')},
        'parameters': {'filters': [{'key': '$metadata.service', 'operation': 'eq', 'type': 'string', 'value': worker}], 'filterCombination': 'and'}})
    print('telemetry result keys:', list(value))
