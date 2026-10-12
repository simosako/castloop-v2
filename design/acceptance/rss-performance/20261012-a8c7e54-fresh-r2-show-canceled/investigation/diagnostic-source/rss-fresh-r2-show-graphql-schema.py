import json
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2/show-investigation'
os.umask(0o077)
assert not (E / 'graphql-schema-summary.json').exists(), 'Preserve earlier query'
headers = {'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN'], 'Content-Type': 'application/json'}


def query(label, source):
    request = Request('https://api.cloudflare.com/client/v4/graphql', method='POST',
        headers=headers, data=json.dumps({'query': source}).encode())
    try:
        with urlopen(request, timeout=60) as response:
            raw, status = response.read(), response.status
    except HTTPError as error:
        raw, status = error.read(), error.code
    (E / (label + '-private.json')).write_bytes(raw)
    data = json.loads(raw)
    assert status == 200 and not data.get('errors'), 'Schema inspection failed; no retry'
    return data['data']


types = query('graphql-schema-types', '{ __schema { types { name } } }')['__schema']['types']
names = [row['name'] for row in types if 'workersinvocationsadaptive' in row['name'].lower()]
details = {}
for index, name in enumerate(names):
    if 'dimensions' not in name.lower() and not name.lower().endswith('sum'):
        continue
    details[name] = query('graphql-schema-fields-' + str(index),
        '{ __type(name: ' + json.dumps(name) + ') { fields { name description type { name kind ofType { name kind } } } } }')['__type']
summary = {'type_names': names, 'field_details': details, 'read_only': True, 'settings_changed': False}
(E / 'graphql-schema-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
