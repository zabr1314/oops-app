import unittest
from label_readiness import audit


class Data:
    meetings = {'0235': {}}
    labels = {}
    def rows_with_claims(self, mid):
        return [dict(id='u1', text='周五提交方案', start_ms=0, end_ms=2000, voice='林春源', claimed=True)]
    def load(self, mid, name): return self.labels.get(name, {})
    def claims(self): return {'角色A': {'person':'江古月', 'by':'林春源'}}


class ReadinessTest(unittest.TestCase):
    def test_prefill_does_not_complete_human_evidence(self):
        data = Data()
        data.labels = {'林春源': {'u1': {'kind':'task', 'owner':'林春源'}}}
        report = audit(data)
        self.assertFalse(report['ready_for_calibration'])
        self.assertEqual(0, report['meetings'][0]['complete_human_rows'])
        self.assertFalse(report['roles']['角色A']['self_confirmed'])

    def test_explicit_human_label_completes_but_disagreement_blocks(self):
        data = Data()
        data.labels = {'林春源': {'u1': {'kind':'task', 'owner':'林春源', 'speaker':'林春源'}}}
        self.assertTrue(audit(data)['ready_for_calibration'])
        data.labels['洪玉麟'] = {'u1': {'kind':'noise', 'speaker':'林春源'}}
        self.assertFalse(audit(data)['ready_for_calibration'])


if __name__ == '__main__': unittest.main()
