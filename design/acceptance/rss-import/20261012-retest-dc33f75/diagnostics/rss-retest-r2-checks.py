import hashlib
import json
import os
from pathlib import Path
import sys
import tomllib
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-import-retest-dc33f75'
I = ROOT / 'imports/rss-20261012-run1'
os.umask(0o077)
dest = E / sys.argv[1]
dest.mkdir(exist_ok=False)
base = 'https://api.cloudflare.com/client/v4/accounts/' + os.environ['CLOUDFLARE_ACCOUNT_ID'] + '/r2/buckets/castloop-rss-20261012-run1/objects'

def get(suffix):
    with urlopen(Request(base + suffix, headers={'Authorization': 'Bearer ' + os.environ['CLOUDFLARE_API_TOKEN']}), timeout=120) as response:
        assert not response.headers.get('cf-r2-list-cursor'), 'Unexpected pagination; stop'
        return response.read()

def listing(prefix):
    data = json.loads(get('?' + urlencode({'prefix': prefix, 'limit': 1000})))
    assert data['success'] and isinstance(data['result'], list) and len(data['result']) < 1000
    assert not data.get('result_info', {}).get('cursor'), 'Unexpected pagination; stop'
    return sorted(x['key'] for x in data['result'])

try:
    keys = listing('public/episodes/otftalk-rss/')
    assert len(keys) == 72, 'Expected exactly one current and one revision per 36 Episodes'
    media = listing('public/podcasts/otftalk-rss/episodes/')
    assert len(media) == 36
    hashes = {}
    by_id = {x['metadata']['episode_id']: x['metadata'] for x in json.loads((I / 'import.json').read_text())['episodes']}
    for key in keys:
        assert key.endswith('.toml') and '..' not in key.split('/')
        data = get('/' + quote(key, safe='/'))
        target = dest / key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        revision = tomllib.loads(data.decode())
        original = by_id[revision['episode_id']]
        for field in ('guid', 'published_at', 'guid_is_permalink', 'title', 'description', 'explicit', 'episode_type', 'season_number', 'episode_number'):
            assert revision.get(field) == original.get(field), 'R2 metadata mismatch: ' + field
        expected_media = 'public/podcasts/otftalk-rss/episodes/' + revision['episode_id'] + '/' + revision['revision_id'] + '.mp3'
        assert expected_media in media
        hashes[key] = hashlib.sha256(data).hexdigest()
    for key in keys:
        if key.endswith('/metadata.toml'):
            data = (dest / key).read_bytes()
            revision = tomllib.loads(data.decode())
            revision_key = key.removesuffix('metadata.toml') + 'revisions/' + revision['revision_id'] + '.toml'
            assert data == (dest / revision_key).read_bytes()
    summary = {'passed': True, 'episode_count': 36, 'keys': keys, 'media_keys': media, 'sha256': hashes,
               'current_revision_equal': True, 'single_revision_per_episode': True, 'method': 'read-only Cloudflare REST'}
    (dest / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    if sys.argv[1] != 'r2-import-completed':
        before = json.loads((E / 'r2-import-completed/summary.json').read_text())
        assert summary == before, 'Current/revision/media inventory changed'
    print('R2 current/revision identity check passed: 36 Episodes, 36 immutable MP3 objects')
except Exception as error:
    (dest / 'failure.json').write_text(json.dumps({'passed': False, 'error': str(error)}) + '\n')
    raise
