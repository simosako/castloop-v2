import collections
import json
from pathlib import Path
import statistics

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-local-timing-20261012'

def read(name):
    return json.loads((E / name).read_text())

def rows(name):
    return [json.loads(line) for line in (E / name).read_text().splitlines()]

def duration(event):
    return event['end_ms'] - event['start_ms']

def merged_ms(events):
    intervals = sorted((event['start_ms'], event['end_ms']) for event in events)
    total = 0
    start = end = None
    for left, right in intervals:
        if start is None:
            start, end = left, right
        elif left <= end:
            end = max(end, right)
        else:
            total += end - start
            start, end = left, right
    return total + (0 if start is None else end - start)

def stats(values):
    if not values:
        return {'count': 0, 'total_ms': 0}
    return {'count': len(values), 'total_ms': round(sum(values), 3), 'mean_ms': round(statistics.mean(values), 3),
        'min_ms': round(min(values), 3), 'max_ms': round(max(values), 3)}

def category(label):
    method, key = label.split(':', 1)
    if method == 'r2.list':
        key = json.loads(key).get('prefix', '')
    if key == 'system/lifecycle-service.json':
        return 'service_admission'
    prefixes = {
        'system/show-publications/': 'show_control', 'system/show-reservations/': 'show_reservation',
        'system/jobs/': 'job_records', 'system/episode-lifecycle/': 'episode_lifecycle',
        'system/shows/': 'show_metadata', 'staging/': 'staging',
        'public/episodes/': 'episode_metadata_history', 'public/podcasts/': 'public_feed_cover_audio',
    }
    for prefix, name in prefixes.items():
        if key.startswith(prefix):
            return name
    return 'other'

def summary(trace):
    events = trace['events']
    assert all(event['ok'] for event in events), 'Trace contains failed operations'
    assert all(event['end_ms'] >= event['start_ms'] for event in events)
    groups = collections.defaultdict(list)
    methods = collections.defaultdict(list)
    scopes = collections.defaultdict(list)
    for event in events:
        label = event['label']
        if label.startswith('r2.'):
            groups[category(label)].append(duration(event))
            methods[label.split(':', 1)[0]].append(duration(event))
        else:
            scopes[label].append(duration(event))
    r2 = [event for event in events if event['label'].startswith('r2.')]
    io = [event for event in r2 if not event['label'].startswith('r2.body.')]
    return {'wall_ms': trace['ended_at_ms'] - trace['started_at_ms'], 'event_count': len(events),
        'r2_binding_operation_count': len(io), 'r2_including_body_union_ms': merged_ms(r2),
        'r2_by_method': {key: stats(value) for key, value in sorted(methods.items())},
        'r2_by_record_category': {key: stats(value) for key, value in sorted(groups.items())},
        'scopes_inclusive': {key: stats(value) for key, value in sorted(scopes.items())}}

job = read('measured-job.json')['job_id']
queue_traces = [json.loads(path.read_text()) for path in E.glob('queue-*.json')]
matching = [trace for trace in queue_traces if any(job in (message.get('key') or '') for message in trace['context']['messages'])]
assert matching, 'No queue trace for the measured job'
matching.sort(key=lambda trace: trace['started_at_ms'])
completed = [trace for trace in matching if trace['context'].get('ok')]
assert len(completed) == 1, 'Expected exactly one completed consumer; inspect delivery history'
queue = completed[0]
events = queue['events']
stage_rows = rows('measured-metadata-stage-corrected.timing.jsonl')
commit_rows = rows('measured-publication-commit.timing.jsonl')
polls = []
for path in sorted(E.glob('measured-poll-*.timing.jsonl')):
    polls.extend(rows(path.name))

def command_summary(name, records):
    result = {'elapsed': read(name + '.elapsed.json'), 'http': [], 'cli_spans': []}
    for record in records:
        if record['kind'] == 'cli_span':
            result['cli_spans'].append(record)
            continue
        row = {key: record.get(key) for key in ('path', 'method', 'action', 'duration_ms', 'status')}
        worker = record.get('worker')
        if worker:
            row['worker'] = summary(worker)
            row['outside_worker_wall_ms'] = round(record['duration_ms'] - row['worker']['wall_ms'], 3)
        result['http'].append(row)
    return result

commit_request = next(record for record in commit_rows if record.get('action') == 'commit')
marker = next(event for event in commit_request['worker']['events']
    if event['label'].startswith('r2.put:staging/') and event['label'].endswith('/commit.json'))
message = next(message for message in queue['context']['messages'] if job in (message.get('key') or ''))
first = next(trace for trace in matching if trace['id'] == queue['id'])
completion = read('completion.json')
progress = next(event for event in events if event['label'] == 'publication.progress:finished')
status = next(event for event in events if event['label'] == 'publication.status:published')
release = next(event for event in events if event['label'] == 'publication.finish_show_operation')
service_release = next(event for event in events if event['label'] == 'service.release_invocation:m6_consumer')

report = {
    'measurement': 'one unchanged metadata-only publication with 36 existing Episodes',
    'job_id': job,
    'queue_delivery_count': len(matching), 'queue_attempts': message['attempts'],
    'stage': command_summary('measured-metadata-stage-corrected', stage_rows),
    'commit': command_summary('measured-publication-commit', commit_rows),
    'queue': summary(queue),
    'timeline': {
        'marker_put_started_at_ms': marker['start_ms'], 'marker_put_ack_at_ms': marker['end_ms'],
        'queue_message_timestamp_ms': message['timestamp_ms'], 'consumer_started_at_ms': queue['started_at_ms'],
        'finished_progress_ack_at_ms': progress['end_ms'], 'published_status_ack_at_ms': status['end_ms'],
        'show_release_ack_at_ms': release['end_ms'], 'service_release_ack_at_ms': service_release['end_ms'],
        'consumer_ended_at_ms': queue['ended_at_ms'], 'cli_observed_at_ms': completion['observed_at_ms'],
        'queue_message_to_consumer_ms': queue['started_at_ms'] - message['timestamp_ms'],
        'marker_ack_to_consumer_ms_approx': queue['started_at_ms'] - marker['end_ms'],
        'marker_ack_to_finished_progress_ms_approx': progress['end_ms'] - marker['end_ms'],
        'finished_progress_to_service_release_ms': service_release['end_ms'] - progress['end_ms'],
        'commit_command_end_to_cli_observed_ms': completion['observed_at_ms'] - (
            read('measured-publication-commit.elapsed.json')['started_at_ms'] + read('measured-publication-commit.elapsed.json')['elapsed_ms']),
    },
    'poll_http_ms': stats([record['duration_ms'] for record in polls if record['kind'] == 'http']),
    'poll_worker_wall_ms': stats([record['worker']['ended_at_ms'] - record['worker']['started_at_ms']
        for record in polls if record.get('worker')]),
    'preservation': read('preservation.json'),
    'limits': [
        'Worker clocks advance on IO; wall/IO measurement, not CPU profiling',
        'Cross-invocation absolute-time deltas include possible clock skew; queue message timestamp meaning and actual R2 event enqueue boundary are not identical',
        'Named scopes include nested IO; do not add inclusive scope totals to R2 totals',
        'R2 operation durations may overlap (Promise.all); union time is used for wall share',
        'Metadata-only: no MP3 upload/readback or immutable audio copy measured',
        'Instrumented single sample; no causal performance improvement experiment',
    ],
}
path = E / 'timing-analysis.json'
assert not path.exists(), 'Preserve analysis; use a new filename for revisions'
path.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'stage_ms': report['stage']['elapsed']['elapsed_ms'], 'commit_ms': report['commit']['elapsed']['elapsed_ms'],
    'queue_wall_ms': report['queue']['wall_ms'], 'queue_r2_operations': report['queue']['r2_binding_operation_count'],
    'queue_r2_union_ms': report['queue']['r2_including_body_union_ms'], 'timeline': report['timeline'],
    'queue_scopes': report['queue']['scopes_inclusive'], 'queue_r2_categories': report['queue']['r2_by_record_category']}, indent=2))
