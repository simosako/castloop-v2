import collections
import datetime
import hashlib
import json
import os
from pathlib import Path

ROOT = Path('[LOCAL_TEST_ROOT]')
SOURCE = ROOT / 'logs-2026-10-12T12_06_15.809Z.json'
E = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2/show-investigation/dashboard-log-review'
JOB = '69a619df-9115-42e8-87db-e98947635863'
WORKER = 'castloop-rssperf-1012-r2-0f9dbe46'
os.umask(0o077)
assert not E.exists(), 'Preserve earlier review'
raw = SOURCE.read_bytes()
original_hash = hashlib.sha256(raw).hexdigest()
rows = json.loads(raw)
assert isinstance(rows, list) and all(isinstance(row, dict) for row in rows)
timestamp = lambda value: datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
start = timestamp('2026-10-12T11:34:00Z')
end = timestamp('2026-10-12T11:36:00Z')
counts = {key: collections.Counter() for key in ['worker', 'event_type', 'invocation_outcome', 'log_type', 'level']}
known_events = []
error_indices = []
consumer_indices = []
window_indices = []
for index, row in enumerate(rows):
    worker = row.get('$workers', {})
    metadata = row.get('$metadata', {})
    source = row.get('source', {})
    assert isinstance(worker, dict) and isinstance(metadata, dict) and isinstance(source, dict)
    counts['worker'][worker.get('scriptName', metadata.get('service', 'missing'))] += 1
    counts['event_type'][worker.get('eventType', 'missing')] += 1
    counts['invocation_outcome'][worker.get('outcome', 'missing')] += 1
    counts['log_type'][metadata.get('type', 'missing')] += 1
    counts['level'][source.get('level', metadata.get('level', 'missing'))] += 1
    if start <= timestamp(row['timestamp']) <= end:
        window_indices.append(index)
    if worker.get('eventType') == 'queue':
        consumer_indices.append(index)
    if worker.get('outcome') not in [None, 'ok'] or source.get('level') == 'error' or metadata.get('level') == 'error':
        error_indices.append(index)
    if source.get('event') in ['worker_timing', 'publication_delivery'] and source.get('job_id') == JOB:
        allowed = ['event', 'job_id', 'phase', 'outcome', 'started_at', 'finished_at', 'duration_ms',
            'delivered_at', 'message_timestamp', 'attempts']
        known_events.append({'row_index_zero_based': index, 'timestamp': row['timestamp'],
            **{key: source[key] for key in allowed if key in source}})
assert set(counts['worker']) == {WORKER}
first = min(timestamp(row['timestamp']) for row in rows)
last = max(timestamp(row['timestamp']) for row in rows)
phases = collections.Counter(row.get('phase', 'no_phase') for row in known_events)
summary = {
    'reviewed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'source_file': SOURCE.name, 'source_bytes': len(raw), 'source_sha256': original_hash,
    'row_count': len(rows), 'worker': WORKER, 'job_id': JOB,
    'time_range_utc': {'from': first.isoformat(), 'to': last.isoformat()},
    'time_range_jst': {'from': first.astimezone(datetime.timezone(datetime.timedelta(hours=9))).isoformat(),
        'to': last.astimezone(datetime.timezone(datetime.timedelta(hours=9))).isoformat()},
    'required_time_range_utc': {'from': start.isoformat(), 'to': end.isoformat()},
    'required_window_rows': len(window_indices), 'queue_event_rows': len(consumer_indices),
    'error_level_or_abnormal_invocation_rows': len(error_indices),
    'counts': {key: dict(value) for key, value in counts.items()},
    'target_job_structured_rows': len(known_events), 'target_job_phases': dict(phases),
    'target_job_publication_consumer_rows': sum(row.get('phase') == 'publication.consumer' for row in known_events),
    'target_job_publication_delivery_rows': sum(row.get('event') == 'publication_delivery' for row in known_events),
    'target_job_status_query_success_rows': sum(
        row.get('phase') == 'publication.status' and row.get('outcome') == 'success' for row in known_events),
    'source_unchanged': SOURCE.read_bytes() == raw,
    'network_requests': 0, 'live_mutations': 0,
    'initial_failure_root_cause_confirmed': False,
    'conclusion': 'Export excludes the required failure window. Successful publication.status rows confirm status-query execution, not successful publication.',
    'possible_export_limit': 'Exactly 2000 rows and earliest timestamp after the failure suggest a latest-results export limit; not established from this file alone.'}
assert summary['source_unchanged']
assert not window_indices and not consumer_indices and not error_indices
assert len(known_events) == 70 and set(phases) == {'publication.status'}
E.mkdir(mode=0o700)
(E / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
(E / 'target-job-status-events.json').write_text(json.dumps(known_events, indent=2) + '\n')
(E / 'result.md').write_text('''# Dashboard export解析: 必要時間帯が含まれていない

## 結果

`logs-2026-10-12T12_06_15.809Z.json` は正常に解析できた。ただし **初回失敗の原因を確定するログは含まれていない**。

- 原本: 4,890,461 bytes、2,000 records。
- SHA-256: `c0eba5ea1b3144d2ba59c55ad44edf518f5836e607ee54679966fdc3b6952a44`
- 全件が対象Worker `castloop-rssperf-1012-r2-0f9dbe46` の記録。
- 収録範囲: **2026-10-12 11:37:12.785〜12:05:25.480 UTC**。
- 日本時間: **20:37:12.785〜21:05:25.480**。
- 必要範囲: **11:34〜11:36 UTC / 20:34〜20:36 JST**。該当record 0。
- Queue event 0、error levelまたは非ok終了のinvocation record 0。
- cf-worker-event 228、span 1,702、cf-worker 70。
- 対象jobの構造化ログ70件はすべて `worker_timing / publication.status / success`。
- `publication.consumer` と `publication_delivery` は0件。

`publication.status` のsuccessは **状態照会が成功したこと**を意味し、公開jobがpublishedになったことやconsumerが成功したことではない。既存のprocessing/held/DLQ判断を変更する材料ではない。

2,000件ちょうどで新しい時間帯だけが残っているため、exportの件数上限で古い失敗記録が含まれなかった可能性がある。ただしファイルだけからexport上限の仕様は確定できない。

## 次に必要なexport

同じWorkerで時間範囲を **2026-10-12 11:34:00〜11:36:00 UTC**（Dashboardが日本時間なら **20:34:00〜20:36:00**）へ絞る。

大量のspanがログを押し出さないよう、必要なら **typeがspanのレコードを除外**し、invocation log・console log・例外を残してexportする。Queue invocationとその関連ログがあれば、最初の失敗のoutcome／例外と、後続2回の実行がexecution busyだったかを照合できる。

今回の解析はローカルのみ、原本hash不変、remote照会／再送／deploy／解除／権限変更なし。元exportには非公開アカウント／リクエスト情報が含まれる可能性があるため、未加工のままGitHubへpushしない。原本を複製せず、安全な集計と対象jobのallowlistログのみをここへ保存した。
''')
(E / 'analysis-source.py').write_bytes(Path(__file__).read_bytes())
entry = datetime.datetime.now(datetime.timezone.utc).isoformat() + ' Dashboard取得ログのローカル解析\n'
entry += 'ユーザー提供logs-2026-10-12T12_06_15.809Z.jsonを解析。原本4,890,461bytes/2000records/hash c0eba5ea1b3144d2ba59c55ad44edf518f5836e607ee54679966fdc3b6952a44不変。全件対象Workerだが収録範囲UTC11:37:12.785〜12:05:25.480（JST20:37〜21:05）で必要なUTC11:34〜11:36が0件。Queue/consumer/delivery/例外記録なし、対象job70件は全てpublication.status照会成功で公開成功を意味しない。span1702件/原本ちょうど2000件、export上限で古いログが落ちた可能性（仕様未確定）。初回停止直接原因は引き続き未確定。時間帯を絞りspanを除外した再exportを依頼する。原本/素材/journal/環境変更、remote操作、GitHub共有なし。詳細evidence/rss-performance-a8c7e54-fresh-r2/show-investigation/dashboard-log-review/result.md、summary.json、対象status allowlist70件。\n\n'
log = ROOT / 'test-20261012.log'
log.write_text(entry + log.read_text())
print(json.dumps(summary, indent=2))
