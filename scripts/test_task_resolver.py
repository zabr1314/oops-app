"""Verification guards for context-resolved tasks; no network."""
import unittest

from task_resolver import grade, owner_for, quote_found, verify
from test_item_quality import CLOUD, VERSION

TRANSCRIPT = [{"id": "u53", "text": "先先做吉果的那个。吉果加豆包。"},
              {"id": "u54", "text": "诶，那你把那个顺便发我吧，我感觉我可以一起。跑一下那个，你说运营那个。"}]


class ResolverTest(unittest.TestCase):
    def raw(self, **changes):
        return {"is_task": True, "what": "把运营选题方案发给对方", "owner_role": "addressee", "owner_name": None,
                "due_raw": None, "missing": [],
                "resolutions": [{"phrase": "那个", "meaning": "吉果加豆包的运营方案",
                                 "evidence": [{"id": "u53", "quote": "吉果加豆包"}]}], **changes}

    def test_verified_resolution_and_two_person_addressee(self):
        result = verify(self.raw(), TRANSCRIPT, "u54", "那你把那个顺便发我吧")
        self.assertEqual([], result["missing"])
        owner = owner_for(result, "洪玉麟", ["林春源", "洪玉麟"])
        self.assertEqual("林春源", owner)
        self.assertEqual("complete", grade(result, owner))

    def test_invented_quote_becomes_missing_not_a_guess(self):
        raw = self.raw(resolutions=[{"phrase": "那个", "meaning": "季度预算表",
                                     "evidence": [{"id": "u53", "quote": "季度预算表格"}]}])
        result = verify(raw, TRANSCRIPT, "u54", "那你把那个顺便发我吧")
        self.assertEqual([], result["resolutions"])
        self.assertTrue(result["missing"])
        self.assertEqual("needs_info", grade(result, "林春源"))

    def test_owner_needs_speaker_evidence_and_known_names(self):
        result = verify(self.raw(owner_role="named", owner_name="张三"), TRANSCRIPT, "u54", "发我吧")
        self.assertEqual("unknown", result["owner_role"])
        self.assertIsNone(owner_for(verify(self.raw(), TRANSCRIPT, "u54", "发我吧"), None, ["林春源", "洪玉麟"]))
        self.assertIsNone(owner_for(verify(self.raw(), TRANSCRIPT, "u54", "发我吧"), "洪玉麟", ["林春源", "洪玉麟", "黄丽萍"]))

    def test_due_must_be_literal_and_short_quotes_rejected(self):
        result = verify(self.raw(due_raw="周五前"), TRANSCRIPT, "u54", "那你把那个顺便发我吧")
        self.assertIsNone(result["due_raw"])
        self.assertFalse(quote_found("吉果", TRANSCRIPT[0]["text"]))
        self.assertTrue(quote_found("吉果加豆包", TRANSCRIPT[0]["text"]))

    def test_example_quote_cannot_be_lifted_out_of_its_original_scope(self):
        result = verify(self.raw(what='购买 cloud 资源', resolutions=[], task_quote='我们立马买'),
                        [dict(id='u15', text=CLOUD)], 'u15')
        self.assertFalse(result['is_task'])
        self.assertEqual('example_or_hypothesis', result['quality']['reason'])

    def test_punctuation_normalized_quote_still_inherits_example_scope(self):
        result = verify(self.raw(what='购买 cloud 资源', resolutions=[], task_quote='如果缺了如果他那边有我们立马买'),
                        [dict(id='u15', text=CLOUD)], 'u15')
        self.assertFalse(result['is_task'])
        self.assertEqual('rejected', result['quality']['status'])

    def test_version_ambiguity_is_a_candidate_question_not_a_complete_draft(self):
        result = verify(self.raw(what='将 OOPS 代码叠出一百版', resolutions=[], task_quote='把这两个就叠成一百就好了'),
                        VERSION, 'u000032')
        self.assertTrue(result['is_task'])
        self.assertEqual('needs_review', grade(result, '林春源'))
        self.assertEqual('quantity_ambiguity', result['quality']['reason'])
        self.assertTrue(result['missing'])

    def test_literal_quantity_from_verified_resolution_is_supported(self):
        lines = [dict(id='u1', text='客户需要两份报告'), dict(id='u2', text='明天我来提交这些报告')]
        result = verify(self.raw(what='提交两份报告', task_quote='明天我来提交这些报告', resolutions=[
            dict(phrase='这些', meaning='两份报告', evidence=[dict(id='u1', quote='客户需要两份报告')])]), lines, 'u2')
        self.assertEqual('accepted', result['quality']['status'])
        self.assertEqual('complete', grade(result, '林春源'))

    def test_explicit_clause_argument_still_has_to_exist_in_source(self):
        result = verify(self.raw(what='采购服务器', resolutions=[]), TRANSCRIPT, 'u54', '明天采购服务器')
        self.assertFalse(result['is_task'])


if __name__ == "__main__":
    unittest.main()
