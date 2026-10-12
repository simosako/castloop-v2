import datetime
from email.utils import parsedate_to_datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tomllib
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-import-retest-dc33f75'
I = ROOT / 'imports/rss-20261012-run1'
BASE = 'https://castloop-rss-r1.otftalk.com'
HOST = urlsplit(BASE).hostname
IT = '{http://www.itunes.com/dtds/podcast-1.0.dtd}'
CONTENT = '{http://purl.org/rss/1.0/modules/content/}'
os.umask(0o077)
checks = []

def save(name, value):
    (E / name).write_text(json.dumps(value, indent=2) + '\n')

spec = importlib.util.spec_from_file_location('direct', ROOT / 'diagnostics/dns-direct.py')
dns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dns)
dns.HOST = HOST
answer = dns.query(1, 'UDP')
assert answer['rcode'] == 0 and not answer['truncated']
ip = next(a['address'] for a in answer['addresses'] if a['type'] == 'A')
save('public-dns-1111.json', answer)

def request(label, url, expected=200, method='GET', options=(), stream=False):
    headers_file = E / ('public-' + label + '.headers')
    assert not headers_file.exists(), 'Do not overwrite prior evidence'
    cmd = ['curl', '--disable', '--silent', '--show-error', '--noproxy', '*', '--resolve', f'{HOST}:443:{ip}',
           '--connect-timeout', '15', '--max-time', '180', '--dump-header', str(headers_file)]
    if method == 'HEAD': cmd += ['--head']
    cmd += list(options) + [url]
    with (E / ('public-' + label + '.stderr')).open('wb') as err:
        if stream:
            p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err)
            digest = hashlib.sha256()
            size = 0
            while block := p.stdout.read(1024 * 1024):
                digest.update(block)
                size += len(block)
            rc = p.wait()
            body = None
        else:
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=err)
            rc, body = p.returncode, p.stdout
            size = len(body)
            digest = hashlib.sha256(body)
    assert rc == 0, f'{label}: curl exit {rc}'
    lines = headers_file.read_text().splitlines()
    status = int(next(l for l in reversed(lines) if l.startswith('HTTP/')).split()[1])
    headers = {l.split(':', 1)[0].lower(): l.split(':', 1)[1].strip() for l in lines if ':' in l}
    assert status == expected, f'{label}: HTTP {status}'
    checks.append({'label': label, 'http': status, 'method': method, 'url': url, 'bytes': size,
                   'sha256': digest.hexdigest() if method != 'HEAD' else None})
    save('public-request-progress.json', checks)
    return body, headers, size, digest.hexdigest()

def description(item):
    encoded = item.findtext(CONTENT + 'encoded')
    return encoded if encoded is not None else item.findtext('description')

def text_hash(s):
    return hashlib.sha256(s.encode()).hexdigest()

try:
    result = json.loads((E / 'publication-result.json').read_text())
    assert result['episode_count'] == 36 and result['result'] == 'rss-import-published'
    feed_url = BASE + '/podcasts/otftalk-rss/feed.xml'
    body, feed_headers, _, _ = request('feed', feed_url)
    (E / 'public-feed.xml').write_bytes(body)
    channel = ET.fromstring(body).find('channel')
    source = ET.parse(I / 'source.xml').getroot().find('channel')
    show = tomllib.loads((I / 'show.toml').read_text())
    for field, tag in [('title', 'title'), ('description', 'description'), ('language', 'language'), ('site_url', 'link'),
                       ('author', IT + 'author'), ('owner_name', IT + 'owner/' + IT + 'name'),
                       ('owner_email', IT + 'owner/' + IT + 'email'), ('copyright', 'copyright'), ('show_type', IT + 'type')]:
        assert channel.findtext(tag) == show.get(field), 'Show metadata mismatch: ' + field
    assert channel.findtext('link') == 'https://www.otftalk.com/'
    assert [x.attrib['text'] for x in channel.findall(IT + 'category')] == show['categories']
    assert channel.findtext(IT + 'explicit') in ('true', 'false')
    assert (channel.findtext(IT + 'explicit') == 'true') == show['explicit']
    assert channel.find('{http://www.w3.org/2005/Atom}link').attrib['href'] == feed_url
    records = json.loads((ROOT / 'evidence/rss-import-20261012-run1/local-import-validation.json').read_text())
    items = channel.findall('item')
    assert len(items) == 36
    by_guid = {item.findtext('guid'): item for item in items}
    assert len(by_guid) == 36
    assert set(by_guid) == {x.findtext('guid') for x in source.findall('item')}
    for record in records['episodes']:
        item = by_guid[record['guid']]
        assert parsedate_to_datetime(item.findtext('pubDate')) == datetime.datetime.fromisoformat(record['published_at'].replace('Z', '+00:00'))
        assert (item.find('guid').attrib.get('isPermaLink', 'true') == 'true') == record['guid_is_permalink']
        assert text_hash(item.findtext('title')) == record['title_sha256']
        assert text_hash(description(item)) == record['description_sha256']
        draft = tomllib.loads((I / ('episode-' + record['episode_id'] + '.toml')).read_text())
        for field, tag in [('episode_type', IT + 'episodeType'), ('season_number', IT + 'season'), ('episode_number', IT + 'episode')]:
            value = item.findtext(tag)
            assert value == (str(draft[field]) if field in draft else None), 'Episode optional field mismatch'
        assert (item.findtext(IT + 'explicit') == 'true') == draft['explicit']
        enclosure = item.find('enclosure').attrib
        assert enclosure['type'] == 'audio/mpeg' and int(enclosure['length']) == record['bytes']
        audio_url = enclosure['url']
        assert audio_url.startswith(BASE + '/podcasts/otftalk-rss/episodes/' + record['episode_id'] + '/')
    save('rss-metadata-validation.json', {'passed': True, 'episode_count': 36, 'show_metadata': True,
         'guid_date_permalink_title_description_optional_fields': True, 'canonical_audio_urls': True})
    cover_url = channel.findtext('image/url')
    assert cover_url == channel.find(IT + 'image').attrib['href'] == BASE + '/podcasts/otftalk-rss/cover.jpg'
    _, _, cover_size, cover_hash = request('cover', cover_url, stream=True)
    assert cover_size == records['cover_bytes'] and cover_hash == records['cover_sha256']
    for n, record in enumerate(records['episodes']):
        url = by_guid[record['guid']].find('enclosure').attrib['url']
        _, head, _, _ = request(f'audio-{n:02d}-head', url, method='HEAD')
        assert int(head['content-length']) == record['bytes'] and head['content-type'] == 'audio/mpeg'
        _, get, size, digest = request(f'audio-{n:02d}-get', url, stream=True)
        assert size == record['bytes'] and digest == record['sha256'], 'Audio content mismatch'
        ranged, rh, size, _ = request(f'audio-{n:02d}-range', url, 206, options=['--range', '0-1023'])
        assert size == 1024 and rh['content-range'] == f'bytes 0-1023/{record["bytes"]}'
        with (I / (record['episode_id'] + '.mp3')).open('rb') as f:
            assert ranged == f.read(1024)
    worker = json.loads((E / 'deployed-domains.stdout').read_text())['workers_dev_base_url']
    wb, _, _, _ = request('workers-feed', worker + '/podcasts/otftalk-rss/feed.xml')
    assert wb == body
    _, _, size, _ = request('feed-304', feed_url, 304, options=['--header', 'If-None-Match: ' + feed_headers['etag']])
    assert size == 0
    request('system-denied', BASE + '/system/service.toml', 404)
    request('staging-denied', BASE + '/staging/shows/otftalk-rss/7d484a96-f681-41ad-b91d-c877fb858b7e/show.toml', 404)
    save('public-validation.json', {'passed': True, 'dns_server': '1.1.1.1', 'tls_verified': True, 'episode_count': 36,
         'all_audio_get_hash_size_head_range': True, 'audio_bytes': records['audio_bytes'], 'cover_hash_size': True,
         'same_feed_on_workers_dev': True, 'feed_conditional_304': True, 'private_paths_denied': True, 'requests': len(checks)})
    print('Public delivery checks passed:', len(checks), 'requests; all 36 MP3 hashes match')
except Exception as error:
    save('public-validation-failure.json', {'passed': False, 'error': str(error), 'completed_requests': len(checks)})
    raise
