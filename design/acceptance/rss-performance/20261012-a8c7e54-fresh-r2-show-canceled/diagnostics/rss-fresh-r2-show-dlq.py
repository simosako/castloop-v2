import importlib.util
import json
import os
from pathlib import Path

ROOT = Path('[LOCAL_TEST_ROOT]')
spec = importlib.util.spec_from_file_location('inspection', ROOT / 'diagnostics/rss-fresh-r2-show-investigate.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
os.umask(0o077)
assert not (h.E / 'dlq-summary.json').exists(), 'Preserve earlier DLQ query'
h.h.m.E = h.E
result = h.get_r2('dlq-private.json', f'system/jobs/{h.JOB}/dlq.json', True)
marker = json.loads((h.E / 'dlq-private.json').read_text()) if result else None
summary = {'read_only': True, 'marker_present': marker is not None,
    'matches_commit_key': marker == {'key': f'staging/shows/otftalk-rss/{h.JOB}/commit.json'} if marker else None,
    'queue_pull_or_acknowledgement_performed': False}
(h.E / 'dlq-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
