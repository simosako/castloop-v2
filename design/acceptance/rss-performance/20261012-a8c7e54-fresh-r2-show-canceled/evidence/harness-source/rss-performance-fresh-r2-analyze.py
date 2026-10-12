import collections
import datetime
import json
from pathlib import Path
import statistics

ROOT = Path('[LOCAL_TEST_ROOT]')
BASE = ROOT / 'evidence/rss-performance-a8c7e54-fresh-r2'
E = BASE / 'normal-update'
OLD = ROOT / 'evidence/rss-performance-4781fad-remeasure1'
load = lambda directory, name: json.loads((directory / name).read_text())
assert not (E / 'performance-comparison.json').exists()
assert load(E, 'tail-closed.json')['success'] and (E / 'tail.exit-code').read_text().strip() == '0'
assert not (E / 'tail-capture-error.json').exists() and not (E / 'tail-unexpected-close.json').exists()
assert all(load(E, 'preservation.json').values())
job = load(E, 'measured-job.json')['job_id']
rows = [json.loads(line) for line in (E / 'worker-logs.jsonl').read_text().splitlines()]
queue = [row for row in rows if row['kind'] == 'queue' and any(log.get('job_id') == job for log in row['logs'])]
assert len(queue) == 1 and queue[0]['outcome'] == 'ok' and queue[0]['exception_count'] == 0
logs = [log for row in rows for log in row['logs']]
target = [log for log in logs if log['job_id'] == job]
delivery = [log for log in target if log['event'] == 'publication_delivery']
assert len(delivery) == 1 and delivery[0]['attempts'] == 1
conflicts = len(list(E.glob('measured-poll-*.retry.json')))
errors = [log for log in target if log.get('outcome') == 'error']
assert len(errors) == conflicts and all(log['phase'] == 'publication.status' for log in errors)
phases = collections.defaultdict(list)
for log in target:
    if log['event'] == 'worker_timing' and log['outcome'] == 'success':
        phases[log['phase']].append(log['duration_ms'])
summarize = lambda values: {'count': len(values), 'total_ms': sum(values), 'mean_ms': statistics.mean(values),
    'min_ms': min(values), 'max_ms': max(values)}
summary = {key: summarize(values) for key, values in sorted(phases.items())}
assert summary['publication.consumer']['count'] == 1
assert summary['publication.unique_guid']['count'] == summary['publication.feed_inputs']['count'] == 1
assert summary['publication.guard']['count'] == 8
staging = collections.defaultdict(list)
for log in logs:
    if log.get('phase', '').startswith('staging.'):
        assert log['outcome'] == 'success'
        staging[log['phase']].append(log['duration_ms'])
stage_summary = {key: summarize(values) for key, values in sorted(staging.items())}
assert stage_summary['staging.finish']['count'] == 1
previous = load(OLD, 'performance-comparison.json')
comparison = []


def compare(label, before, after):
    comparison.append({'component': label, 'before_ms': before, 'after_ms': after,
        'saved_ms': before - after, 'reduction_percent': (before - after) / before * 100 if before else None})


for phase in ['publication.consumer', 'publication.guard', 'publication.unique_guid', 'publication.feed_inputs']:
    compare(phase, previous['worker_phase_summary'][phase]['total_ms'], summary[phase]['total_ms'])
compare('staging.finish', previous['staging_phase_summary']['staging.finish']['total_ms'], stage_summary['staging.finish']['total_ms'])
for prefix in ['publication.progress.', 'publication.status_write.']:
    compare(prefix + '*', sum(v['total_ms'] for k, v in previous['worker_phase_summary'].items() if k.startswith(prefix)),
        sum(v['total_ms'] for k, v in summary.items() if k.startswith(prefix)))
stage = load(E, 'measured-metadata-stage.elapsed.json')
commit = load(E, 'measured-publication-commit.elapsed.json')
completion = load(E, 'completion.json')
wait = completion['observed_at_ms'] - commit['started_at_ms'] - commit['elapsed_ms']
compare('metadata staging CLI', load(OLD, 'measured-metadata-stage.elapsed.json')['elapsed_ms'], stage['elapsed_ms'])
compare('publication commit CLI', load(OLD, 'measured-publication-commit.elapsed.json')['elapsed_ms'], commit['elapsed_ms'])
compare('commit return to published/released observation', previous['timeline']['commit_cli_return_to_observed_ms'], wait)
compare('metadata stage start to CLI completion', load(OLD, 'completion.json')['observed_at_ms'] - load(OLD, 'measured-metadata-stage.elapsed.json')['started_at_ms'],
    completion['observed_at_ms'] - stage['started_at_ms'])
result = {'commit': load(BASE, 'build-identity.json')['commit'], 'cli_sha256': load(BASE, 'build-identity.json')['cli_sha256'],
    'worker': load(BASE, 'installed-worker.json'), 'job_id': job, 'baseline_job_id': previous['job_id'],
    'comparisons': comparison, 'worker_phase_summary': summary, 'staging_phase_summary': stage_summary,
    'read_conflicts_retried': conflicts, 'queue_attempts': 1, 'consumer_exceptions': 0,
    'preservation': load(E, 'preservation.json'),
    'limits': ['One complete sample each; no controlled concurrent A/B or statistical guarantee',
        'Same 36 real Episodes and same metadata-only target, but new service/bucket/domain/location and shorter publication history',
        'Catalog built during fresh import; no cold reconstruction of an existing 36-Episode Show measured',
        'No fresh audio upload/copy within measured job; setup publication is a separate operation',
        'Wall/I/O intervals, not CPU or R2 internal latency; nested phases must not be summed',
        'No live R2 binding request counts or attribution to placement/network changes',
        'No acceptance claim that all prior 120-second audio-import timeouts are resolved']}
(E / 'performance-comparison.json').write_text(json.dumps(result, indent=2) + '\n')
table = '\n'.join('| ' + row['component'] + ' | ' + f'{row["before_ms"]/1000:.3f}' + ' | ' +
    f'{row["after_ms"]/1000:.3f}' + ' | ' + f'{row["reduction_percent"]:.2f}%' + ' |' for row in comparison)
text = '# a8c7e54 新規r2性能試験結果\n\n36件の本物音源を元入力から公開し、同一metadata-only通常更新1jobを測定。\n\n'
text += f'commit `{result["commit"]}` / job `{job}`。Worker Logsでconsumer終了・attempts=1・例外0、CLI published/releasedとservice解放を確認。\n\n'
text += '| 区間 | 4781fad (秒) | a8c7e54 (秒) | 短縮率 |\n|---|---:|---:|---:|\n' + table + '\n\n'
text += '全36件RSS項目照合、カバーと代表2音源のGET/hash/HEAD/Range照合成功（独立再GETは36件全量ではない）。元116入力・completed cursor・ローカルTOML・設定不変、測定前後Feed byte一致/metadata revisionとupdated_at以外不変・未変更カタログentry同一、36件catalog/job/世代整合、公開catalog404、domain整合・service open/drained・Show idle。旧updating環境/旧ホスト/素材/記録保持、GitHub共有は今回未実施。\n\n'
text += 'DNS1.1.1.1/TLS検証有効。domain追加直後のDNS/TLS未検証は証跡保持、到達確認後に同じoperation IDで検証のみ続行。OS/router/権限設定変更なし。\n\n## 制限\n\n' + '\n'.join('- ' + line for line in result['limits']) + '\n'
(BASE / 'result.md').write_text(text)
print(json.dumps({'job_id': job, 'comparisons': comparison}, indent=2))
