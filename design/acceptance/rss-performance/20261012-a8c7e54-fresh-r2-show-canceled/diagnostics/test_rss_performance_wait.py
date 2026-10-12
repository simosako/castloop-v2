import unittest
from rss_performance_wait import CONFLICT_MESSAGE, is_known_publication_read_conflict, wait_for_publication


class PublicationWaitTest(unittest.TestCase):
    def test_exact_read_conflict_only(self):
        args = ['cli', 'operation-status', 'publication', 'known-job']
        self.assertTrue(is_known_publication_read_conflict(1, args, '', CONFLICT_MESSAGE + '\n'))
        for code, command, out, err in [
            (2, args, '', CONFLICT_MESSAGE),
            (1, ['cli', 'publish-episode', 'publication', 'known-job'], '', CONFLICT_MESSAGE),
            (1, ['cli', 'operation-status', 'lifecycle', 'known-job'], '', CONFLICT_MESSAGE),
            (1, args, '{}', CONFLICT_MESSAGE),
            (1, args, '', CONFLICT_MESSAGE.replace('publication_status_changed', 'management_transport_failed')),
            (1, args, '', 'other error\n' + CONFLICT_MESSAGE),
        ]:
            self.assertFalse(is_known_publication_read_conflict(code, command, out, err))

    def test_read_conflicts_and_held_are_not_completion(self):
        results = [None, {'server_status': {'status': {'state': 'published'}, 'ownership': 'held'}},
            {'server_status': {'status': {'state': 'published'}, 'ownership': 'released'}}]
        calls, sleeps = [], []
        def inspect(index):
            calls.append(index)
            return results[index]
        self.assertEqual(wait_for_publication(inspect, lambda: 0, sleeps.append), 2)
        self.assertEqual(calls, [0, 1, 2])
        self.assertEqual(sleeps, [1, 1])

    def test_deadline_prevents_new_read(self):
        time = [0]
        calls = []
        def inspect(index):
            calls.append(index)
            return None
        def sleep(seconds):
            time[0] += seconds
        with self.assertRaisesRegex(RuntimeError, 'deadline'):
            wait_for_publication(inspect, lambda: time[0], sleep, seconds=2)
        self.assertEqual(calls, [0, 1])

    def test_other_error_is_not_retried(self):
        calls = []
        def inspect(index):
            calls.append(index)
            raise RuntimeError('transport failure')
        with self.assertRaisesRegex(RuntimeError, 'transport failure'):
            wait_for_publication(inspect, lambda: 0, lambda _: None)
        self.assertEqual(calls, [0])

    def test_terminal_failure_stops(self):
        for state, ownership in [('failed', 'held'), ('abandoned', 'released'), ('processing', 'superseded')]:
            with self.assertRaisesRegex(RuntimeError, 'failed or superseded'):
                wait_for_publication(lambda _: {'server_status': {'status': {'state': state}, 'ownership': ownership}},
                    lambda: 0, lambda _: self.fail('Should not wait after failure'))

    def test_attempt_limit(self):
        calls = []
        def inspect(index):
            calls.append(index)
            return None
        with self.assertRaisesRegex(RuntimeError, 'limit'):
            wait_for_publication(inspect, lambda: 0, lambda _: None, attempts=2)
        self.assertEqual(calls, [0, 1])


if __name__ == '__main__':
    unittest.main()
