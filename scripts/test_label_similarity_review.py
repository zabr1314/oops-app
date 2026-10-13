#!/usr/bin/env python3
"""Similarity group transaction tests; only local fake model responses."""
import copy
import json
import os
import shutil
import unittest
from unittest.mock import patch

import label_ai as ai
import label_similarity_review as sr
import team_label as tl
from test_label_ai_workflow import FakeSemanticModel
from test_team_label_workflow import ALICE, BOB, WorkflowFixture


class SimilarityReviewTest(WorkflowFixture):
    def setUp(self):
        super().setUp()
        for target in ('label_ai.load_deepseek', 'urllib.request.urlopen'):
            guard = patch(target, side_effect=AssertionError('real model access forbidden'))
            guard.start()
            self.addCleanup(guard.stop)
        meetings = {mid: meeting['rows'] for mid, meeting in self.data.meetings.items()}
        quote = ai.quote_meetings(self.folder, meetings, FakeSemanticModel.model, 2, 8,
            max_tokens=256, max_attempts=1, concurrency=1)
        ai.prepare_meetings(self.folder, meetings, quote)
        result = ai.generate_meetings(self.folder, meetings, quote, quote['upper_cny'] + .01,
            quote['quote_hash'], FakeSemanticModel())
        self.assertTrue(all(item['status'] == 'ready' for item in result.values()))

    def member(self, mid, uid=None):
        payload = self.data.meeting_payload(mid, ALICE)
        expression = next(item for item in payload['expressions'] if item.get('suggestion')
            and (uid is None or uid in item['ids']))
        return dict(meeting=mid, title='合成会议', expression=expression['id'],
            fingerprint=expression['fingerprint'],
            suggestion_fingerprint=expression['suggestion']['source']['fingerprint'],
            kind=expression['suggestion']['kind'], text=expression['text'], score=90)

    def group_body(self, members=None):
        members = members or [self.member('0235', 'a1'), self.member('0235', 'a2'), self.member('0236')]
        group = dict(anchor=members[0], candidates=members[1:], group_fingerprint='synthetic-group-fingerprint')
        body = dict(action='confirm_group', request_id=self.request_id(), anchor=copy.deepcopy(members[0]),
            items=copy.deepcopy(members), threshold=80, scope='all',
            group_fingerprint=group['group_fingerprint'],
            revisions={mid: self.data._document(mid, ALICE)['revision'] for mid in {item['meeting'] for item in members}})
        return group, body

    def confirm(self, members=None):
        group, body = self.group_body(members)
        return body, sr.review(self.data, ALICE, body, lambda: group)

    def undo_group(self, original, **extra):
        body = dict(action='undo_group', request_id=self.request_id(), group_request_id=original['request_id'], **extra)
        return body, sr.review(self.data, ALICE, body)

    def stored(self, mid):
        return sr._read(self.data.labels_path(mid, ALICE))

    def test_cross_meeting_confirmation_has_individual_source_and_group_receipt(self):
        body, result = self.confirm()
        self.assertEqual('complete', result['status'])
        self.assertEqual({'0235': 1, '0236': 1}, result['meetings'])
        self.assertEqual(3, result['transaction']['affected_expressions'])
        for item in body['items']:
            doc = self.stored(item['meeting'])
            unit = next(unit for unit in self.data.content_units(item['meeting']) if unit['id'] == item['expression'])
            for uid in unit['ids']:
                source = doc['labels'][uid]['kind_source']
                self.assertEqual(('fact', 'ai_assisted', body['request_id']),
                    (doc['labels'][uid]['kind'], source['review_mode'], source['group_transaction']))
                self.assertEqual(item['expression'], source['id'])
                self.assertEqual(item['suggestion_fingerprint'], source['suggestion_fingerprint'])
            self.assertEqual(body['request_id'], doc['history'][-1]['group_transaction'])
        self.assertEqual(body['request_id'], sr.latest_undo(self.data, ALICE)['request_id'])
        self.assertIsNone(sr.latest_undo(self.data, BOB))

    def test_multi_member_confirmation_validates_each_meeting_once(self):
        group, body = self.group_body()
        self.assertGreater(len(body['items']), len(body['revisions']))
        with patch.object(self.data, 'annotation_state', wraps=self.data.annotation_state) as annotation, \
                patch.object(self.data, 'content_units', side_effect=AssertionError('do not reload sidecars')), \
                patch.object(sr, 'expressions', wraps=sr.expressions) as build_units:
            result = sr.review(self.data, ALICE, body, lambda: group)
        self.assertEqual('complete', result['status'])
        self.assertEqual(2, annotation.call_count)
        self.assertEqual(['0235', '0236'], [call.args[0] for call in annotation.call_args_list])
        self.assertEqual(2, build_units.call_count)
        self.assertEqual([self.data.meetings[mid]['rows'] for mid in ('0235', '0236')],
            [call.args[0] for call in build_units.call_args_list])

    def test_replay_does_not_resolve_again_or_add_another_history_entry(self):
        group, body = self.group_body()
        first = sr.review(self.data, ALICE, body, lambda: group)
        before = {mid: self.stored(mid) for mid in self.data.meetings}
        self.data = tl.Data(self.folder)
        repeated = sr.review(self.data, ALICE, body,
            lambda: self.fail('idempotent replay must not resolve a changed group'))
        self.assertEqual(first, repeated)
        self.assertEqual(before, {mid: self.stored(mid) for mid in self.data.meetings})
        with self.assertRaisesRegex(ValueError, 'reused'):
            sr.review(self.data, ALICE, dict(body, threshold=70), lambda: group)

    def test_three_meetings_are_confirmed_and_undone_as_one_request(self):
        new_path = os.path.join(self.folder, 'meetings', '0238')
        shutil.copytree(os.path.join(self.folder, 'meetings', '0236'), new_path)
        os.unlink(os.path.join(new_path, 'suggestions.json'))
        self.data = tl.Data(self.folder)
        meetings = {'0238': self.data.meetings['0238']['rows']}
        quote = ai.quote_meetings(self.folder, meetings, FakeSemanticModel.model, 2, 8,
            max_tokens=256, max_attempts=1, concurrency=1)
        ai.prepare_meetings(self.folder, meetings, quote)
        ai.generate_meetings(self.folder, meetings, quote, quote['upper_cny'] + .01,
            quote['quote_hash'], FakeSemanticModel())
        body, result = self.confirm([self.member('0235', 'a1'), self.member('0236'), self.member('0238')])
        self.assertEqual({'0235': 1, '0236': 1, '0238': 1}, result['meetings'])
        _, undone = self.undo_group(body)
        self.assertEqual(['0235', '0236', '0238'], undone['transaction']['affected_meetings'])
        self.assertTrue(all(not self.stored(mid)['labels'] for mid in self.data.meetings))

    def test_changed_revision_fingerprint_or_unviewed_member_never_writes(self):
        group, original = self.group_body()
        mutations = []
        body = copy.deepcopy(original)
        body['revisions']['0236'] += 1
        mutations.append(body)
        body = copy.deepcopy(original)
        body['items'][1]['fingerprint'] = 'stale-source'
        mutations.append(body)
        body = copy.deepcopy(original)
        body['items'][1]['suggestion_fingerprint'] = 'stale-suggestion'
        mutations.append(body)
        body = copy.deepcopy(original)
        body['group_fingerprint'] = 'old-group'
        mutations.append(body)
        body = copy.deepcopy(original)
        body['items'].append(self.member('0235', 'a3'))
        mutations.append(body)
        for body in mutations:
            with self.subTest(body=body), self.assertRaises(sr.SimilarityConflict):
                sr.review(self.data, ALICE, body, lambda: group)
            self.assertTrue(all(self.stored(mid) is None for mid in self.data.meetings))

    def test_existing_answer_single_exception_and_legacy_kind_are_preserved(self):
        for label in ({'kind': 'noise'}, {'kind': 'fact', 'kind_source': dict(
                mode='single', id='a2', fingerprint='old-source', review_mode='ai_assisted')}):
            with self.subTest(label=label):
                path = self.data.labels_path('0235', ALICE)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                self.write_json(path, dict(labels={'a2': label}, revision=0))
                group, body = self.group_body()
                before = self.stored('0235')
                with self.assertRaises(sr.SimilarityConflict):
                    sr.review(self.data, ALICE, body, lambda: group)
                self.assertEqual(before, self.stored('0235'))
                self.assertIsNone(self.stored('0236'))

    def test_group_cannot_include_blind_targets_even_in_forged_current_group(self):
        group, body = self.group_body()
        blind = self.data.meeting_payload('0235', ALICE, 'blind')['expressions'][0]
        forged = dict(meeting='0235', expression=blind['id'], fingerprint=blind['fingerprint'],
            suggestion_fingerprint='forged-model-suggestion', kind='fact')
        group['candidates'].append(forged)
        body['items'].append(forged)
        with self.assertRaises(sr.SimilarityConflict):
            sr.review(self.data, ALICE, body, lambda: group)
        self.assertTrue(all(self.stored(mid) is None for mid in self.data.meetings))
        self.assertFalse(set(self.data.annotation_state('0235')[0]['blind']['ids']) & self.data._exposed('0235', ALICE))

    def test_task_and_decision_categories_never_batch_confirm(self):
        for kind in ('task', 'decision', 'uncertain'):
            group, body = self.group_body()
            group['anchor']['kind'] = kind
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                sr.review(self.data, ALICE, body, lambda: group)
        self.assertTrue(all(self.stored(mid) is None for mid in self.data.meetings))

    def test_source_change_after_group_view_rejects_every_member(self):
        group, body = self.group_body()
        self.data.meetings['0236']['rows'][0]['text'] += '（来源修改）'
        with self.assertRaises(sr.SimilarityConflict):
            sr.review(self.data, ALICE, body, lambda: group)
        self.assertTrue(all(self.stored(mid) is None for mid in self.data.meetings))

    def test_readonly_reviewed_anchor_stays_unchanged_while_related_members_confirm(self):
        self.set_row('a1', 'kind', 'fact')
        group, body = self.group_body()
        group['anchor']['readonly'] = True
        body['items'] = body['items'][1:]
        before = copy.deepcopy(self.stored('0235')['labels']['a1'])
        result = sr.review(self.data, ALICE, body, lambda: group)
        self.assertEqual(2, result['transaction']['affected_expressions'])
        self.assertEqual(before, self.stored('0235')['labels']['a1'])
        self.assertEqual('fact', self.stored('0235')['labels']['a2']['kind'])

    def test_undo_group_rebases_later_correction_so_it_cannot_revive_old_group(self):
        body, _ = self.confirm()
        self.set_row('a1', 'kind', 'noise')
        correction = copy.deepcopy(self.stored('0235')['labels']['a1'])
        undo_body, result = self.undo_group(body)
        self.assertEqual('undo_group', result['transaction']['action'])
        self.assertEqual(correction, self.stored('0235')['labels']['a1'])
        self.assertNotIn('a2', self.stored('0235')['labels'])
        self.assertEqual({}, self.stored('0236')['labels'])
        self.assertIsNone(sr.latest_undo(self.data, ALICE))
        self.assertEqual(result, sr.review(self.data, ALICE, undo_body))
        self.data = tl.Data(self.folder)
        self.undo(mid='0235')
        self.assertEqual({}, self.stored('0235')['labels'], 'later single undo must not resurrect the removed group')

    def test_meeting_undo_then_new_correction_is_not_touched_by_group_undo(self):
        body, _ = self.confirm()
        self.undo(mid='0235')
        self.set_row('a1', 'kind', 'info')
        before = copy.deepcopy(self.stored('0235'))
        _, result = self.undo_group(body)
        self.assertEqual(['0236'], result['transaction']['affected_meetings'])
        self.assertEqual(before, self.stored('0235'))
        self.assertEqual({}, self.stored('0236')['labels'])
        self.undo(mid='0235')
        self.assertEqual({}, self.stored('0235')['labels'])

    def test_group_undo_preserves_existing_speaker_and_blind_history(self):
        self.set_row('a1', 'speaker', BOB)
        blind = self.data.meeting_payload('0235', ALICE, 'blind')
        row = blind['rows'][0]
        self.data.review('0235', ALICE, dict(action='set', request_id=self.request_id(),
            revision=blind['revision'], review_mode='blind', scope='row', id=row['id'],
            fingerprint=row['fingerprint'], field='kind', value='fact'))
        body, _ = self.confirm()
        self.undo_group(body)
        self.assertEqual(BOB, self.stored('0235')['labels']['a1']['speaker'])
        self.assertEqual('blind', self.stored('0235')['labels'][row['id']]['kind_source']['review_mode'])
        self.assertEqual(1, self.data.meeting_payload('0235', ALICE, 'blind')['blind']['completed'])

    def test_many_ordinary_corrections_do_not_drop_the_group_undo_anchor(self):
        body, _ = self.confirm()
        for number in range(35):
            self.set_row('a1', 'kind', 'info' if number % 2 else 'noise')
        self.assertTrue(any(entry.get('group_transaction') == body['request_id']
            for entry in self.stored('0235')['history']))
        correction = copy.deepcopy(self.stored('0235')['labels']['a1'])
        self.undo_group(body)
        self.assertEqual(correction, self.stored('0235')['labels']['a1'])
        self.assertNotIn('a2', self.stored('0235')['labels'])

    def test_failure_after_first_file_is_not_success_and_restart_finishes_all(self):
        group, body = self.group_body()
        original_write, count = sr._atomic_write, [0]

        def fail_second_label(path, value):
            if os.sep + 'labels' + os.sep in path:
                count[0] += 1
                if count[0] == 2:
                    raise OSError('synthetic disk failure')
            return original_write(path, value)

        with patch.object(sr, '_atomic_write', side_effect=fail_second_label), self.assertRaises(OSError):
            sr.review(self.data, ALICE, body, lambda: group)
        self.assertIsNotNone(self.stored('0235'))
        self.assertIsNone(self.stored('0236'))
        journal = sr._read(sr._journal_path(self.data, ALICE, body['request_id']))
        self.assertEqual('prepared', journal['status'])
        self.data = tl.Data(self.folder)  # Startup recovery runs before reading answers.
        self.assertEqual('committed', sr._read(sr._journal_path(self.data, ALICE, body['request_id']))['status'])
        result = sr.review(self.data, ALICE, body, lambda: self.fail('replay must use journal'))
        self.assertEqual('complete', result['status'])
        self.assertEqual({'0235': 1, '0236': 1}, result['meetings'])

    def test_failure_before_prepared_journal_leaves_every_answer_untouched(self):
        group, body = self.group_body()
        with patch.object(sr, '_atomic_write', side_effect=OSError('synthetic journal failure')), self.assertRaises(OSError):
            sr.review(self.data, ALICE, body, lambda: group)
        self.assertTrue(all(self.stored(mid) is None for mid in self.data.meetings))

    def test_final_receipt_failure_recovers_without_applying_the_group_twice(self):
        group, body = self.group_body()
        original_write = sr._atomic_write

        def fail_committed_receipt(path, value):
            if os.sep + 'similarity_requests' + os.sep in path and value.get('status') == 'committed':
                raise OSError('synthetic receipt failure')
            return original_write(path, value)

        with patch.object(sr, '_atomic_write', side_effect=fail_committed_receipt), self.assertRaises(OSError):
            sr.review(self.data, ALICE, body, lambda: group)
        self.assertTrue(all(self.stored(mid)['revision'] == 1 for mid in self.data.meetings))
        self.data = tl.Data(self.folder)
        result = sr.review(self.data, ALICE, body, lambda: self.fail('do not recompute or reapply'))
        self.assertEqual({'0235': 1, '0236': 1}, result['meetings'])
        self.assertTrue(all(len(self.stored(mid)['history']) == 1 for mid in self.data.meetings))

    def test_interrupted_group_undo_resumes_all_meetings_and_keeps_later_correction(self):
        original, _ = self.confirm()
        self.set_row('a1', 'kind', 'noise')
        undo_body = dict(action='undo_group', request_id=self.request_id(), group_request_id=original['request_id'])
        original_write, count = sr._atomic_write, [0]

        def fail_second_label(path, value):
            if os.sep + 'labels' + os.sep in path:
                count[0] += 1
                if count[0] == 2:
                    raise OSError('synthetic undo write failure')
            return original_write(path, value)

        with patch.object(sr, '_atomic_write', side_effect=fail_second_label), self.assertRaises(OSError):
            sr.review(self.data, ALICE, undo_body)
        self.data = tl.Data(self.folder)
        self.assertEqual('noise', self.stored('0235')['labels']['a1']['kind'])
        self.assertNotIn('a2', self.stored('0235')['labels'])
        self.assertEqual({}, self.stored('0236')['labels'])
        result = sr.review(self.data, ALICE, undo_body)
        self.assertEqual('complete', result['status'])
        self.undo(mid='0235')
        self.assertEqual({}, self.stored('0235')['labels'])

    def test_recovery_refuses_to_overwrite_an_outside_change(self):
        group, body = self.group_body()
        original_write = sr._atomic_write

        def fail_label(path, value):
            if os.sep + 'labels' + os.sep in path:
                raise OSError('synthetic disk failure')
            return original_write(path, value)

        with patch.object(sr, '_atomic_write', side_effect=fail_label), self.assertRaises(OSError):
            sr.review(self.data, ALICE, body, lambda: group)
        path = self.data.labels_path('0236', ALICE)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        outside = dict(labels={'c1': {'kind': 'noise'}}, revision=99)
        self.write_json(path, outside)
        with self.assertRaises(sr.SimilarityRecoveryError):
            sr.recover(self.data)
        self.assertEqual(outside, self.stored('0236'))
        self.assertIsNone(self.stored('0235'), 'all targets must be checked before any recovery write')


if __name__ == '__main__':
    unittest.main()
