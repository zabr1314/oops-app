#!/usr/bin/env python3
"""No-network tests for immutable AI suggestions, blind separation and spend caps."""
import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import label_ai as ai
from label_workflow import digest, row_fingerprint


def rows(count=30):
    return [dict(id='u%d-1' % i, parent='u%d' % i, text='产品支持麦克风和扬声器%d。' % i,
        start_ms=i * 2000, end_ms=i * 2000 + 1500, role='A') for i in range(count)]


class FakeModel:
    model = 'deepseek-flash'

    def __init__(self, failure=False, malformed=False):
        self.calls, self.failure, self.malformed = [], failure, malformed

    def complete_bounded(self, user, max_tokens, timeout):
        self.calls.append(json.loads(user))
        if self.failure:
            raise ai.ModelFailure('transport_failed')
        values = self.calls[-1]['targets']
        if self.malformed:
            values = values[1:]
        return dict(expressions=[dict(ids=[u['id']], kind='fact', reason='描述设备能力，仍待核验。')
            for u in values]), self.model, dict(prompt_tokens=100, completion_tokens=50, total_tokens=150,
                completion_tokens_details=dict(reasoning_tokens=0))


class LabelAITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = self.temp.name
        self.rows = rows()
        self.meetings = {'0235': self.rows}

    def quote(self, **extra):
        return ai.quote_meetings(self.folder, self.meetings, 'deepseek-flash', 2, 8, **extra)

    def generate(self, quote=None, model=None):
        q = quote or self.quote()
        return ai.generate_meetings(self.folder, self.meetings, q, q['upper_cny'] + .01,
            q['quote_hash'], model or FakeModel())

    def path(self):
        return os.path.join(self.folder, 'meetings', '0235', 'suggestions.json')

    def test_source_hash_binds_machine_metadata_not_claims(self):
        changed = copy.deepcopy(self.rows)
        changed[0]['claimed'] = True
        self.assertEqual(ai.source_hash(self.rows), ai.source_hash(changed))
        changed[0]['role'] = 'B'
        self.assertNotEqual(ai.source_hash(self.rows), ai.source_hash(changed))
        self.assertEqual(row_fingerprint(self.rows[0]), row_fingerprint(changed[0]))

    def test_blind_is_deterministic_whole_parent_and_excludes_existing_answers(self):
        source = self.rows + [dict(self.rows[2], id='u2-2', start_ms=4500, end_ms=4700)]
        blind = ai.build_blind_plan(source, '0235')
        self.assertEqual(blind, ai.build_blind_plan(source, '0235'))
        excluded = set(blind['ids'])
        another = ai.build_blind_plan(source, '0235', excluded_ids=excluded)
        self.assertFalse(excluded.intersection(another['ids']))
        for pid in blind['parent_ids']:
            self.assertTrue({r['id'] for r in source if r['parent'] == pid} <= set(blind['ids']))
        self.assertEqual(2, len(blind['parent_ids']))

    def test_blind_can_be_empty_if_every_parent_has_answer(self):
        blind = ai.build_blind_plan(self.rows, '0235', [r['id'] for r in self.rows])
        self.assertEqual([], blind['ids'])
        ai.validate_blind_plan(blind, self.rows)

    def test_blind_never_sent_as_target_context_or_text(self):
        source = rows(30)
        blind = ai.build_blind_plan(source, '0235')
        batches = ai.build_batches(source, blind)
        sent = [u for b in batches for u in json.loads(b['user'])['targets'] + json.loads(b['user'])['context']]
        self.assertFalse(set(blind['ids']).intersection(u['id'] for u in sent))
        for hidden in source:
            if hidden['id'] in blind['ids']:
                self.assertNotIn(hidden['text'], ''.join(b['user'] for b in batches))
        target_ids = [uid for b in batches for uid in b['ids']]
        self.assertEqual([r['id'] for r in source if r['id'] not in blind['ids']], target_ids)

    def test_blind_partial_parent_is_rejected(self):
        source = rows(1) + [dict(rows(1)[0], id='u0-2')]
        blind = ai.build_blind_plan(source, '0235')
        blind['ids'].pop()
        with self.assertRaises(ai.InvalidSuggestion):
            ai.build_batches(source, blind)

    def test_join_cross_parent_only_with_same_explicit_voice(self):
        a, b = rows(2)
        b.update(start_ms=1600, end_ms=2000)
        self.assertTrue(ai.can_join([a], b))
        b['role'] = 'B'
        self.assertFalse(ai.can_join([a], b))
        del a['role']; del b['role']
        self.assertFalse(ai.can_join([a], b))
        b['parent'] = a['parent']
        self.assertTrue(ai.can_join([a], b))

    def test_join_rejects_overlap_ambiguity_and_long_gap(self):
        a, b = rows(2)
        for change in (dict(start_ms=1000), dict(start_ms=5000), dict(role='multi'), dict(role='unclear')):
            self.assertFalse(ai.can_join([a], dict(b, **change)))

    def test_response_covers_each_atomic_id_exactly_once(self):
        blind = ai.build_blind_plan(self.rows, '0235')
        batch = ai.build_batches(self.rows, blind)[0]
        model = FakeModel()
        raw, used, usage = model.complete_bounded(batch['user'], 4096, 60)
        out = ai.validate_response(raw, batch, self.rows, used)
        self.assertEqual(batch['ids'], [uid for exp in out for uid in exp['ids']])
        self.assertEqual('fact', out[0]['kind'])
        for bad in ('drop', 'duplicate', 'reorder', 'invent', 'edit'):
            altered = copy.deepcopy(raw)
            if bad == 'drop': altered['expressions'].pop()
            if bad == 'duplicate': altered['expressions'].append(altered['expressions'][0])
            if bad == 'reorder': altered['expressions'].reverse()
            if bad == 'invent': altered['expressions'][0]['ids'] = ['missing']
            if bad == 'edit': altered['expressions'][0]['text'] = '改写'
            with self.subTest(bad=bad), self.assertRaises(ai.InvalidSuggestion):
                ai.validate_response(altered, batch, self.rows, used)

    def test_model_cannot_merge_separate_speakers(self):
        source = rows(3)
        source[1]['role'] = 'B'
        blind = ai.build_blind_plan(source, '0235', [r['id'] for r in source])
        batch = ai.build_batches(source, blind)[0]
        with self.assertRaises(ai.InvalidSuggestion):
            ai.validate_response(dict(expressions=[dict(ids=batch['ids'], kind='fact', reason='描述能力')]),
                                 batch, source, 'fake')

    def test_quote_uses_utf8_upper_bound_and_no_network_or_credentials(self):
        with patch.object(ai, 'load_deepseek', side_effect=AssertionError('credentials')), \
                patch.object(ai.urllib.request, 'urlopen', side_effect=AssertionError('network')):
            quote = self.quote()
        for batch in quote['meetings'][0]['batches']:
            self.assertGreater(batch['input_tokens_upper'], 512)
            self.assertEqual(4096, batch['output_tokens_upper'])
        self.assertEqual(digest({k: v for k, v in quote.items() if k != 'quote_hash'}), quote['quote_hash'])
        self.assertGreater(quote['upper_cny'], 0)

    def test_prepare_is_valid_without_any_model_call_and_keeps_plan(self):
        q = self.quote()
        with patch.object(FakeModel, 'complete_bounded', side_effect=AssertionError()):
            ai.prepare_meetings(self.folder, self.meetings, q)
        doc = ai.load_sidecar(self.path(), self.rows, '0235')
        self.assertEqual('planned', doc['status'])
        self.assertEqual([], doc['expressions'])
        self.assertEqual(q['meetings'][0]['blind'], doc['blind'])
        folder = os.path.join(self.folder, 'labels', '0235')
        os.makedirs(folder)
        with open(os.path.join(folder, 'synthetic.json'), 'w') as f:
            json.dump(dict(labels={uid: dict(kind='fact') for uid in doc['blind']['ids']}), f)
        self.assertEqual(doc['blind'], self.quote()['meetings'][0]['blind'])

    def test_success_records_real_usage_and_never_writes_human_labels(self):
        before = copy.deepcopy(self.rows)
        result = self.generate()
        self.assertEqual('ready', result['0235']['status'])
        doc = ai.load_sidecar(self.path(), self.rows, '0235')
        self.assertTrue(doc['expressions'])
        self.assertEqual(150 * len(doc['batches']), doc['usage']['total_tokens'])
        self.assertEqual(0, doc['batches'][0]['usage']['completion_tokens_details']['reasoning_tokens'])
        self.assertFalse(os.path.exists(os.path.join(self.folder, 'labels')))
        self.assertEqual(before, self.rows)
        for exp in doc['expressions']:
            self.assertEqual(ai.suggestion_fingerprint(exp, doc['source_hash']), exp['suggestion_fingerprint'])

    def test_resume_does_not_repeat_complete_requests(self):
        q, model = self.quote(), FakeModel()
        self.generate(q, model)
        count = len(model.calls)
        self.generate(q, model)
        self.assertEqual(count, len(model.calls))

    def test_failed_unknown_call_consumes_upper_and_cannot_retry_past_cap(self):
        q, model = self.quote(), FakeModel(failure=True)
        result = self.generate(q, model)
        self.assertEqual('failed', result['0235']['status'])
        self.assertAlmostEqual(q['upper_cny'], result['0235']['charged_upper_cny'], places=7)
        count = len(model.calls)
        self.generate(q, model)
        self.assertEqual(count, len(model.calls))
        self.assertEqual([], ai.load_sidecar(self.path(), self.rows, '0235')['expressions'])

    def test_malformed_output_fails_whole_batch_but_keeps_billed_usage(self):
        result = self.generate(model=FakeModel(malformed=True))
        self.assertEqual('failed', result['0235']['status'])
        doc = ai.load_sidecar(self.path(), self.rows, '0235')
        self.assertEqual([], doc['expressions'])
        self.assertGreater(doc['usage']['total_tokens'], 0)
        self.assertEqual('atomic_coverage_or_order', doc['batches'][0]['error_code'])

    def test_two_attempt_quote_can_resume_failed_batches_once(self):
        q = self.quote(max_attempts=2)
        self.generate(q, FakeModel(failure=True))
        model = FakeModel()
        self.assertEqual('ready', self.generate(q, model)['0235']['status'])
        self.assertEqual(2, len(ai.load_sidecar(self.path(), self.rows, '0235')['batches'][0]['attempts']))
        calls = len(model.calls)
        self.generate(q, model)
        self.assertEqual(calls, len(model.calls))

    def test_budget_and_quote_guard_run_before_model(self):
        q, model = self.quote(), FakeModel()
        for budget, fingerprint in ((0, q['quote_hash']), (100, 'bad')):
            with self.assertRaises(ValueError):
                ai.generate_meetings(self.folder, self.meetings, q, budget, fingerprint, model)
        self.assertEqual([], model.calls)
        self.assertFalse(os.path.exists(self.path()))

    def test_changed_source_or_tampered_suggestion_fail_closed(self):
        self.generate()
        changed = copy.deepcopy(self.rows)
        changed[0]['text'] += '变化'
        with self.assertRaises(ValueError):
            ai.load_sidecar(self.path(), changed, '0235')
        with open(self.path(), encoding='utf-8') as f:
            doc = json.load(f)
        doc['expressions'][0]['kind'] = 'task'
        ai.atomic_write(self.path(), doc)
        with self.assertRaises(ValueError):
            ai.load_sidecar(self.path(), self.rows, '0235')

    def test_missing_sidecar_is_none_and_broken_json_raises(self):
        self.assertIsNone(ai.load_sidecar(self.path(), self.rows, '0235'))
        os.makedirs(os.path.dirname(self.path()))
        with open(self.path(), 'w') as f: f.write('{broken')
        with self.assertRaises(ValueError):
            ai.load_sidecar(self.path(), self.rows, '0235')

    def test_bounded_client_disables_thinking_and_never_echoes_secrets(self):
        seen = []
        def request(req, timeout):
            seen.append(json.loads(req.data))
            return io.BytesIO(json.dumps(dict(model='deepseek-flash', usage=dict(prompt_tokens=1,
                completion_tokens=2, total_tokens=3), choices=[dict(finish_reason='stop',
                message=dict(content='{"expressions":[]}'))])).encode())
        with patch.object(ai.urllib.request, 'urlopen', side_effect=request):
            raw, used, usage = ai.LabelDeepSeek('test-secret').complete_bounded('{}', 4096, 30)
        self.assertEqual({'type': 'disabled'}, seen[0]['thinking'])
        self.assertEqual(4096, seen[0]['max_tokens'])
        self.assertEqual('test-secret', ai.LabelDeepSeek('test-secret').key)
        with patch.object(ai.urllib.request, 'urlopen', side_effect=RuntimeError('test-secret')):
            with self.assertRaises(ai.ModelFailure) as failure:
                ai.LabelDeepSeek('test-secret').complete_bounded('{}', 4096, 30)
        self.assertEqual('transport_failed', str(failure.exception))

    def test_truncated_response_has_usage_and_no_suggestions(self):
        response = dict(model='test', usage=dict(prompt_tokens=3, completion_tokens=4096),
            choices=[dict(finish_reason='length', message=dict(content='partial'))])
        with patch.object(ai.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(response).encode())):
            with self.assertRaises(ai.ModelFailure) as failure:
                ai.LabelDeepSeek('test-only').complete_bounded('{}', 4096, 30)
        self.assertEqual('output_incomplete', failure.exception.code)
        self.assertEqual(4096, failure.exception.usage['completion_tokens'])


class RetryAndNormalizationTest(unittest.TestCase):
    setUp = LabelAITest.setUp
    quote = LabelAITest.quote
    generate = LabelAITest.generate
    path = LabelAITest.path
    def retry_quote(self):
        return ai.quote_retries(self.folder, self.meetings, 'deepseek-flash', 2, 8, concurrency=2)

    def retry_generate(self, q, model):
        selected = {m['id']: self.meetings[m['id']] for m in q['meetings']}
        return ai.generate_meetings(self.folder, selected, q, q['upper_cny'] + .001, q['quote_hash'], model)

    def test_normalize_only_splits_strong_boundaries_preserving_prediction(self):
        source = rows(4)
        source[1]['role'] = 'B'
        blind = ai.build_blind_plan(source, '0235', [r['id'] for r in source])
        batch = ai.build_batches(source, blind)[0]
        raw = dict(expressions=[dict(ids=batch['ids'], kind='fact', reason='原模型对整组给出的设备能力分类')])
        with self.assertRaises(ai.InvalidSuggestion):
            ai.validate_response(raw, batch, source, 'fake')
        normalized, count = ai.normalize_response_boundaries(raw, batch)
        self.assertGreater(count, 0)
        checked = ai.validate_response(normalized, batch, source, 'fake')
        self.assertEqual(batch['ids'], [uid for exp in checked for uid in exp['ids']])
        for item in normalized['expressions']:
            self.assertEqual(raw['expressions'][0]['kind'], item['kind'])
            self.assertEqual(raw['expressions'][0]['reason'], item['reason'])
        self.assertEqual(1, len(raw['expressions']))

    def test_normalize_never_repairs_ids_or_illegal_prediction(self):
        blind = ai.build_blind_plan(self.rows, '0235')
        batch = ai.build_batches(self.rows, blind)[0]
        raw = dict(expressions=[dict(ids=batch['ids'], kind='fact', reason='描述能力')])
        for bad in ('drop', 'duplicate', 'reorder', 'invent', 'kind', 'text', 'reason'):
            altered = copy.deepcopy(raw)
            item = altered['expressions'][0]
            if bad == 'drop': item['ids'].pop()
            if bad == 'duplicate': item['ids'].append(item['ids'][0])
            if bad == 'reorder': item['ids'].reverse()
            if bad == 'invent': item['ids'][0] = 'nonexistent'
            if bad == 'kind': item['kind'] = 'new_kind'
            if bad == 'text': item['text'] = '改写原文'
            if bad == 'reason': item['reason'] = ''
            with self.subTest(bad=bad), self.assertRaises(ai.InvalidSuggestion):
                ai.normalize_response_boundaries(altered, batch)

    def test_generator_records_mechanical_split_without_weakening_validator(self):
        class CrossingModel(FakeModel):
            def complete_bounded(self, user, max_tokens, timeout):
                raw, used, usage = super().complete_bounded(user, max_tokens, timeout)
                return dict(expressions=[dict(ids=[uid for e in raw['expressions'] for uid in e['ids']],
                    kind='fact', reason='描述设备能力')]), used, usage
        self.generate(model=CrossingModel())
        doc = ai.load_sidecar(self.path(), self.rows, '0235')
        self.assertEqual('ready', doc['status'])
        attempt = doc['batches'][0]['attempts'][0]
        self.assertEqual('candidate_boundary_split_v1', attempt['normalization'])
        self.assertGreater(attempt['boundary_splits'], 0)

    def test_retry_quote_excludes_success_and_freezes_failed_snapshot(self):
        self.rows = rows(80)
        self.meetings = {'0235': self.rows}
        class OneFailure(FakeModel):
            def complete_bounded(self, user, max_tokens, timeout):
                if not self.calls:
                    self.calls.append(json.loads(user))
                    raise ai.ModelFailure('transport_failed')
                return super().complete_bounded(user, max_tokens, timeout)
        initial = self.quote()
        self.generate(initial, OneFailure())
        before = ai.load_sidecar(self.path(), self.rows, '0235')
        completed = [b for b in before['batches'] if b['status'] == 'complete']
        self.assertTrue(completed)
        previous_expressions = copy.deepcopy(before['expressions'])
        with patch.object(ai.urllib.request, 'urlopen', side_effect=AssertionError('network')):
            q = self.retry_quote()
        self.assertEqual(1, len(q['meetings'][0]['batches']))
        self.assertEqual(initial['quote_hash'], q['meetings'][0]['initial_quote_hash'])
        self.assertEqual(before['blind'], q['meetings'][0]['blind'])
        self.assertLess(q['upper_cny'], initial['upper_cny'])
        model = FakeModel()
        self.retry_generate(q, model)
        self.assertEqual(1, len(model.calls))
        after = ai.load_sidecar(self.path(), self.rows, '0235')
        self.assertEqual('ready', after['status'])
        self.assertEqual(initial['quote_hash'], after['quote_hash'])
        self.assertEqual(before['blind'], after['blind'])
        for exp in previous_expressions:
            self.assertIn(exp, after['expressions'])
        for record in completed:
            self.assertEqual(record, next(b for b in after['batches'] if b['id'] == record['id']))
        failure_id = q['meetings'][0]['batches'][0]['id']
        failed_before = next(b for b in before['batches'] if b['id'] == failure_id)
        retried = next(b for b in after['batches'] if b['id'] == failure_id)
        self.assertEqual(failed_before['attempts'], retried['attempts'][:-1])
        self.assertEqual(q['quote_hash'], retried['attempts'][-1]['authorization_quote_hash'])
        self.retry_generate(q, model)
        self.assertEqual(1, len(model.calls))

    def test_failed_retry_is_capped_once_and_requires_new_quote_for_another(self):
        initial = self.quote()
        self.generate(initial, FakeModel(failure=True))
        q = self.retry_quote()
        model = FakeModel(failure=True)
        self.retry_generate(q, model)
        calls = len(model.calls)
        self.retry_generate(q, model)
        self.assertEqual(calls, len(model.calls))
        doc = ai.load_sidecar(self.path(), self.rows, '0235')
        self.assertEqual(2, len(doc['batches'][0]['attempts']))
        next_quote = self.retry_quote()
        self.assertNotEqual(q['quote_hash'], next_quote['quote_hash'])
        self.assertEqual(2, next_quote['meetings'][0]['batches'][0]['attempts_before'])

    def test_retry_budget_is_additional_and_does_not_reset_existing_spend(self):
        initial = self.quote()
        self.generate(initial, FakeModel(failure=True))
        before = ai.load_sidecar(self.path(), self.rows, '0235')
        q = self.retry_quote()
        model = FakeModel(failure=True)
        with self.assertRaises(ValueError):
            ai.generate_meetings(self.folder, self.meetings, q, 0, q['quote_hash'], model)
        self.assertEqual([], model.calls)
        self.retry_generate(q, model)
        after = ai.load_sidecar(self.path(), self.rows, '0235')
        self.assertAlmostEqual(before['charged_upper_cny'] + q['upper_cny'], after['charged_upper_cny'], places=7)
        self.assertEqual(before['batches'][0]['attempts'][0], after['batches'][0]['attempts'][0])

    def test_retry_refuses_changed_failed_state_before_network(self):
        self.generate(model=FakeModel(failure=True))
        q = self.retry_quote()
        doc = ai.load_sidecar(self.path(), self.rows, '0235')
        doc['batches'][0]['error_code'] = 'changed_state'
        ai.atomic_write(self.path(), doc)
        model = FakeModel()
        with self.assertRaises(ValueError):
            self.retry_generate(q, model)
        self.assertEqual([], model.calls)

    def test_cross_process_lock_prevents_another_generation(self):
        code = """import sys
import label_ai
try:
    with label_ai.generation_lock(sys.argv[1]):
        print('unexpected acquired')
except ValueError as error:
    print(str(error))
    sys.exit(23)
"""
        env = dict(os.environ, PYTHONPATH=os.path.dirname(ai.__file__))
        with ai.generation_lock(self.folder):
            child = subprocess.run([sys.executable, '-c', code, self.folder], env=env,
                capture_output=True, text=True, timeout=5)
            self.assertEqual(23, child.returncode)
            self.assertEqual('generation_already_running', child.stdout.strip())
        with ai.generation_lock(self.folder):
            pass

    def test_in_process_lock_blocks_prepare_and_generation_before_model(self):
        q = self.quote()
        model = FakeModel()
        with ai.generation_lock(self.folder):
            with self.assertRaises(ValueError):
                ai.prepare_meetings(self.folder, self.meetings, q)
            with self.assertRaises(ValueError):
                self.generate(q, model)
        self.assertEqual([], model.calls)


if __name__ == '__main__':
    unittest.main()
