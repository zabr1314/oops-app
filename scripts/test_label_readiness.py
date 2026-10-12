import unittest
from label_readiness import audit
from label_workflow import expressions, row_fingerprint


class Data:
    meetings = {'0235': {}}
    def __init__(self, rows=None, labels=None):
        self.rows = rows or [dict(id='u1', parent='p1', text='请在周五提交这份设计方案', start_ms=0,
            end_ms=2000, voice='林春源', claimed=True)]
        self.labels = labels or {}
    def rows_with_claims(self, mid):
        return self.rows
    def load(self, mid, name): return self.labels.get(name, {})
    def claims(self): return {'角色A': {'person':'江古月', 'by':'林春源'}}


class ReadinessTest(unittest.TestCase):
    def test_content_completeness_is_independent_of_speaker(self):
        data = Data()
        data.labels = {'林春源': {'u1': {'kind':'task', 'owner':'林春源'}}}
        report = audit(data)
        self.assertTrue(report['ready_for_content'])
        self.assertTrue(report['ready_for_cached_content_evaluation'])
        self.assertEqual(1, report['meetings'][0]['complete_human_rows'])
        self.assertEqual(0, report['meetings'][0]['independent_speaker_rows'])
        self.assertFalse(report['roles']['角色A']['self_confirmed'])
        self.assertFalse(report['calibration_complete'])
        self.assertFalse(report['real_meeting_accepted'])

    def test_kind_or_owner_disagreement_blocks_content_but_speaker_dispute_does_not(self):
        data = Data()
        data.labels = {'林春源': {'u1': {'kind':'task', 'owner':'林春源', 'speaker':'林春源'}}}
        self.assertTrue(audit(data)['ready_for_calibration'])
        data.labels['洪玉麟'] = {'u1': {'speaker':'江古月'}}
        report = audit(data)
        self.assertTrue(report['ready_for_content'])
        self.assertEqual(1, report['meetings'][0]['speaker_disputed_rows'])
        data.labels['洪玉麟'] = {'u1': {'kind':'noise', 'speaker':'林春源'}}
        self.assertFalse(audit(data)['ready_for_calibration'])
        self.assertFalse(audit(data)['ready_for_content'])
        data.labels['洪玉麟'] = {'u1': {'kind':'task', 'owner':'洪玉麟'}}
        self.assertFalse(audit(data)['ready_for_content'])

    def test_unlabelled_all_short_context_needs_no_invented_noise_answer(self):
        data = Data([dict(id='u1', parent='p1', text='嗯。', start_ms=0, end_ms=500)])
        report = audit(data)
        self.assertTrue(report['ready_for_content'])
        self.assertFalse(report['ready_for_cached_content_evaluation'])
        self.assertFalse(report['ready_for_calibration'])
        meeting = report['meetings'][0]
        self.assertEqual(0, meeting['required_expression_count'])
        self.assertEqual(1, meeting['context_expression_count'])
        self.assertEqual({}, meeting['kinds'])
        self.assertEqual(0, meeting['complete_human_rows'])

    def test_voice_group_identity_cannot_supply_content_or_independent_speaker_truth(self):
        data = Data()
        data.rows[0].update(voice_group_id='role:A', voice_group_fingerprint='current')
        data.labels = {'林春源': {'u1': {'speaker':'林春源',
            'speaker_source':{'mode':'voice_group', 'id':'role:A', 'fingerprint':'current'}}}}
        meeting = audit(data)['meetings'][0]
        self.assertFalse(meeting['ready_for_content'])
        self.assertEqual(0, meeting['complete_human_rows'])
        self.assertEqual(0, meeting['independent_speaker_rows'])
        self.assertEqual(1, meeting['grouped_speaker_rows'])

    def test_expression_source_counts_and_changed_source_requires_new_confirmation(self):
        data = Data()
        expression = expressions(data.rows)[0]
        data.labels = {'林春源': {'u1': {'kind':'info', 'kind_source':{
            'mode':'expression', 'id':expression['id'], 'fingerprint':expression['fingerprint']}}}}
        meeting = audit(data)['meetings'][0]
        self.assertTrue(meeting['ready_for_content'])
        self.assertEqual(1, meeting['content_label_sources']['expression'])
        data.rows[0]['text'] = '请在下周一提交另外一份方案'
        meeting = audit(data)['meetings'][0]
        self.assertFalse(meeting['ready_for_content'])
        self.assertEqual(1, meeting['stale_kind_labels'])
        self.assertEqual(0, meeting['complete_human_rows'])

    def test_new_single_sources_are_distinct_from_legacy_and_source_change_withdraws_them(self):
        data = Data()
        source = dict(mode='single', id='u1', fingerprint=row_fingerprint(data.rows[0]))
        data.labels = {'林春源': {'u1': {'kind':'info', 'kind_source':source,
            'speaker':'林春源', 'speaker_source':source}}}
        meeting = audit(data)['meetings'][0]
        self.assertEqual({'single':1, 'legacy':0, 'expression':0}, meeting['content_label_sources'])
        self.assertEqual({'single':1, 'legacy':0, 'voice_group':0}, meeting['speaker_label_sources'])
        self.assertEqual(1, meeting['independent_speaker_rows'])
        data.rows[0]['text'] += '，这句已被修订'
        meeting = audit(data)['meetings'][0]
        self.assertEqual(0, meeting['complete_human_rows'])
        self.assertEqual(0, meeting['independent_speaker_rows'])
        self.assertEqual(1, meeting['stale_kind_labels'])
        self.assertEqual(1, meeting['stale_speaker_labels'])

    def test_current_personal_voice_approvals_are_separate_from_legacy_shared_claims(self):
        class IdentityData(Data):
            def identity_payload(self, name):
                approvals = {
                    'role:A': {'林春源':'江古月', '江古月':'江古月'},
                    'role:B': {'洪玉麟':'洪玉麟', '黄丽萍':'江古月'},
                    'role:C': {'林春源':'林春源'},
                }
                return {'groups': [dict(id=gid, title=gid, count=100,
                    approval=dict(by=name, speaker=people[name], at='test') if name in people else None,
                    current=name in people and gid != 'role:C') for gid, people in approvals.items()]}
        report = audit(IdentityData())
        groups = {group['id']:group for group in report['voice_groups']}
        self.assertEqual(4, report['current_voice_group_confirmations'])
        self.assertEqual(2, report['current_self_confirmed_voice_groups'])
        self.assertEqual(1, report['disputed_voice_groups'])
        self.assertEqual('江古月', groups['role:A']['consensus_speaker'])
        self.assertEqual(['江古月'], groups['role:A']['self_confirmed_people'])
        self.assertTrue(groups['role:B']['disputed'])
        self.assertIsNone(groups['role:B']['consensus_speaker'])
        self.assertEqual([], groups['role:C']['confirmations'])
        self.assertEqual(1, groups['role:C']['stale_approval_count'])
        self.assertFalse(report['roles']['角色A']['legacy_self_claim'])
        self.assertEqual('legacy_claims', report['roles']['角色A']['source'])
        self.assertEqual(0, report['meetings'][0]['independent_speaker_rows'])
        self.assertFalse(report['calibration_complete'])

    def test_fake_or_old_data_without_identity_api_reports_unavailable(self):
        report = audit(Data())
        self.assertFalse(report['voice_group_audit_available'])
        self.assertEqual([], report['voice_groups'])
        self.assertIsNone(report['current_voice_group_confirmations'])


if __name__ == '__main__': unittest.main()
