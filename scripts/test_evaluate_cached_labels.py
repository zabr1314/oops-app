import copy
import unittest
from evaluate_cached_labels import evaluate
from label_workflow import expressions, row_fingerprint


ROWS = [dict(id='u1-1', parent='u1', text='嗯。', start_ms=0, end_ms=300, voice='林春源', claimed=True),
        dict(id='u1-2', parent='u1', text='周五提交。', start_ms=300, end_ms=2000),
        dict(id='u2-1', parent='u2', text='对。', start_ms=2000, end_ms=2300)]
LABELS = {'洪玉麟': {'u1-1': {'kind':'noise'},
    'u1-2': {'kind':'task','speaker':'林春源','owner':'林春源'}, 'u2-1': {'kind':'noise'}}}
REPLAY = {'utterances':[{'id':'u1','text':'嗯。周五提交。','tag':'commitment'},
                         {'id':'u2','text':'对。','tag':'chitchat'}]}


class CachedLabelsTest(unittest.TestCase):
    def test_folds_mixed_sentence_labels_without_claiming_sentence_predictions(self):
        before = copy.deepcopy((ROWS, LABELS, REPLAY))
        report = evaluate(ROWS, LABELS, REPLAY)
        self.assertEqual('asr_final', report['granularity'])
        self.assertEqual(2, report['final_count'])
        self.assertEqual(1, report['effective_confusion']['effective']['effective'])
        self.assertEqual(1, report['task_and_decision']['task']['tp'])
        self.assertFalse(report['calibration_complete'])
        self.assertFalse(report['real_meeting_accepted'])
        self.assertEqual(before, (ROWS, LABELS, REPLAY))

    def test_content_scores_without_speaker_labels(self):
        labels = copy.deepcopy(LABELS)
        del labels['洪玉麟']['u1-2']['speaker']
        rows = copy.deepcopy(ROWS); rows[1]['voice'] = '林春源'
        report = evaluate(rows, labels, REPLAY)
        self.assertEqual('scored_cached_replay', report['status'])
        self.assertEqual(1, report['task_and_decision']['task']['tp'])
        self.assertEqual(0, report['independent_speaker_rows'])

    def test_conflicting_content_answers_only_exclude_their_parent(self):
        labels = copy.deepcopy(LABELS)
        labels['江古月'] = {'u1-2': {'kind':'noise','speaker':'林春源'}}
        report = evaluate(ROWS, labels, REPLAY)
        self.assertEqual(1, report['disputed_rows'])
        self.assertEqual('scored_cached_replay', report['status'])
        self.assertEqual(['u2'], report['scored_final_ids'])
        self.assertEqual(['content_dispute'], report['excluded_finals'][0]['reasons'])
        self.assertEqual(.5, report['human_content_final_coverage'])
        self.assertFalse(report['full_content_coverage'])
        self.assertEqual(1, report['effective_confusion']['noise']['noise'])

    def test_owner_disagreement_excludes_parent_but_speaker_disagreement_does_not(self):
        labels = copy.deepcopy(LABELS)
        labels['江古月'] = {'u1-2': {'speaker':'江古月'}}
        report = evaluate(ROWS, labels, REPLAY)
        self.assertEqual(2, report['scored_final_count'])
        self.assertEqual(1, report['speaker_disputed_rows'])
        labels['江古月']['u1-2']['kind'] = 'task'
        labels['江古月']['u1-2']['owner'] = '洪玉麟'
        report = evaluate(ROWS, labels, REPLAY)
        self.assertEqual(['u2'], report['scored_final_ids'])
        self.assertEqual(1, report['disputed_rows'])

    def test_partial_coverage_reports_unscored_context_and_missing_owner(self):
        labels = copy.deepcopy(LABELS)
        del labels['洪玉麟']['u2-1']
        report = evaluate(ROWS, labels, REPLAY)
        self.assertEqual(['u1'], report['scored_final_ids'])
        self.assertEqual(['u2-1'], report['excluded_finals'][0]['missing_sentence_ids'])
        self.assertEqual(.5, report['human_content_final_coverage'])
        self.assertEqual(.6667, report['human_content_sentence_coverage'])
        self.assertEqual(0, report['effective_confusion']['noise']['noise'])
        del labels['洪玉麟']['u1-2']['owner']
        report = evaluate(ROWS, labels, REPLAY)
        self.assertEqual('waiting_for_human_labels', report['status'])
        self.assertNotIn('effective_confusion', report)

    def test_voice_group_identity_is_not_content_or_independent_speaker_truth(self):
        rows = copy.deepcopy(ROWS)
        for row in rows:
            row.update(voice_group_id='role:A', voice_group_fingerprint='current')
        labels = {'洪玉麟': {row['id']: {'speaker':'林春源', 'speaker_source':{
            'mode':'voice_group','id':'role:A','fingerprint':'current'}} for row in rows}}
        report = evaluate(rows, labels, REPLAY)
        self.assertEqual('waiting_for_human_labels', report['status'])
        self.assertEqual(3, report['grouped_speaker_rows'])
        self.assertEqual(0, report['independent_speaker_rows'])
        self.assertEqual(0, report['complete_human_rows'])
        self.assertNotIn('effective_confusion', report)

    def test_unmarked_short_context_can_finish_workflow_without_becoming_noise_truth(self):
        report = evaluate(ROWS[2:], {}, {'utterances': [REPLAY['utterances'][1]]})
        self.assertTrue(report['ready_for_content'])
        self.assertEqual('waiting_for_human_labels', report['status'])
        self.assertEqual(0, report['scored_final_count'])
        self.assertEqual(['missing_content'], report['excluded_finals'][0]['reasons'])
        self.assertNotIn('effective_confusion', report)

    def test_expression_source_is_tracked_and_stale_source_is_excluded(self):
        labels = copy.deepcopy(LABELS)
        expr = next(e for e in expressions(ROWS) if 'u1-2' in e['ids'])
        labels['洪玉麟']['u1-2']['kind_source'] = {
            'mode':'expression','id':expr['id'],'fingerprint':expr['fingerprint']}
        report = evaluate(ROWS, labels, REPLAY)
        self.assertEqual(1, report['content_label_sources']['expression'])
        labels['洪玉麟']['u1-2']['kind_source']['fingerprint'] = 'previous-source'
        report = evaluate(ROWS, labels, REPLAY)
        self.assertEqual(['u2'], report['scored_final_ids'])
        self.assertEqual(['stale_content_source'], report['excluded_finals'][0]['reasons'])
        self.assertEqual(['u1-2'], report['excluded_finals'][0]['stale_sentence_ids'])

    def test_new_single_source_is_versioned_and_legacy_remains_explicit(self):
        labels = copy.deepcopy(LABELS)
        labels['洪玉麟']['u1-2']['kind_source'] = {
            'mode':'single', 'id':'u1-2', 'fingerprint':row_fingerprint(ROWS[1])}
        report = evaluate(ROWS, labels, REPLAY)
        self.assertEqual({'single':1, 'legacy':2, 'expression':0}, report['content_label_sources'])
        rows, replay = copy.deepcopy(ROWS), copy.deepcopy(REPLAY)
        rows[1]['text'] = '改成下周提交。'
        replay['utterances'][0]['text'] = rows[0]['text'] + rows[1]['text']
        report = evaluate(rows, labels, replay)
        self.assertEqual(['u2'], report['scored_final_ids'])
        self.assertEqual(['stale_content_source'], report['excluded_finals'][0]['reasons'])

    def test_unknown_tags_are_abstentions_and_empty_denominators_are_null(self):
        replay = copy.deepcopy(REPLAY)
        replay['utterances'][0]['tag'] = 'uncertain'
        report = evaluate(ROWS, LABELS, replay)
        self.assertEqual(1, report['effective_confusion']['effective']['abstain'])
        self.assertEqual(0, report['effective_recall'])
        self.assertEqual(.5, report['decision_coverage'])
        self.assertIsNone(report['effective_precision'])
        self.assertIsNone(report['task_and_decision']['decision']['recall'])

    def test_foreign_ids_duplicate_ids_and_changed_text_are_rejected(self):
        for update in ('id', 'text', 'duplicate'):
            replay = copy.deepcopy(REPLAY)
            if update == 'duplicate': replay['utterances'].append(replay['utterances'][0])
            else: replay['utterances'][0][update] = 'different'
            with self.assertRaises(ValueError): evaluate(ROWS, LABELS, replay)
        with self.assertRaises(ValueError): evaluate(ROWS + ROWS[:1], LABELS, REPLAY)


if __name__ == '__main__': unittest.main()
