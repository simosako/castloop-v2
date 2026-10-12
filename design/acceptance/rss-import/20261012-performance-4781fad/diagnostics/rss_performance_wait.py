CONFLICT_MESSAGE = ('Operation status could not be verified; preserve records, locks and ownership '
    'without automatic retry or recovery [reason_code=publication_status_changed]')


def is_known_publication_read_conflict(returncode, arguments, stdout, stderr):
    return (returncode == 1 and len(arguments) == 4
        and arguments[1:3] == ['operation-status', 'publication']
        and bool(arguments[3]) and stdout.strip() == ''
        and stderr.strip() == CONFLICT_MESSAGE)


def wait_for_publication(inspect, clock, sleep, seconds=300, attempts=300):
    deadline = clock() + seconds
    for index in range(attempts):
        if clock() >= deadline:
            raise RuntimeError('Known job exceeded wait deadline; retain records/owners')
        result = inspect(index)
        if result is not None:
            server = result['server_status']
            state = (server.get('status') or {}).get('state')
            if state in ('failed', 'abandoned') or server['ownership'] == 'superseded':
                raise RuntimeError('Publication failed or superseded; stop')
            if state == 'published' and server['ownership'] == 'released':
                return index
        sleep(1)
    raise RuntimeError('Inspection limit exceeded; retain records/owners')
