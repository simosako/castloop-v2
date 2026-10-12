import collections
import datetime
import json
from pathlib import Path
import statistics
import sys

ROOT = Path('[LOCAL_TEST_ROOT]')
E = ROOT / 'evidence/rss-performance-4781fad'
if len(sys.argv) > 1 and sys.argv[1] == 'remeasure1':
    E = ROOT / 'evidence/rss-performance-4781fad-remeasure1'
OLD = ROOT / 'evidence/rss-local-timing-20261012'
load = lambda directory, name: json.loads((directory / name).read_text())
ms = lambda value: datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
assert not (E / 'performance-comparison.json').exists(), 'Preserve previous analysis'
assert load(E, 'tail-closed.json')['success']
assert (E / 'tail.exit-code').read_text().strip() == '0'
assert not (E / 'tail-unexpected-close.json').exists()
assert not (E / 'tail-capture-error.json').exists()
assert all(load(E, 'preservation.json').values())
job = load(E, 'measured-job.json')['job_id']
invocations = [json.loads(line) for line in (E / 'worker-logs.jsonl').read_text().splitlines()]
logs = [row for invocation in invocations for row in invocation['logs']]
target = [row for row in logs if row['job_id'] == job]
queue_invocations = [row for row in invocations if row['kind'] == 'queue' and any(log.get('job_id') == job for log in row['logs'])]
assert len(queue_invocations) == 1 and queue_invocations[0]['exception_count'] == 0 and queue_invocations[0]['outcome'] == 'ok'
phases = collections.defaultdict(list)
conflicts = [load(E, path.name) for path in sorted(E.glob('measured-poll-*.retry.json'))]
expected_read_errors = len(conflicts)
observed_read_errors = 0
for row in target:
    if row['event'] == 'worker_timing':
        assert row['duration_ms'] >= 0
        if row['outcome'] == 'error':
            assert row['phase'] == 'publication.status', 'Unexpected failed publication phase'
            observed_read_errors += 1
        else:
            assert row['outcome'] == 'success'
        phases[row['phase']].append(row)
assert observed_read_errors == expected_read_errors, 'Every status error must match an explicitly classified CLI read conflict'
assert len(phases['publication.consumer']) == 1
assert len(phases['publication.guard']) == 8
assert len(phases['publication.owner_release']) == len(phases['publication.invocation_release']) == 1
delivery = [row for row in target if row['event'] == 'publication_delivery']
assert len(delivery) == 1 and delivery[0]['attempts'] == 1
old = load(OLD, 'timing-analysis.json')
old_job = old['job_id']
old_traces = [json.loads(path.read_text()) for path in OLD.glob('queue-*.json')]
trace = next(row for row in old_traces if row['context']['ok'] and any(old_job in (message.get('key') or '') for message in row['context']['messages']))
acquire = next(row for row in trace['events'] if row['label'] == 'service.acquire_invocation:m6_consumer')
release = next(row for row in trace['events'] if row['label'] == 'service.release_invocation:m6_consumer')
# The new consumer phase excludes route/setup/readiness prelude included in the old root trace.
common_old_consumer = release['end_ms'] - acquire['start_ms']
old_scopes = old['queue']['scopes_inclusive']

def summarize(rows):
    values = [row['duration_ms'] for row in rows]
    return {'count': len(values), 'total_ms': round(sum(values), 3), 'mean_ms': round(statistics.mean(values), 3),
        'min_ms': round(min(values), 3), 'max_ms': round(max(values), 3)}

summary = {key: summarize(value) for key, value in sorted(phases.items())}
compare = []

def comparison(label, before, after, note='Comparable phase boundary; independent single samples'):
    row = {'component': label, 'before_ms': round(before, 3), 'after_ms': round(after, 3),
        'saved_ms': round(before - after, 3), 'reduction_percent': round((before - after) / before * 100, 2) if before else None,
        'boundary_note': note}
    compare.append(row)

stage_ms = load(E, 'measured-metadata-stage.elapsed.json')['elapsed_ms']
commit_time = load(E, 'measured-publication-commit.elapsed.json')
completion = load(E, 'completion.json')
wait = completion['observed_at_ms'] - (commit_time['started_at_ms'] + commit_time['elapsed_ms'])
comparison('metadata staging CLI command', old['stage']['elapsed']['elapsed_ms'], stage_ms)
comparison('publication commit CLI command', old['commit']['elapsed']['elapsed_ms'], commit_time['elapsed_ms'])
comparison('commit CLI return to published/released observation', old['timeline']['commit_command_end_to_cli_observed_ms'], wait)
comparison('consumer aligned service acquire start to service release end', common_old_consumer, summary['publication.consumer']['total_ms'],
    'Old root 96727ms includes route/readiness prelude; subtract prelude using original service.acquire_invocation start, not subtraction of nested duration totals')
mapping = {'publication.guard': 'publication.guard', 'publication.verify_staging': 'publication.verify_staging',
    'publication.unique_guid': 'publication.unique_guid', 'publication.feed_inputs': 'publication.feed_inputs',
    'publication.purge_with_guards': 'publication.purge', 'publication.finish_show_operation': 'publication.owner_release',
    'service.release_invocation:m6_consumer': 'publication.invocation_release'}
for before, after in mapping.items():
    comparison(after, old_scopes[before]['total_ms'], summary[after]['total_ms'])
old_writes = sum(value['total_ms'] for key, value in old_scopes.items() if key.startswith(('publication.progress:', 'publication.status:')))
new_writes = sum(value['total_ms'] for key, value in summary.items() if key.startswith(('publication.progress.', 'publication.status_write.')))
comparison('progress/status writes including validation', old_writes, new_writes)
for old_prefix, new_prefix in [('publication.progress:', 'publication.progress.'), ('publication.status:', 'publication.status_write.')]:
    for key, value in old_scopes.items():
        if key.startswith(old_prefix):
            after = new_prefix + key[len(old_prefix):]
            comparison(after, value['total_ms'], summary[after]['total_ms'])
staging_jobs = collections.defaultdict(list)
for row in logs:
    if row.get('phase', '').startswith('staging.'):
        assert row['outcome'] == 'success'
        staging_jobs[row['job_id']].append(row)
assert len(staging_jobs) == 1, 'Expect exactly one new metadata staging operation'
stage_summary = {phase: summarize([row for rows in staging_jobs.values() for row in rows if row['phase'] == phase])
    for phase in sorted({row['phase'] for rows in staging_jobs.values() for row in rows})}
old_stage_components = load(OLD, 'detailed-breakdown.json')['stage_components']
for action in ['claim', 'begin', 'settle', 'finish', 'status']:
    before = sum(row['worker_ms'] for row in old_stage_components if row['component'] == action)
    comparison('staging.' + action, before, stage_summary['staging.' + action]['total_ms'],
        'Approximate: old entire management fetch trace versus new action wrapper; route/authorization prelude differs. No staging optimization in 4781fad')
consumer = phases['publication.consumer'][0]
finished = phases['publication.progress.finished'][0]
released = phases['publication.invocation_release'][0]
polls = [json.loads(path.read_text()) for path in sorted(E.glob('measured-poll-*.elapsed.json'))]
report = {'commit': load(E, 'build-identity.json')['commit'], 'cli_sha256': load(E, 'build-identity.json')['cli_sha256'],
    'worker': load(E, 'installed-worker.json'), 'job_id': job, 'previous_job_id': old_job, 'samples_per_version': 1,
    'measurement': 'same 36 published Episodes / same Episode unchanged metadata-only; no MP3 transfer or copy',
    'comparisons': compare, 'worker_phase_summary': summary, 'staging_phase_summary': stage_summary,
    'delivery': delivery[0], 'queue_delivery_count_observed': len(queue_invocations),
    'read_conflicts_retried': expected_read_errors,
    'timeline': {'consumer_started_at': consumer['started_at'], 'consumer_finished_at': consumer['finished_at'],
        'queue_message_to_delivery_logged_ms_approx': ms(delivery[0]['delivered_at']) - ms(delivery[0]['message_timestamp']),
        'old_root_consumer_wall_ms': old['queue']['wall_ms'], 'old_aligned_consumer_wall_ms': common_old_consumer,
        'old_route_setup_readiness_prelude_ms': acquire['start_ms'] - trace['started_at_ms'],
        'finished_progress_to_service_release_ms': ms(released['finished_at']) - ms(finished['finished_at']),
        'commit_cli_return_to_observed_ms': round(wait, 3), 'cli_observed_at_ms': completion['observed_at_ms'],
        'consumer_finish_to_cli_observation_ms_approx': completion['observed_at_ms'] - ms(consumer['finished_at'])},
    'cli_poll': {'count': len(polls), 'total_command_ms': sum(row['elapsed_ms'] for row in polls),
        'mean_command_ms': statistics.mean(row['elapsed_ms'] for row in polls), 'sleep_seconds_between_commands': 1},
    'preservation': load(E, 'preservation.json'),
    'limits': ['Worker clocks advance on I/O; not CPU or pure R2 processing time',
        'Nested phase totals overlap consumer; do not sum into elapsed duration',
        'New live logs do not expose binding counts; no live GET-count claim. Fixture GET 269->141 in developer docs is a different mock comparison',
        'One sample each, not controlled concurrent A/B; instrumentation, deployment location, time/load may differ',
        'Old consumer total 96727ms vs new phase has different route prelude; aligned comparison is additionally provided',
        'Queue message-to-delivery log includes new route/readiness prelude; not direct transport-latency comparison with old trace root',
        'Completed RSS import not republished; no initial/audio-only/full migration wait acceptance in this test',
        'New code provisional RSS wait is 300s; wait-limit increase is not counted as performance improvement']}
(E / 'performance-comparison.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'comparisons': compare, 'timeline': report['timeline'], 'job_id': job, 'preservation': report['preservation']}, indent=2))
