import collections
import datetime
import hashlib
import json
import os
from pathlib import Path

ROOT = Path('[LOCAL_TEST_ROOT]')
SOURCE = ROOT / 'logs-2026-10-12T12_14_27.128Z.json'
E = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2/show-investigation/dashboard-targeted-review'
JOB = '69a619df-9115-42e8-87db-e98947635863'
WORKER = 'castloop-rssperf-1012-r2-0f9dbe46'
DLQ = 'castloop-rssperf-1012-r2-dlq-0f9dbe46'
BUSY_MESSAGE = 'Another invocation still owns this lifecycle execution'
os.umask(0o077)
assert not E.exists(), 'Preserve earlier review'
raw = SOURCE.read_bytes()
rows = json.loads(raw)
assert isinstance(rows, list)
by_request = collections.defaultdict(list)
for index, row in enumerate(rows):
    request = row.get('$metadata', {}).get('requestId')
    if request:
        by_request[request].append((index, row))
deliveries = sorted([
    (index, row) for index, row in enumerate(rows)
    if row.get('source', {}).get('event') == 'publication_delivery'
    and row['source'].get('job_id') == JOB], key=lambda item: item[1]['source']['attempts'])
assert len(deliveries) == 3
attempts = []
safe_records = []
allowed = ['event', 'job_id', 'phase', 'outcome', 'started_at', 'finished_at', 'duration_ms',
    'delivered_at', 'message_timestamp', 'attempts']
for index, delivery in deliveries:
    request = delivery['$metadata']['requestId']
    group = by_request[request]
    invocations = [(i, row) for i, row in group if row.get('$workers', {}).get('eventType') == 'queue'
        and row.get('$workers', {}).get('outcome') is not None]
    assert len(invocations) == 1
    invocation_index, invocation = invocations[0]
    worker = invocation['$workers']
    assert worker['scriptName'] == WORKER and worker['event']['queue'] == WORKER
    errors = [(i, row) for i, row in group if 'exception' in row.get('source', {})]
    attempt = {'attempts': delivery['source']['attempts'], 'delivery_row_index_zero_based': index,
        'delivered_at': delivery['source']['delivered_at'], 'message_timestamp': delivery['source']['message_timestamp'],
        'invocation_row_index_zero_based': invocation_index, 'finished_at': invocation['timestamp'],
        'outcome': worker['outcome'], 'wall_time_ms': worker['wallTimeMs'], 'cpu_time_ms': worker['cpuTimeMs'],
        'correlation': 'Same requestId as the target job publication_delivery',
        'exception_record_count': len(errors),
        'execution_busy_confirmed': any(row['source'].get('message') == BUSY_MESSAGE for _, row in errors),
        'consumer_timing': [], 'invocation_release_timing': []}
    for i, row in group:
        source = row.get('source', {})
        worker_row = row.get('$workers', {})
        if worker_row.get('eventType') != 'queue':
            continue
        safe = {'row_index_zero_based': i, 'timestamp': row['timestamp'], 'attempts_group': attempt['attempts'],
            'invocation_outcome': worker_row.get('outcome'), 'wall_time_ms': worker_row.get('wallTimeMs'),
            'cpu_time_ms': worker_row.get('cpuTimeMs'),
            'structured': {key: source[key] for key in allowed if key in source}}
        if 'exception' in source:
            safe['exception_name'] = source['exception'].get('name') if isinstance(source['exception'], dict) else None
            safe['exception_message'] = BUSY_MESSAGE if source.get('message') == BUSY_MESSAGE else '[unclassified; retained only in original export]'
        safe_records.append(safe)
        if source.get('job_id') == JOB and source.get('phase') == 'publication.consumer':
            attempt['consumer_timing'].append(safe['structured'])
        if source.get('job_id') == JOB and source.get('phase') == 'publication.invocation_release':
            attempt['invocation_release_timing'].append(safe['structured'])
    attempts.append(attempt)
assert [attempt['outcome'] for attempt in attempts] == ['canceled', 'exception', 'exception']
assert not attempts[0]['consumer_timing'] and not attempts[0]['invocation_release_timing']
assert all(attempt['execution_busy_confirmed'] for attempt in attempts[1:])
dlq = [{'row_index_zero_based': i, 'timestamp': row['timestamp'], 'outcome': row['$workers']['outcome'],
    'queue': DLQ, 'wall_time_ms': row['$workers']['wallTimeMs'], 'cpu_time_ms': row['$workers']['cpuTimeMs']}
    for i, row in enumerate(rows) if row.get('$workers', {}).get('event', {}).get('queue') == DLQ
    and row['$workers'].get('outcome') is not None]
assert len(dlq) == 1 and dlq[0]['outcome'] == 'ok'
summary = {'reviewed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'source_file': SOURCE.name, 'source_bytes': len(raw), 'source_sha256': hashlib.sha256(raw).hexdigest(),
    'record_count': len(rows), 'worker': WORKER, 'job_id': JOB,
    'timestamp_min_utc': min(row['timestamp'] for row in rows), 'timestamp_max_utc': max(row['timestamp'] for row in rows),
    'required_failure_window_present': True, 'all_three_target_job_attempts_correlated': True,
    'attempts': attempts, 'dlq_invocation': dlq,
    'initial_cancellation_reason_confirmed': False,
    'remaining_analysis': 'Initial Queue invocation outcome is canceled; this check does not establish why it was canceled. Span analysis remains possible within this export.',
    'source_unchanged': SOURCE.read_bytes() == raw, 'network_requests': 0, 'live_mutations': 0}
assert summary['source_unchanged']
E.mkdir(mode=0o700)
(E / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
(E / 'target-job-queue-events.json').write_text(json.dumps(sorted(safe_records, key=lambda row: row['timestamp']), indent=2) + '\n')
(E / 'analysis-source.py').write_bytes(Path(__file__).read_bytes())
(E / 'result.md').write_text('''# 再取得Dashboardログ: 必要な対象jobログを確認

`logs-2026-10-12T12_14_27.128Z.json` の1,757 records、UTC11:34:00.095〜11:35:59.181は必要な時間帯を含む。

原本4,249,830bytes、SHA-256 `d7a389696fe139a5e62b5d72f1320cb0dcc101ec3fefa19459f3a9cf3470cc23`。原本変更なし。

同じrequestIdを用いて、job `69a619df-9115-42e8-87db-e98947635863` のpublication_deliveryとQueue invocation/例外を照合した。

| attempt | delivery UTC | 終了 UTC | outcome | wall / CPU |
| --- | --- | --- | --- | --- |
| 1 | 11:34:29.732 | 11:35:03.794 | canceled | 34,982ms / 146ms |
| 2 | 11:35:20.503 | 11:35:23.845 | exception | 3,781ms / 9ms |
| 3 | 11:35:24.984 | 11:35:28.342 | exception | 4,026ms / 9ms |

再試行2・3の例外本文はどちらも **Another invocation still owns this lifecycle execution**。対象jobのexecution token残留により再試行が拒否されたことを、推測ではなく実機ログで確認できた。両再試行にはservice invocationの返却成功ログがある。

初回にはconsumer終了とservice invocation返却の独自timingログがなく、Queue invocationのoutcomeはcanceled。CLI待機上限300秒より前に、初回consumerが約35秒で取り消されていたことが分かる。ただし **なぜcanceledになったかは、この確認だけでは未確定**。同じexport内のspanをさらに解析する余地がある。

UTC11:35:34.769には同サービスDLQ Queue invocationのok終了がある。このinvocation自体にはjob IDがないため、単独ではjobへの直接相関を主張しない。以前のR2読取で当該commitに一致するDLQ markerを確認済みという別証拠と整合する。

今回の依頼は必要ログの有無確認。原本を保持してローカル解析／allowlist抽出のみ実施。API照会、再送、deploy、トークン解除、設定・権限変更、GitHub共有なし。raw export／stack／認証header／アカウント情報はここへ複製していない。
''')
entry = datetime.datetime.now(datetime.timezone.utc).isoformat() + ' 再取得Dashboardログの必要情報確認\n'
entry += 'logs-2026-10-12T12_14_27.128Z.json: 1757records/4,249,830bytes/hash d7a389696fe139a5e62b5d72f1320cb0dcc101ec3fefa19459f3a9cf3470cc23原本不変。UTC11:34:00.095〜11:35:59.181で必要時間帯あり。同requestIdで対象job3attemptを照合: 初回11:35:03.794 canceled/wall34982ms/CPU146ms、再試行2・3は例外Another invocation still owns this lifecycle execution、両retryのservice invocation返却成功。初回consumer終了/返却timingなし、canceled理由自体は未確定でspan追加解析余地あり。DLQ invocation11:35:34.769 ok（このrecord自体にjobIDなし、以前の一致R2 markerと整合）。必要ログ有無確認のローカル解析のみ、remote操作/再送/解除/deploy/GitHub共有なし。詳細evidence/rss-performance-a8c7e54-fresh-r2/show-investigation/dashboard-targeted-review/result.md、summary.json、queue allowlist。\n\n'
log = ROOT / 'test-20261012.log'
log.write_text(entry + log.read_text())
print(json.dumps(summary, indent=2))
