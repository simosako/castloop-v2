import collections
import json
from pathlib import Path
import statistics

E = Path('[LOCAL_TEST_ROOT]/evidence/rss-local-timing-20261012')
analysis = json.loads((E / 'timing-analysis.json').read_text())
job = analysis['job_id']
traces = [json.loads(path.read_text()) for path in E.glob('queue-*.json')]
queue = next(trace for trace in traces if any(job in (message.get('key') or '') for message in trace['context']['messages'])
    and trace['context'].get('ok'))
events = queue['events']
by_key = collections.defaultdict(list)
guard_indices = {index for index, event in enumerate(events) if event['label'] == 'publication.guard'}
scopes = collections.defaultdict(list)
for event in events:
    if event['label'].startswith('r2.get:'):
        by_key[event['label'].split(':', 1)[1]].append(event['end_ms'] - event['start_ms'])
    if event['label'].startswith('r2.'):
        continue
    scopes[event['label']].append(event)

repeated = []
for key, times in sorted(by_key.items(), key=lambda row: len(row[1]), reverse=True)[:10]:
    if key.startswith('system/show-publications/'):
        name = 'show_control'
    elif key.startswith('system/show-reservations/'):
        name = 'show_reservation'
    elif key.startswith('system/jobs/'):
        name = 'job_' + key.rsplit('/', 1)[1]
    elif key == 'system/lifecycle-service.json':
        name = 'service_admission'
    elif key.startswith('system/episode-lifecycle/'):
        name = 'target_episode_lifecycle'
    else:
        name = 'other'
    repeated.append({'record': name, 'count': len(times), 'total_ms': sum(times), 'mean_ms': round(statistics.mean(times), 3)})

binding_ops = [event for event in events if event['label'].startswith('r2.') and not event['label'].startswith('r2.body.')]
runner_index = next(index for index, event in enumerate(events) if event['label'] == 'consumer.episode_runner')
runner_children = [event for event in events if event.get('parent') == runner_index and not event['label'].startswith('r2.')]
assert all(left['end_ms'] <= right['start_ms'] for left, right in zip(runner_children, runner_children[1:])), 'Named phases overlap'
phase_totals = collections.Counter()
for event in runner_children:
    label = event['label']
    name = 'progress_status_writes_with_checks' if label.startswith(('publication.progress:', 'publication.status:')) else label
    phase_totals[name] += event['end_ms'] - event['start_ms']
runner = events[runner_index]
phase_totals['other_validation_and_output_writes'] = runner['end_ms'] - runner['start_ms'] - sum(phase_totals.values())
phase_totals['queue_preparation_and_consumer_wrapper'] = queue['ended_at_ms'] - queue['started_at_ms'] - (runner['end_ms'] - runner['start_ms'])
assert sum(phase_totals.values()) == analysis['queue']['wall_ms']

stage_summary = []
stage_worker_operations = 0
stage_worker_wall = 0
stage_http_wall = 0
for row in analysis['stage']['http']:
    worker = row.get('worker')
    stage_worker_operations += worker['r2_binding_operation_count'] if worker else 0
    stage_worker_wall += worker['wall_ms'] if worker else 0
    stage_http_wall += row['duration_ms']
    stage_summary.append({'component': (row.get('action') or 'target') if row['path'].startswith('/admin/') else 'R2 REST ' + row['method'],
        'client_ms': round(row['duration_ms'], 3), 'worker_ms': worker['wall_ms'] if worker else None,
        'r2_binding_operations': worker['r2_binding_operation_count'] if worker else None})

read_samples = collections.defaultdict(list)
write_samples = collections.defaultdict(list)
for record in analysis['stage']['http']:
    if not record.get('worker'):
        continue
    for label, values in record['worker']['r2_by_method'].items():
        if label in ('r2.get', 'r2.put'):
            read_samples[label].append(values)

report = {
    'repeated_get_same_records': repeated,
    'runner_guards': {'count': len(guard_indices),
        'r2_binding_operations': sum(event.get('parent') in guard_indices for event in binding_ops),
        'wall_ms': sum(event['end_ms'] - event['start_ms'] for event in scopes['publication.guard'])},
    'queue_exclusive_phase_wall_ms': dict(phase_totals),
    'stage_components': stage_summary,
    'stage_worker_r2_binding_operations': stage_worker_operations,
    'stage_worker_wall_ms_sum': stage_worker_wall,
    'stage_http_ms_sum': round(stage_http_wall, 3),
    'stage_outside_http_ms': round(analysis['stage']['elapsed']['elapsed_ms'] - stage_http_wall, 3),
    'worker_get_average_ms_comparison': {
        'management_during_stage': round(sum(value['total_ms'] for value in read_samples['r2.get']) / sum(value['count'] for value in read_samples['r2.get']), 3),
        'queue_consumer': analysis['queue']['r2_by_method']['r2.get']['mean_ms'],
        'note': 'Different invocations/execution paths; no location or storage-region cause confirmed',
    },
}
path = E / 'detailed-breakdown.json'
assert not path.exists()
path.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
