import collections
import json
from pathlib import Path

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2/show-investigation'
destination = E / 'graphql-corrected-summary.json'
assert not destination.exists(), 'Preserve earlier review'
data = json.loads((E / 'graphql-response-private.json').read_text())
assert not data.get('errors')
rows = data['data']['viewer']['accounts'][0]['workersInvocationsAdaptive']
counts = collections.defaultdict(lambda: {'requests': 0, 'errors': 0, 'rows': 0})
for row in rows:
    status = row['dimensions']['status']
    for key in ['requests', 'errors']:
        counts[status][key] += row['sum'][key]
    counts[status]['rows'] += 1
summary = {
    'source': 'graphql-response-private.json',
    'correction': 'Cloudflare reports success, not ok. Original query summary retained unchanged.',
    'network_queries_in_this_review': 0,
    'row_count': len(rows),
    'by_status': dict(counts),
    'non_success_rows': sorted(
        [row for row in rows if row['dimensions']['status'] != 'success' or row['sum']['errors']],
        key=lambda row: row['dimensions']['datetime']),
    'limitation': 'No job ID or invocation kind in these dimensions. Errors are not conclusively attributed to this job.'}
destination.write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
