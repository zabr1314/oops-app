#!/usr/bin/env python3
"""Temporary-data integration tests; every model response is a local fake."""
import copy
import io
import json
import os
import unittest
from unittest.mock import patch

import label_ai as ai
import team_label as tl
from test_team_label_workflow import ALICE, BOB, WorkflowFixture


class FakeSemanticModel:
    model = 'synthetic-model-only'

    def __init__(self, kinds=None, groups=None):
        self.kinds, self.groups, self.calls = kinds or {}, groups or [], []

    def complete_bounded(self, user, max_tokens, timeout):
        payload = json.loads(user)
        self.calls.append(payload)
        targets = payload['targets']
        by_start = {group[0]: group for group in self.groups}
        expressions, index = [], 0
        while index < len(targets):
            uid = targets[index]['id']
            group = by_start.get(uid, [uid])
            expressions.append(dict(ids=group, kind=self.kinds.get(uid, 'fact'), reason='合成判断依据。'))
            index += len(group)
        return dict(expressions=expressions), self.model, dict(
            prompt_tokens=100, completion_tokens=50, total_tokens=150)


class LabelAIWorkflowTest(WorkflowFixture):
    def setUp(self):
        super().setUp()
        # A test must fail before accessing credentials or making a real request.
        for target in ('label_ai.load_deepseek', 'urllib.request.urlopen'):
            guard = patch(target, side_effect=AssertionError('real model access is forbidden in this fixture'))
            guard.start()
            self.addCleanup(guard.stop)
        self.meetings = {'0235': self.data.meetings['0235']['rows']}
        self.quote = None

    def prepare(self):
        self.quote = ai.quote_meetings(self.folder, self.meetings, FakeSemanticModel.model, 2, 8,
            max_tokens=256, max_attempts=1, concurrency=1)
        ai.prepare_meetings(self.folder, self.meetings, self.quote)
        return self.quote

    def generate(self, kinds=None, groups=None):
        quote = self.quote or self.prepare()
        self.model = FakeSemanticModel(kinds, groups)
        result = ai.generate_meetings(self.folder, self.meetings, quote, quote['upper_cny'] + .01,
            quote['quote_hash'], self.model)
        self.assertEqual('ready', result['0235']['status'])
        self.assertTrue(self.model.calls)
        return ai.load_sidecar(os.path.join(self.folder, 'meetings', '0235', 'suggestions.json'),
            self.meetings['0235'], '0235')

    def payload(self, mode='assisted', name=ALICE):
        return self.data.meeting_payload('0235', name, mode)

    def suggestion_item(self, expression):
        return dict(expression=expression['id'], fingerprint=expression['fingerprint'],
            suggestion_fingerprint=expression['suggestion']['source']['fingerprint'])

    def confirm_body(self, uid='a1', batch_ids=None, name=ALICE):
        payload = self.payload(name=name)
        units = {uid: unit for unit in payload['expressions'] for uid in unit['ids']}
        body = dict(request_id=self.request_id(), revision=payload['revision'], review_mode='assisted')
        if batch_ids is None:
            body.update(action='confirm_suggestion', **self.suggestion_item(units[uid]))
        else:
            body.update(action='confirm_suggestions', items=[self.suggestion_item(units[item]) for item in batch_ids])
        return body

    def stored(self, name=ALICE):
        path = self.data.labels_path('0235', name)
        if not os.path.exists(path):
            return None
        with open(path, 'rb') as stream:
            return stream.read()

    def blind_row_body(self, field='kind', value='fact', uid=None):
        payload = self.payload('blind')
        row = next(row for row in payload['rows'] if uid is None or row['id'] == uid)
        return dict(request_id=self.request_id(), revision=payload['revision'], action='set', scope='row',
            id=row['id'], fingerprint=row['fingerprint'], field=field, value=value, review_mode='blind')

    def undo_mode(self, mode):
        return dict(action='undo', request_id=self.request_id(), revision=self.payload(mode)['revision'],
            review_mode=mode)

    def legacy_save_response(self, labels):
        # Exercise the actual route in memory: no HTTP socket, credential, or model request.
        handler = object.__new__(tl.make_handler(self.data, 'synthetic-route-test-only'))
        raw = json.dumps(labels).encode()
        handler.path = '/api/meeting/0235/labels'
        handler.headers = {'Content-Length': str(len(raw)), 'X-Label-Revision': str(self.payload()['revision'])}
        handler.rfile = io.BytesIO(raw)
        handler.who = lambda _query: ALICE
        responses = []
        handler.send = lambda status, body, *_args: responses.append((status, json.loads(body)))
        handler.do_POST()
        self.assertEqual(1, len(responses))
        return responses[0]

    def test_assisted_payload_delivers_suggestions_without_reserved_text(self):
        sidecar = self.generate()
        reserved = set(sidecar['blind']['ids'])
        payload = self.payload()
        self.assertTrue(reserved)
        self.assertEqual({row['id'] for row in self.meetings['0235']} - reserved,
            {row['id'] for row in payload['rows']})
        self.assertTrue(all(unit['suggestion'] for unit in payload['expressions']))
        self.assertTrue(all(not reserved.intersection(unit['ids']) for unit in payload['expressions']))
        self.assertEqual('ready', payload['assistance']['status'])
        self.assertEqual(FakeSemanticModel.model, payload['assistance']['model'])
        self.assertEqual(set(row['id'] for row in payload['rows']), self.data._exposed('0235', ALICE))
        sent = [row['id'] for call in self.model.calls for row in call['targets'] + call['context']]
        self.assertFalse(reserved.intersection(sent))
        self.assertIsNone(self.stored(), 'Delivering suggestions must not submit human answers')

    def test_blind_payload_has_only_fixed_sample_and_no_prediction(self):
        quote = self.prepare()
        reserved = quote['meetings'][0]['blind']['ids']
        before = self.payload('blind')
        self.assertEqual(set(reserved), {row['id'] for row in before['rows']})
        self.assertTrue(all(unit['suggestion'] is None for unit in before['expressions']))
        self.assertIsNone(before['assistance'])
        self.assertEqual(set(), self.data._exposed('0235', ALICE))
        first = before['rows'][0]
        body = dict(request_id=self.request_id(), revision=before['revision'], action='set', scope='row',
            id=first['id'], fingerprint=first['fingerprint'], field='kind', value='fact', review_mode='blind')
        result = self.data.review('0235', ALICE, body)
        self.assertEqual('blind', result['labels'][first['id']]['kind_source']['review_mode'])
        self.generate()
        self.payload()
        after = self.payload('blind')
        self.assertEqual(set(reserved), {row['id'] for row in after['rows']})
        self.assertTrue(all(unit['suggestion'] is None for unit in after['expressions']))
        self.assertFalse(set(reserved).intersection(self.data._exposed('0235', ALICE)))
        self.assertEqual(1, after['blind']['completed'])

    def test_invalid_or_legacy_blind_answers_never_complete_a_sample(self):
        self.prepare()
        body = self.blind_row_body()
        self.data.review('0235', ALICE, body)
        path = self.data.labels_path('0235', ALICE)
        original = self.read_json(path)
        uid = body['id']
        self.assertEqual(1, self.payload('blind')['blind']['completed'])
        for invalid_source in (
                dict(original['labels'][uid]['kind_source'], fingerprint='outdated-source'),
                dict(original['labels'][uid]['kind_source'], id='different-sentence'),
                dict(original['labels'][uid]['kind_source'], review_mode='assisted'),
                None):
            with self.subTest(source=invalid_source):
                broken = copy.deepcopy(original)
                if invalid_source is None:
                    broken['labels'][uid].pop('kind_source')
                else:
                    broken['labels'][uid]['kind_source'] = invalid_source
                self.write_json(path, broken)
                stored = self.stored()
                payload = self.payload('blind')
                self.assertGreater(payload['blind']['total'], 0)
                self.assertEqual(0, payload['blind']['completed'])
                self.assertEqual(payload['blind']['total'], payload['blind']['remaining'])
                self.assertEqual(stored, self.stored(), 'Reading invalid answers must not rewrite them')

    def test_stale_sidecar_cannot_report_completion_or_accept_legacy_forgery(self):
        self.prepare()
        body = self.blind_row_body()
        self.data.review('0235', ALICE, body)
        before = self.stored()
        meeting_path = os.path.join(self.folder, 'meetings', '0235', 'meeting.json')
        meeting = self.read_json(meeting_path)
        next(row for row in meeting['utterances'] if row['id'] == body['id'])['text'] += '来源已修订。'
        self.write_json(meeting_path, meeting)
        self.data = tl.Data(self.folder)
        self.assertEqual('stale', self.payload()['assistance']['status'])
        blind = self.payload('blind')
        self.assertEqual([], blind['rows'])
        self.assertEqual(dict(total=0, completed=0, remaining=0), blind['blind'])
        status, result = self.legacy_save_response({body['id']: {'kind':'fact', 'kind_source': dict(
            mode='single', id=body['id'], fingerprint='forged', review_mode='blind')}})
        self.assertEqual((409, {'error':'upgrade_required'}), (status, result))
        self.assertEqual(before, self.stored())

    def test_legacy_save_cannot_issue_blind_or_model_provenance(self):
        row = self.payload()['rows'][0]
        forged = {'kind':'fact', 'kind_source':dict(mode='single', id=row['id'],
            fingerprint=row['fingerprint'], review_mode='blind', suggestion_fingerprint='forged',
            model='forged-model', prompt_version='forged-prompt')}
        status, _ = self.legacy_save_response({row['id']: forged})
        self.assertEqual(200, status)
        source = self.read_json(self.data.labels_path('0235', ALICE))['labels'][row['id']]['kind_source']
        self.assertEqual({'mode','id','fingerprint'}, set(source))
        self.assertEqual('fact', self.payload()['labels'][row['id']]['kind'])

    def test_cross_mode_undo_preserves_the_other_modes_saved_answers(self):
        self.generate()
        self.data.review('0235', ALICE, self.confirm_body(uid='a1'))
        blind_body = self.blind_row_body()
        blind_uid = blind_body['id']
        self.data.review('0235', ALICE, blind_body)
        self.data.review('0235', ALICE, self.confirm_body(uid='a2'))
        self.data = tl.Data(self.folder)
        first = self.undo_mode('assisted')
        assisted = self.data.review('0235', ALICE, first)
        self.assertEqual('assisted', assisted['review_mode'])
        self.assertEqual('fact', assisted['labels']['a1']['kind'])
        self.assertNotIn('a2', assisted['labels'])
        self.assertEqual('fact', self.payload('blind')['labels'][blind_uid]['kind'])
        self.assertEqual(1, self.payload('blind')['blind']['completed'])
        stored = self.stored()
        self.assertEqual(assisted, self.data.review('0235', ALICE, first))
        self.assertEqual(stored, self.stored(), 'Replaying an undo must not pop another mode or history entry')
        with self.assertRaises(ValueError):
            self.data.review('0235', ALICE, dict(first, review_mode='blind'))
        self.assertEqual(stored, self.stored())
        self.data = tl.Data(self.folder)
        blind = self.data.review('0235', ALICE, self.undo_mode('blind'))
        self.assertEqual('blind', blind['review_mode'])
        self.assertEqual({}, blind['labels'])
        self.assertFalse(blind['can_undo'])
        self.assertEqual(0, blind['blind']['completed'])
        self.assertEqual('fact', self.payload()['labels']['a1']['kind'])
        self.assertTrue(self.payload()['can_undo'])
        self.data = tl.Data(self.folder)
        self.data.review('0235', ALICE, self.undo_mode('assisted'))
        self.assertEqual({}, self.payload()['labels'])
        self.assertFalse(self.payload()['can_undo'])
        self.assertFalse(self.payload('blind')['can_undo'])

    def test_blind_undo_preserves_later_assisted_correction_after_source_change(self):
        self.prepare()
        body = self.blind_row_body()
        self.data.review('0235', ALICE, body)
        meeting_path = os.path.join(self.folder, 'meetings', '0235', 'meeting.json')
        meeting = self.read_json(meeting_path)
        original = copy.deepcopy(meeting)
        next(row for row in meeting['utterances'] if row['id'] == body['id'])['text'] += '来源已修订。'
        self.write_json(meeting_path, meeting)
        self.data = tl.Data(self.folder)
        self.assertEqual('stale', self.payload()['assistance']['status'])
        correction = dict(self.row_body(body['id'], 'kind', 'noise'), review_mode='assisted')
        self.data.review('0235', ALICE, correction)
        current = copy.deepcopy(self.payload()['labels'][body['id']])
        self.data = tl.Data(self.folder)
        undo = self.undo_mode('blind')
        result = self.data.review('0235', ALICE, undo)
        self.assertEqual('blind', result['review_mode'])
        self.assertFalse(result['can_undo'])
        self.assertEqual(current, self.payload()['labels'].get(body['id']),
            'Undoing an older blind operation must retain a later assisted correction of the same sentence')
        self.assertTrue(self.payload()['can_undo'])
        stored = self.stored()
        self.data.review('0235', ALICE, undo)
        self.assertEqual(stored, self.stored())
        self.data.review('0235', ALICE, self.undo_mode('assisted'))
        self.write_json(meeting_path, original)
        self.data = tl.Data(self.folder)
        restored = self.payload('blind')
        self.assertFalse(restored['labels'].get(body['id'], {}).get('kind'),
            'Undoing the later correction must not revive an already undone blind answer')
        self.assertEqual(0, restored['blind']['completed'])

    def test_fact_confirmation_has_ai_assisted_provenance_and_idempotent_receipt(self):
        self.generate()
        body = self.confirm_body()
        first = self.data.review('0235', ALICE, body)
        label = first['labels']['a1']
        self.assertEqual('fact', label['kind'])
        self.assertEqual('ai_assisted', label['kind_source']['review_mode'])
        self.assertEqual(body['suggestion_fingerprint'], label['kind_source']['suggestion_fingerprint'])
        self.assertEqual(FakeSemanticModel.model, label['kind_source']['model'])
        self.assertEqual(ai.PROMPT_VERSION, label['kind_source']['prompt_version'])
        self.assertEqual(first, self.data.review('0235', ALICE, body))
        self.assertEqual(1, len(self.read_json(self.data.labels_path('0235', ALICE))['history']))

    def test_batch_fact_confirmation_applies_only_requested_unlabelled_expressions(self):
        self.generate()
        result = self.data.review('0235', ALICE, self.confirm_body(batch_ids=['a1', 'a2']))
        self.assertEqual({'a1','a2'}, {uid for uid, label in result['labels'].items() if label.get('kind')})
        self.assertTrue(all(result['labels'][uid]['kind'] == 'fact' for uid in ('a1','a2')))
        self.assertTrue(all(result['labels'][uid]['kind_source']['review_mode'] == 'ai_assisted'
            for uid in ('a1','a2')))
        self.assertEqual(1, result['revision'])

    def test_duplicate_batch_or_task_decision_batch_never_writes_partial_labels(self):
        self.generate(kinds={'a2':'task', 'a3':'decision'})
        for ids, error in ((['a1','a1'], tl.RevisionConflict), (['a1','a2'], ValueError),
                           (['short','a3'], ValueError)):
            body = self.confirm_body(batch_ids=ids)
            before = self.stored()
            with self.subTest(ids=ids), self.assertRaises(error):
                self.data.review('0235', ALICE, body)
            self.assertEqual(before, self.stored())
            self.assertEqual(0, self.payload()['revision'])
            self.assertEqual({}, self.payload()['labels'])

    def test_batch_with_existing_answer_or_single_exception_is_atomic(self):
        self.generate()
        self.set_row('a2', 'kind', 'noise')
        body = self.confirm_body(batch_ids=['a1','a2'])
        before = self.stored()
        with self.assertRaises(tl.RevisionConflict):
            self.data.review('0235', ALICE, body)
        self.assertEqual(before, self.stored())
        self.assertEqual('noise', self.labels()['a2']['kind'])
        self.assertNotIn('a1', self.labels())

    def test_batch_cannot_overwrite_a_legacy_human_answer(self):
        self.data.save('0235', ALICE, {'a2':{'kind':'info'}})
        self.generate()
        body = self.confirm_body(batch_ids=['a1','a2'])
        before = self.stored()
        with self.assertRaises(tl.RevisionConflict):
            self.data.review('0235', ALICE, body)
        self.assertEqual(before, self.stored())
        self.assertEqual({'a2':{'kind':'info'}}, self.labels())

    def test_single_correction_survives_reconfirm_and_undo_restores_it(self):
        self.generate(groups=[['a1','a2','a3']])
        self.data.review('0235', ALICE, self.confirm_body())
        self.set_row('a2', 'kind', 'noise')
        self.data.review('0235', ALICE, self.confirm_body())
        self.assertEqual('noise', self.labels()['a2']['kind'])
        self.assertEqual('single', self.labels()['a2']['kind_source']['mode'])
        self.undo()
        self.assertEqual('noise', self.labels()['a2']['kind'])
        self.data = tl.Data(self.folder)
        self.undo()
        self.assertEqual('fact', self.labels()['a2']['kind'])
        self.assertEqual('ai_assisted', self.labels()['a2']['kind_source']['review_mode'])
        self.undo()
        self.assertEqual({}, self.labels())
        self.assertTrue(self.data._exposed('0235', ALICE), 'Undo must not erase prior AI exposure')

    def test_forged_blind_write_to_assisted_target_is_rejected(self):
        self.generate()
        body = dict(self.row_body('a1', 'kind', 'fact'), review_mode='blind')
        before = self.stored()
        with self.assertRaises(tl.RevisionConflict):
            self.data.review('0235', ALICE, body)
        self.assertEqual(before, self.stored())
        suggestion = dict(self.confirm_body(), review_mode='blind')
        with self.assertRaises(ValueError):
            self.data.review('0235', ALICE, suggestion)
        self.assertEqual(before, self.stored())

    def test_old_expression_answers_survive_new_semantic_boundaries(self):
        self.set_expression(value='info')
        stored = self.stored()
        old = copy.deepcopy(self.labels())
        self.generate()
        payload = self.payload()
        self.assertEqual(stored, self.stored())
        self.assertEqual(old, payload['labels'])
        self.assertTrue(all(payload['labels'][uid]['kind_source']['id'] == 'expr:a1'
            for uid in ('a1','a2','a3')))
        self.assertEqual(['ai:a1','ai:a2','ai:a3'],
            [unit['id'] for unit in payload['expressions'] if set(unit['ids']) & {'a1','a2','a3'}])
        self.assertTrue(all(unit['complete'] for unit in payload['expressions'] if 'a1' in unit['ids']))
        self.assertEqual([], payload['stale_ids'])

    def test_changed_source_withdraws_all_suggestions_without_rewriting_answers(self):
        self.generate()
        self.data.review('0235', ALICE, self.confirm_body())
        stale_confirmation = self.confirm_body(uid='a2')
        stored = self.stored()
        path = os.path.join(self.folder, 'meetings', '0235', 'meeting.json')
        meeting = self.read_json(path)
        meeting['utterances'][0]['text'] += '这句来源已经修订。'
        self.write_json(path, meeting)
        self.data = tl.Data(self.folder)
        payload = self.payload()
        self.assertEqual('stale', payload['assistance']['status'])
        self.assertTrue(all(unit['suggestion'] is None for unit in payload['expressions']))
        self.assertNotIn('kind', payload['labels'].get('a1', {}))
        self.assertIn('a1', payload['stale_ids'])
        self.assertEqual(stored, self.stored())
        with self.assertRaises(tl.RevisionConflict):
            self.data.review('0235', ALICE, stale_confirmation)
        self.assertEqual(stored, self.stored())

    def test_dynamic_role_claim_does_not_replace_machine_semantic_source(self):
        self.generate()
        self.data.review('0235', ALICE, self.confirm_body())
        self.data.claim('A', BOB, ALICE)
        payload = self.payload()
        self.assertEqual('ready', payload['assistance']['status'])
        self.assertEqual('fact', payload['labels']['a1']['kind'])
        self.assertEqual('ai_assisted', payload['labels']['a1']['kind_source']['review_mode'])
        self.assertEqual(BOB, next(row for row in payload['rows'] if row['id'] == 'a1')['voice'])
        self.assertTrue(all(unit['suggestion'] for unit in payload['expressions']))


if __name__ == '__main__':
    unittest.main()
