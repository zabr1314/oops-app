"""Fine-sentence reanalysis guards. The Jev transport is an in-memory fake; no network or real data."""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import types

import jev_reanalysis as jr
import jev_label_reanalysis as jl

APP = str(Path(__file__).resolve().parent)


class LabelReanalysisTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.label = root / 'label'
        for k, m in enumerate(jl.MEETINGS):
            folder = self.label / 'meetings' / m
            folder.mkdir(parents=True)
            rows = [dict(id=f'u{p}-{c}', parent=f'u{p}', text=f'第{m}场第{p}段第{c}句我们先做安卓版本吧', start_ms=(p * 10 + c) * 1000,
                         end_ms=(p * 10 + c) * 1000 + 900) for p in (1, 2) for c in (1, 2)]
            (folder / 'meeting.json').write_text(json.dumps(dict(id=m, utterances=rows), ensure_ascii=False))
            (folder / 'suggestions.json').write_text(json.dumps(dict(blind=dict(parent_ids=['u2'], ids=['u2-1', 'u2-2']))))
        (self.label / 'identities').mkdir()
        (self.label / 'identities' / 'shared.json').write_text(json.dumps(dict(approvals={
            'voice:甲': dict(speaker='甲', members=[dict(meeting='0235', id='u1-1')])}), ensure_ascii=False))
        self.bodies = []

    def fake_sender(self, request, **kwargs):
        body = json.loads(request.data)
        self.bodies.append(body)
        answers = {}
        for name, question in body['questions'].items():
            keys = list(question['criteria'])
            choice = 'idea' if 'idea' in keys else 'no' if 'no' in keys else keys[0]
            answers[name] = dict(choice=choice, probabilities={k: (.8 if k == choice else .2 / max(1, len(keys) - 1)) for k in keys})
        return io.BytesIO(json.dumps(dict(answers=answers, model=jr.MODEL, usage=dict(input_tokens=1000))).encode())

    def args(self, run_id, apply=True, previous=None, cap=2.0, expected=None):
        return types.SimpleNamespace(app=APP, label_dir=str(self.label), jev_env='/nonexistent', run_id=run_id,
            work_dir=self.temp.name + '/jobs', output_dir=self.temp.name + '/out', cap_cny=cap, previous=previous,
            expected_source_hash=expected or jl.fingerprint(self.label), apply=apply)

    def run_part(self, *a, **k):
        original = jr.Transport
        with patch.dict(os.environ, {'TYPESAFE_API_KEY': 'fake-test-key'}), \
             patch.object(jr, 'Transport', lambda *x: original(*x, sender=self.fake_sender)):
            return jl.run(self.args(*a, **k))

    def test_blind_sentences_are_never_sent_and_confirmed_speakers_are(self):
        rows, blind = jl.load_rows(self.label)
        self.assertEqual(6, blind)
        self.assertTrue(all(r['parent'] != 'u2' for r in rows))
        result = self.run_part(jl.RUN_PREFIX + '-t1')
        self.assertEqual('complete', result['status'])
        self.assertEqual(6, result['completed_tag_sentences'])
        sent = json.dumps(self.bodies, ensure_ascii=False)
        self.assertNotIn('第2段', sent)
        self.assertTrue(any(b['state'].get('speaker') == '甲' for b in self.bodies))
        self.assertNotIn('fake-test-key', (Path(self.temp.name) / 'out' / (jl.RUN_PREFIX + '-t1.json')).read_text())
        self.assertEqual(result['request_count'], result['settled_requests'])
        self.assertAlmostEqual(result['request_count'] * 1000 * jr.TOKEN_COST / 1e9, result['spent_cny'])

    def test_preflight_makes_no_calls_and_a_changed_source_is_refused(self):
        result = self.run_part(jl.RUN_PREFIX + '-t2', apply=False)
        self.assertEqual('preflight_only', result['status'])
        self.assertEqual([], self.bodies)
        with self.assertRaises(jr.Stop):
            self.run_part(jl.RUN_PREFIX + '-t3', expected='0' * 64)

    def test_a_later_part_skips_finished_sentences_and_counts_earlier_spend(self):
        self.run_part(jl.RUN_PREFIX + '-p1')
        first = len(self.bodies)
        report = str(Path(self.temp.name) / 'out' / (jl.RUN_PREFIX + '-p1.json'))
        result = self.run_part(jl.RUN_PREFIX + '-p2', previous=[report])
        self.assertEqual(0, result['completed_tag_sentences'])
        self.assertEqual(first, len(self.bodies))
        with self.assertRaises(SystemExit):
            with patch('sys.argv', ['x', '--app', APP, '--label-dir', str(self.label), '--jev-env', 'x', '--run-id', 'other-run',
                                    '--work-dir', 'w', '--output-dir', 'o']):
                jl.main()

    def test_total_ceiling_holds_across_parts(self):
        done, exposure, _, _, _ = jl.previous_parts([])
        self.assertEqual(0, exposure)
        fake = Path(self.temp.name) / 'prev.json'
        fake.write_text(json.dumps(dict(run_id=jl.RUN_PREFIX + '-x', events=[], budget=dict(spent_cny=1.99, reserved_cny=0.0))))
        with self.assertRaises(jr.Stop):
            jl.run(self.args(jl.RUN_PREFIX + '-t4', apply=False, previous=[str(fake)]))


if __name__ == '__main__':
    unittest.main()
