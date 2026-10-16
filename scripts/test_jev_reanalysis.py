"""Execution guard regressions. Every provider transport is an in-memory fake."""
import io
import json
import contextlib
from pathlib import Path
import tempfile
import types
import unittest
import urllib.request
from unittest.mock import patch

import jev_reanalysis as jr


class JevReanalysisGuardTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'budget.json'
        self.ledger = jr.Ledger(self.path, {'source_hash': 'fake-source', 'sentences': 38})
        self.report = {'raw_calls': []}
        self.calls = []
        self.saves = []
        self.transport = jr.Transport(self.ledger, self.report, lambda: self.saves.append(True),
                                      lambda: None, sender=self.fake_sender)
        self.transport.context = {'utterance_id': 'fake-u1', 'stage': 'tag'}
        self.reply = {'usage': {'input_tokens': 123}, 'answers': {'q': {'choice': 'idea'}}}
        self.failure = None

    def request(self, url=jr.URL, model=jr.MODEL):
        return urllib.request.Request(url, data=json.dumps({'model': model,
            'state': {'utterance': 'fake data'}, 'questions': {'q': {'type': 'choice', 'criteria': {'idea': 'idea'}}}}).encode(),
            headers={'Authorization': 'Bearer fake-test-key', 'Content-Type': 'application/json'})

    def fake_sender(self, request, **kwargs):
        # The persisted worst-case reservation must precede any transport.
        persisted = json.loads(self.path.read_text())
        self.assertEqual('pending', persisted['requests'][-1]['status'])
        self.assertGreaterEqual(persisted['reserved_nanos'], jr.RESERVATION)
        self.calls.append(request)
        if self.failure:
            raise self.failure
        return io.BytesIO(json.dumps(self.reply).encode())

    def test_constants_and_successful_usage_reconciliation(self):
        self.assertEqual(100_000_000, jr.CAP)
        self.assertEqual(22_020_096, jr.RESERVATION)
        with self.transport(self.request(), timeout=3.5) as response:
            self.assertEqual(self.reply, json.load(response))
        self.assertEqual(123 * 336, self.ledger.value['spent_nanos'])
        self.assertEqual(0, self.ledger.value['reserved_nanos'])
        self.assertEqual('settled', self.ledger.value['requests'][0]['status'])
        self.assertEqual('received', self.report['raw_calls'][0]['status'])
        self.assertEqual('whole_tag', self.report['raw_calls'][0]['stage'])
        self.assertNotIn('fake-test-key', json.dumps(self.report))
        self.assertNotIn('fake-test-key', self.path.read_text())

    def test_timeout_is_unknown_and_same_payload_cannot_be_retried(self):
        self.failure = TimeoutError('fake transport timeout')
        for _ in range(2):
            with self.assertRaises(jr.Stop):
                self.transport(self.request(), timeout=2)
        self.assertEqual(1, len(self.calls))
        self.assertEqual(jr.RESERVATION, self.ledger.value['reserved_nanos'])
        self.assertEqual('unknown', self.ledger.value['requests'][0]['status'])

    def test_missing_or_excessive_usage_is_never_settled_at_zero(self):
        for reply in ({'answers': {}}, {'usage': {'input_tokens': jr.TOKEN_BOUND + 1}},
                      {'usage': {'input_tokens': True}}, {'usage': {'input_tokens': -1}}):
            with self.subTest(reply=reply):
                ledger = jr.Ledger(Path(self.temp.name) / ('budget-' + str(len(list(Path(self.temp.name).iterdir()))) + '.json'), {})
                record = ledger.reserve({'fake': True}, {'stage': 'whole_tag'})
                with self.assertRaises(jr.Stop):
                    ledger.settle(record, reply)
                self.assertEqual(jr.RESERVATION, ledger.value['reserved_nanos'])
                self.assertEqual(0, ledger.value['spent_nanos'])

    def test_fifth_full_reservation_is_refused_before_transport(self):
        self.failure = TimeoutError('fake')
        for i in range(5):
            request = self.request()
            body = json.loads(request.data)
            body['state']['utterance'] = 'fake data ' + str(i)
            request.data = json.dumps(body).encode()
            with self.assertRaises(jr.Stop):
                self.transport(request, timeout=2)
        self.assertEqual(4, len(self.calls))
        self.assertLessEqual(self.ledger.value['spent_nanos'] + self.ledger.value['reserved_nanos'], jr.CAP)

    def test_pending_duplicate_and_existing_job_are_refused(self):
        body = json.loads(self.request().data)
        self.ledger.reserve(body, {'stage': 'whole_tag'})
        with self.assertRaises(jr.Stop):
            self.transport(self.request(), timeout=2)
        self.assertEqual([], self.calls)
        with self.assertRaises(jr.Stop):
            jr.Ledger(self.path, {})

    def test_other_endpoint_model_and_long_context_are_rejected(self):
        invalid = [self.request(url='https://api.deepseek.com/chat/completions'),
                   self.request(model='another-model'), self.request(url=jr.URL + '?q=1')]
        request = self.request()
        request.add_header('Typesafe-Danger-Zone-Long-Context', 'true')
        invalid.append(request)
        for request in invalid:
            with self.assertRaises(jr.Stop):
                self.transport(request, timeout=2)
        self.assertEqual([], self.calls)
        self.assertEqual([], self.ledger.value['requests'])

    def test_source_change_stops_before_reservation(self):
        def changed():
            raise jr.Stop('source changed')
        self.transport.source_check = changed
        with self.assertRaises(jr.Stop):
            self.transport(self.request(), timeout=2)
        self.assertEqual([], self.calls)
        self.assertEqual([], self.ledger.value['requests'])

    def test_redirect_cannot_leave_the_allowed_endpoint(self):
        with self.assertRaises(jr.Stop):
            jr.NoRedirect().redirect_request(None, None, 302, 'fake', {}, 'https://forbidden.invalid/')

    def test_38_sentence_fake_run_preserves_source_and_writes_separate_results(self):
        import local_backend
        from replay_history import reanalysis_source_hash
        root = Path(self.temp.name)
        meetings = root / 'state' / 'meetings'
        meetings.mkdir(parents=True)
        row = {'session_id': jr.SOURCE_ID, 'started_at': '2026-10-14T00:00:00Z',
               'utterances': [{'id': 'u' + str(i), 'text': '这个方案需要进一步讨论。',
                               'start_ms': i * 1000, 'end_ms': i * 1000 + 900}
                              for i in range(38)], 'reviews': {}}
        source = meetings / (jr.SOURCE_ID + '.json')
        source.write_text(json.dumps(row))
        original = source.read_bytes()
        submitted = []

        def fake_open(opener, request, *args, **kwargs):
            self.assertEqual(jr.URL, request.full_url)
            body = json.loads(request.data)
            submitted.append(body)
            answers = {}
            for key, question in body['questions'].items():
                keys = list(question['criteria'])
                choice = 'idea' if 'idea' in keys else 'no' if 'no' in keys else keys[0]
                probabilities = {k: .9 if k == choice else .1 / (len(keys) - 1) for k in keys}
                answers[key] = {'choice': choice, 'probabilities': probabilities}
            return io.BytesIO(json.dumps({'answers': answers, 'model': jr.MODEL,
                                          'usage': {'input_tokens': 123}}).encode())

        args = types.SimpleNamespace(app=str(Path(jr.__file__).parent), state_dir=str(root / 'state'),
            session_id=jr.SOURCE_ID, apply=True, expected_source_hash=reanalysis_source_hash(row),
            work_dir=str(root / 'work'), run_id='fake-full-run', output_dir=str(root / 'output'),
            jev_env=str(root / 'unused-fake-env'))
        with patch.object(local_backend, 'load_jev', return_value=local_backend.Jev('fake-key', jr.MODEL)), \
             patch.object(urllib.request.OpenerDirector, 'open', fake_open), \
             contextlib.redirect_stdout(io.StringIO()):
            result = jr.run(args)
        self.assertEqual('complete', result['status'])
        self.assertEqual(38, result['completed_tag_sentences'])
        self.assertEqual(76, len(submitted))
        self.assertLessEqual(result['exposure_cny'], .10)
        self.assertEqual(original, source.read_bytes())
        output = json.loads((root / 'output' / 'fake-full-run.json').read_text())
        self.assertEqual(38, len(output['events']))
        self.assertEqual(76, len(output['raw_calls']))
        self.assertEqual(reanalysis_source_hash(row), output['source_hash'])
        self.assertNotIn('fake-key', json.dumps(output))
        self.assertTrue(all(c['stage'] in ('whole_tag', 'task_clauses') for c in output['raw_calls']))


if __name__ == '__main__':
    unittest.main()
