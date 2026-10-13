#!/usr/bin/env python3
"""Synthetic export checks; semantic reviews must survive merge and folding."""
import contextlib
import copy
import io
import os
import types
import unittest
from unittest.mock import patch

import dji_to_eval as dji
import label_ai as ai
import team_label as tl
from test_label_ai_workflow import FakeSemanticModel
from test_team_label_workflow import ALICE, WorkflowFixture


class LabelExportTest(WorkflowFixture):
    def generate(self):
        meetings = {'0235':self.data.meetings['0235']['rows']}
        model = FakeSemanticModel()
        with patch.object(ai, 'load_deepseek', side_effect=AssertionError('credentials forbidden')), \
                patch.object(ai.urllib.request, 'urlopen', side_effect=AssertionError('network forbidden')):
            quote = ai.quote_meetings(self.folder, meetings, model.model, 2, 8, max_tokens=256)
            ai.prepare_meetings(self.folder, meetings, quote)
            result = ai.generate_meetings(self.folder, meetings, quote, quote['upper_cny'] + .01,
                quote['quote_hash'], model)
        self.assertEqual('ready', result['0235']['status'])

    def confirm(self, uid):
        payload = self.data.meeting_payload('0235', ALICE)
        unit = next(item for item in payload['expressions'] if uid in item['ids'])
        return self.data.review('0235', ALICE, dict(action='confirm_suggestion', review_mode='assisted',
            request_id=self.request_id(), revision=payload['revision'], expression=unit['id'],
            fingerprint=unit['fingerprint'], suggestion_fingerprint=unit['suggestion']['source']['fingerprint']))

    def export_root(self, rows, session):
        root = os.path.join(self.folder, 'synthetic-export')
        path = os.path.join(root, 'evidence', session)
        os.makedirs(path, exist_ok=True)
        self.write_json(os.path.join(path, 'meeting.json'), dict(utterances=rows))
        return root, path

    def test_merge_retains_new_semantic_and_old_expression_answers(self):
        self.set_expression(value='info')
        self.generate()
        self.confirm('a2')
        rows = self.data.rows_with_claims('0235')
        labels = {ALICE:self.data.load('0235', ALICE)}
        before = copy.deepcopy((rows, labels))
        merged = tl.merge(rows, labels, self.data.content_units('0235'))
        self.assertEqual({'a1':'info','a2':'fact','a3':'info'}, merged['kinds'])
        self.assertEqual(['a2'], merged['ai_assisted_content_ids'])
        self.assertEqual(['a1','a3'], merged['legacy_content_ids'])
        self.assertEqual('ai_assisted', merged['content_review_modes']['a2'])
        self.assertEqual('fact', next(item for item in merged['non_tasks'] if item['utterance'] == 'a2')['kind'])
        self.assertEqual('human_reviewed_development', merged['scope'])
        self.assertFalse(merged['blind'])
        self.assertFalse(merged['blind_accuracy_established'])
        self.assertEqual(before, (rows, labels))

    def test_merge_rejects_changed_semantic_evidence_instead_of_reusing_stale_labels(self):
        self.generate()
        self.confirm('a1')
        rows = self.data.rows_with_claims('0235')
        labels = {ALICE:self.data.load('0235', ALICE)}
        units = self.data.content_units('0235')
        changed = copy.deepcopy(rows)
        changed[0]['text'] += '修订了来源。'
        with self.assertRaises(ValueError):
            tl.merge(changed, labels, units)
        # A caller falling back to the legacy grouping cannot validate ai: IDs.
        merged = tl.merge(changed, labels)
        self.assertNotIn('a1', merged['kinds'])
        self.assertEqual('fact', labels[ALICE]['a1']['kind'])

    def test_merge_command_uses_current_units_and_preserves_fact_when_folded(self):
        self.generate()
        self.confirm('a1')
        meeting_path = os.path.join(self.folder, 'meetings', '0235', 'meeting.json')
        meeting = self.read_json(meeting_path)
        stem = 'synthetic-recording-only'
        meeting['session'] = dji.session_id(stem)
        self.write_json(meeting_path, meeting)
        root, output = self.export_root(meeting['utterances'], meeting['session'])
        before = self.read_json(self.data.labels_path('0235', ALICE))
        with patch.object(tl, 'ROOT', root), patch.object(dji, 'ROOT', root), \
                patch.object(dji, 'recording', return_value=stem), contextlib.redirect_stdout(io.StringIO()):
            tl.merge_cmd(types.SimpleNamespace(data=self.folder, meetings=['0235']))
        sentence = self.read_json(os.path.join(output, 'truth.json'))
        final = self.read_json(os.path.join(output, 'truth-live.json'))
        self.assertEqual({'a1':'fact'}, sentence['kinds'])
        self.assertEqual([('final-a','a1','fact')],
            [(item['utterance'],item['sentence'],item['kind']) for item in final['non_tasks']])
        self.assertEqual('final', final['granularity'])
        self.assertEqual('sentence', final['content_review_granularity'])
        self.assertEqual({'a1':'ai_assisted'}, final['content_review_modes'])
        self.assertFalse(final['blind'])
        self.assertEqual(before, self.read_json(self.data.labels_path('0235', ALICE)))

    def test_fact_is_a_task_negative_but_never_negates_a_task_in_the_same_parent(self):
        rows = [dict(id='fact-alone', parent='p-fact', text='设备有麦克风。', start_ms=0, end_ms=1000),
                dict(id='task', parent='p-mixed', text='明天请提交方案。', start_ms=2000, end_ms=3000),
                dict(id='fact-mixed', parent='p-mixed', text='现在已经有草稿。', start_ms=3000, end_ms=4000)]
        truth = tl.merge(rows, {ALICE:{'fact-alone':{'kind':'fact'},
            'task':{'kind':'task','owner':ALICE},'fact-mixed':{'kind':'fact'}}})
        stem = 'synthetic-fact-folding'
        sid = dji.session_id(stem)
        root, output = self.export_root(rows, sid)
        self.write_json(os.path.join(output, 'truth.json'), truth)
        with patch.object(dji, 'ROOT', root), patch.object(dji, 'recording', return_value=stem):
            dji.fold_truth('0235')
        folded = self.read_json(os.path.join(output, 'truth-live.json'))
        self.assertEqual(['p-mixed'], [item['utterance'] for item in folded['tasks']])
        self.assertEqual([('p-fact','fact')], [(item['utterance'],item['kind']) for item in folded['non_tasks']])
        self.assertEqual('fact', folded['kinds']['fact-mixed'])
        self.assertEqual('legacy_unknown', folded['content_review_modes']['fact-alone'])


if __name__ == '__main__':
    unittest.main()
