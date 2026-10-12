import copy
import unittest
from evaluate_cached_labels import evaluate


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

    def test_missing_labels_and_prefill_never_produce_metrics(self):
        labels = copy.deepcopy(LABELS)
        del labels['洪玉麟']['u1-2']['speaker']
        rows = copy.deepcopy(ROWS); rows[1]['voice'] = '林春源'
        report = evaluate(rows, labels, REPLAY)
        self.assertEqual('waiting_for_human_labels', report['status'])
        self.assertNotIn('effective_confusion', report)

    def test_conflicting_human_answers_prevent_scoring(self):
        labels = copy.deepcopy(LABELS)
        labels['江古月'] = {'u1-2': {'kind':'noise','speaker':'林春源'}}
        report = evaluate(ROWS, labels, REPLAY)
        self.assertEqual(1, report['disputed_rows'])
        self.assertNotIn('effective_precision', report)

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


if __name__ == '__main__': unittest.main()
