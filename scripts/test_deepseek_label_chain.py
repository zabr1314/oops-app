"""DeepSeek chain guards. The provider is an in-memory fake; no network or real data."""
import io
import json
from pathlib import Path
import tempfile
import types
import unittest

import jev_label_reanalysis as jl
import deepseek_label_chain as dc
from jev_reanalysis import Stop

APP = str(Path(__file__).resolve().parent)


class DeepSeekChainTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.label = root / 'label'
        for m in jl.MEETINGS:
            folder = self.label / 'meetings' / m
            folder.mkdir(parents=True)
            rows = [dict(id=f'u{p}-{c}', parent=f'u{p}', text=f'{m}第{p}段第{c}句：我来负责把安卓版本做出来吗？', start_ms=(p * 10 + c) * 1000,
                         end_ms=(p * 10 + c) * 1000 + 900) for p in (1, 2, 3) for c in (1, 2)]
            (folder / 'meeting.json').write_text(json.dumps(dict(id=m, utterances=rows), ensure_ascii=False))
            (folder / 'suggestions.json').write_text(json.dumps(dict(blind=dict(parent_ids=['u2'], ids=['u2-1', 'u2-2']))))
        (self.label / 'identities').mkdir()
        (self.label / 'identities' / 'shared.json').write_text(json.dumps(dict(approvals={}), ensure_ascii=False))
        rows, _ = jl.load_rows(self.label)
        self.jev = root / 'jev.json'
        self.jev.write_text(json.dumps(dict(run_id=jl.RUN_PREFIX + '-p1', events=[
            dict(kind='tag', id=r['id'], result=dict(tag='commitment' if r['label_id'].endswith('-1') else 'idea')) for r in rows])))
        (root / 'ds.env').write_text('DEEPSEEK_API_KEY=fake-test-key\n')
        self.bodies, self.failing = [], False

    def sender(self, request, timeout=None):
        body = json.loads(request.data)
        self.bodies.append(body)
        if self.failing:
            raise TimeoutError('fake')
        return io.BytesIO(json.dumps(dict(model='deepseek-chat', usage=dict(prompt_tokens=1000, completion_tokens=100),
            choices=[dict(message=dict(content=json.dumps({'tasks': [], 'kind': 'none'})))])).encode())

    def args(self, run_id, apply=True, steps=('minutes', 'tasks', 'questions')):
        return types.SimpleNamespace(app=APP, label_dir=str(self.label), jev_report=[str(self.jev)],
            deepseek_env=self.temp.name + '/ds.env', run_id=run_id, work_dir=self.temp.name + '/jobs',
            output_dir=self.temp.name + '/out', cap_cny=2.0, steps=list(steps),
            expected_source_hash=jl.fingerprint(self.label), apply=apply)

    def test_full_chain_settles_every_call_and_never_sends_blind_sentences(self):
        result = dc.run(self.args('dji-1005-deepseek-t1'), sender=self.sender)
        self.assertEqual('complete', result['status'], result)
        self.assertEqual(result['request_count'], result['settled_requests'])
        self.assertAlmostEqual(result['request_count'] * (1000 * 2 + 100 * 8) / 1e6, result['spent_cny'])
        sent = json.dumps(self.bodies, ensure_ascii=False)
        self.assertNotIn('第2段', sent)
        self.assertEqual(3, sum(1 for b in self.bodies if '会议开始' in b['messages'][1]['content']))
        minutes = next(b for b in self.bodies if '会议开始' in b['messages'][1]['content'])['messages'][1]['content']
        self.assertTrue(all(f'{m}第3段第2句' in minutes for m in jl.MEETINGS))
        report = (Path(self.temp.name) / 'out' / 'dji-1005-deepseek-t1.json').read_text()
        self.assertNotIn('fake-test-key', report)
        self.assertNotIn('fake-test-key', (Path(self.temp.name) / 'jobs' / 'dji-1005-deepseek-t1' / 'budget.json').read_text())

    def test_unknown_outcome_stops_without_retry(self):
        self.failing = True
        result = dc.run(self.args('dji-1005-deepseek-t2', steps=('tasks',)), sender=self.sender)
        self.assertEqual('partial', result['status'])
        self.assertEqual(1, len(self.bodies))
        self.assertEqual(1, result['unknown_requests'])

    def test_preflight_makes_no_calls_and_needs_a_finished_jev_run(self):
        result = dc.run(self.args('dji-1005-deepseek-t3', apply=False), sender=self.sender)
        self.assertEqual('preflight_only', result['status'])
        self.assertEqual([], self.bodies)
        self.jev.write_text(json.dumps(dict(run_id=jl.RUN_PREFIX + '-p1', events=[])))
        with self.assertRaises(Stop):
            dc.run(self.args('dji-1005-deepseek-t4', apply=False), sender=self.sender)


if __name__ == '__main__':
    unittest.main()
