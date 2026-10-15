#!/usr/bin/env python3
"""Offline regression tests for source-bound, reversible meeting edits."""
from copy import deepcopy
import unittest
from unittest.mock import patch

import content_curation as curation


class CurationTests(unittest.TestCase):
    def setUp(self):
        self.rows = [
            dict(id="u1", text="明天先提交后端接口，再接手机。", start_ms=0, end_ms=1000),
            dict(id="u2", text="后端接口先提交，手机之后接。", start_ms=1000, end_ms=2000),
            dict(id="u3", text="举个例子，如果别家有机器就马上买。", start_ms=2000, end_ms=3000),
            dict(id="u4", text="嗯，啊。", start_ms=3000, end_ms=3500),
        ]
        self.items = [
            dict(id="a", kind="task", title="提交后端接口", evidence_ids=["u1"], due="明天", native={"keep": True}),
            dict(id="b", kind="task", title="提交后端接口后接手机", evidence_ids=["u2"], due="明天"),
            dict(id="c", kind="task", title="购买机器", evidence_ids=["u3"]),
        ]
        self.plan = dict(schema=1, meeting_id="m1", source_hash=curation.source_hash(self.rows),
                         origin_items_hash=curation.origin_items_hash(self.items),
                         item_ops=[dict(action="merge", item_ids=["a", "b"], kind="task",
                                        title="先提交后端接口，再接手机", detail="按会议确认的顺序跟进。", due="明天",
                                        evidence_ids=["u1", "u2"], reason="同一动作的前后重复表达"),
                                   dict(action="suppress", item_id="c", reason="明确标记为举例的假设")],
                         sentences=[dict(id="u1", mode="focus", reason="明确工作安排"),
                                    dict(id="u2", mode="context", reason="同一安排的补充"),
                                    dict(id="u3", mode="fold", reason="举例而非采购安排"),
                                    dict(id="u4", mode="fold", reason="纯语气词")],
                         summary=[dict(text="先提交后端接口，再接手机。", evidence_ids=["u1", "u2"])])

    def project(self, plan=None, rows=None, items=None, **kwargs):
        return curation.project(self.plan if plan is None else plan,
                                self.rows if rows is None else rows,
                                self.items if items is None else items, meeting_id="m1", **kwargs)

    def assert_invalid(self, plan, code):
        out = self.project(plan=plan)
        self.assertEqual(out["status"], "needs_review")
        self.assertIn(code, out["errors"])
        self.assertEqual(out["active_items"], self.items)
        self.assertEqual(out["utterances"], self.rows)
        self.assertEqual(out["suppressed_items"], [])
        self.assertEqual(out["summary"], [])

    def test_merge_is_new_unconfirmed_candidate_and_originals_are_preserved(self):
        out = self.project()
        self.assertEqual(out["status"], "ready")
        self.assertEqual(len(out["active_items"]), 1)
        merged = out["active_items"][0]
        self.assertNotIn(merged["id"], [i["id"] for i in self.items])
        self.assertEqual(merged["evidence_ids"], ["u1", "u2"])
        self.assertFalse(merged["claimed"])
        self.assertEqual(merged["curation"]["status"], "candidate")
        for key in ("owner", "owner_hint", "assignee", "claimed_by"):
            self.assertNotIn(key, merged)
        self.assertIsNone(merged["review"])
        self.assertEqual([i["id"] for i in out["suppressed_items"]], [i["id"] for i in self.items])
        self.assertEqual(out["suppressed_items"][0]["curation"]["into"], merged["id"])
        self.assertEqual(out["suppressed_items"][2]["curation"]["action"], "suppress")
        self.assertEqual(out["history_items"], self.items)
        self.assertEqual(out["utterances"][3]["text"], "嗯，啊。")
        self.assertEqual(out["utterances"][3]["curation"]["mode"], "fold")

    def test_no_input_mutation_even_when_projection_is_edited(self):
        before = deepcopy((self.plan, self.rows, self.items))
        out = self.project()
        out["active_items"][0]["evidence_ids"].append("invented")
        out["history_items"][0]["native"]["keep"] = False
        out["summary"][0]["text"] = "changed"
        out["utterances"][0]["text"] = "changed"
        self.assertEqual((self.plan, self.rows, self.items), before)

    def test_no_network_or_file_or_model_access(self):
        with patch("builtins.open", side_effect=AssertionError("no files")), \
                patch("socket.socket", side_effect=AssertionError("no network")):
            self.assertEqual(self.project()["status"], "ready")

    def test_repeat_projection_is_idempotent(self):
        self.assertEqual(self.project(), self.project())
        out = self.project()
        self.assertEqual(out["revision"], out["plan_hash"])
        self.assertEqual(len(out["plan_hash"]), 64)

    def test_keep_preserves_native_fields_and_current_human_answer(self):
        items = deepcopy(self.items)
        items[0]["review"] = dict(status="confirmed", owner="已确认成员", fingerprint="native-current")
        out = self.project(items=items, protected_ids=["a"])
        self.assertEqual(out["active_items"], items[:2])
        self.assertEqual(out["active_items"][0]["review"], items[0]["review"])
        self.assertEqual(out["active_items"][0]["native"], {"keep": True})
        self.assertFalse(out["audit"][0]["applied"])
        self.assertTrue(out["audit"][0]["protected"])
        self.assertNotIn("replacement_id", out["audit"][0])

    def test_any_current_human_answer_blocks_entire_merge(self):
        for status in ("confirmed", "edited", "rejected", "merged"):
            with self.subTest(status=status):
                items = deepcopy(self.items)
                items[1]["review"] = dict(status=status)
                out = self.project(items=items, protected_ids=["b"])
                self.assertEqual([i["id"] for i in out["active_items"]], ["a", "b"])
                self.assertEqual(out["active_items"][1]["review"]["status"], status)

    def test_current_human_answer_blocks_automatic_suppression(self):
        out = self.project(protected_ids=["c"])
        self.assertIn("c", [i["id"] for i in out["active_items"]])
        self.assertEqual([i["id"] for i in out["suppressed_items"]], ["a", "b"])

    def test_source_text_time_order_and_missing_sentence_changes_fail_closed(self):
        changed = []
        rows = deepcopy(self.rows); rows[0]["text"] += "改了"; changed.append(rows)
        rows = deepcopy(self.rows); rows[0]["end_ms"] += 1; changed.append(rows)
        changed.append(list(reversed(self.rows)))
        changed.append(self.rows[:-1])
        for rows in changed:
            with self.subTest(rows=rows):
                out = self.project(rows=rows)
                self.assertEqual(out["errors"], ["source_changed"])
                self.assertEqual(out["active_items"], self.items)
                self.assertEqual(out["utterances"], rows)

    def test_origin_wording_kind_evidence_and_ids_are_bound(self):
        for field, value in (("title", "新标题"), ("kind", "decision"), ("evidence_ids", ["u2"]), ("id", "other"),
                             ("detail", "需要新条件"), ("due", "后天"), ("fingerprint", "new-fingerprint")):
            items = deepcopy(self.items); items[0][field] = value
            self.assertEqual(self.project(items=items)["errors"], ["origin_items_changed"])

    def test_same_titles_different_sources_are_not_implicitly_merged(self):
        items = deepcopy(self.items); items[1]["title"] = items[0]["title"]
        plan = deepcopy(self.plan)
        plan["origin_items_hash"] = curation.origin_items_hash(items)
        plan["item_ops"] = [dict(action="keep", item_id=i["id"], reason="分别保留待核对") for i in items]
        out = self.project(plan=plan, items=items)
        self.assertEqual(out["active_items"], items)
        self.assertNotEqual(out["active_items"][0]["evidence_ids"], out["active_items"][1]["evidence_ids"])

    def test_cross_meeting_plan_never_applies(self):
        plan = deepcopy(self.plan); plan["meeting_id"] = "other"
        self.assert_invalid(plan, "meeting_changed")
        self.assertEqual(curation.validate_plan(self.plan, self.rows, self.items)["errors"], ["meeting_id_required"])

    def test_item_dispositions_must_cover_every_original_once(self):
        plan = deepcopy(self.plan); plan["item_ops"].pop()
        self.assert_invalid(plan, "item_coverage_incomplete")
        plan = deepcopy(self.plan); plan["item_ops"].append(dict(action="keep", item_id="a", reason="重复"))
        self.assert_invalid(plan, "item_coverage_invalid")
        plan = deepcopy(self.plan); plan["item_ops"][1]["item_id"] = "unknown"
        self.assert_invalid(plan, "item_coverage_invalid")

    def test_merge_must_cite_exact_union_in_original_order(self):
        for ids, code in ((["u1"], "merge_evidence_not_exact_union"),
                          (["u1", "u2", "u3"], "merge_evidence_not_exact_union"),
                          (["u1", "unknown"], "merge_evidence_invalid"),
                          (["u2", "u1"], "evidence_order_invalid"),
                          (["u1", "u1"], "merge_evidence_invalid")):
            plan = deepcopy(self.plan); plan["item_ops"][0]["evidence_ids"] = ids
            self.assert_invalid(plan, code)

    def test_merge_cannot_smuggle_owner_claim_or_human_confirmation(self):
        for field, value in (("owner", "某人"), ("owner_hint", "某人"), ("claimed", True),
                             ("review", {"status": "confirmed"}), ("task_url", "https://example.invalid")):
            plan = deepcopy(self.plan); plan["item_ops"][0][field] = value
            self.assert_invalid(plan, "merge_fields_invalid")

    def test_merge_cannot_invent_due_or_choose_between_conflicting_dues(self):
        plan = deepcopy(self.plan); plan["item_ops"][0]["due"] = "今晚"
        self.assert_invalid(plan, "merge_due_not_supported")
        items = deepcopy(self.items); items[1]["due"] = "后天"
        self.assertEqual(self.project(items=items)["errors"], ["origin_items_changed"])
        plan["origin_items_hash"] = curation.origin_items_hash(items)
        plan["item_ops"][0]["due"] = "明天"
        self.assertEqual(self.project(plan=plan, items=items)["errors"], ["merge_due_not_supported"])
        plan["item_ops"][0]["due"] = ""
        self.assertEqual(self.project(plan=plan, items=items)["status"], "ready")

    def test_sentence_dispositions_cover_full_transcript_once(self):
        plan = deepcopy(self.plan); plan["sentences"].pop()
        self.assert_invalid(plan, "sentence_coverage_incomplete")
        plan = deepcopy(self.plan); plan["sentences"].append(plan["sentences"][0])
        self.assert_invalid(plan, "sentence_coverage_invalid")
        plan = deepcopy(self.plan); plan["sentences"][0]["mode"] = "delete"
        self.assert_invalid(plan, "sentence_mode_invalid")
        plan = deepcopy(self.plan); plan["sentences"][0]["text"] = "伪造原文"
        self.assert_invalid(plan, "sentence_fields_invalid")

    def test_summary_cannot_cite_nonexistent_or_empty_evidence(self):
        for ids in ([], ["other"], ["u1", "u1"]):
            plan = deepcopy(self.plan); plan["summary"][0]["evidence_ids"] = ids
            self.assert_invalid(plan, "summary_evidence_invalid")

    def test_revision_changes_when_editor_changes_disposition_or_summary(self):
        first = self.project()
        plan = deepcopy(self.plan); plan["summary"][0]["text"] += "待核对。"
        second = self.project(plan=plan)
        self.assertEqual(second["status"], "ready")
        self.assertNotEqual(first["revision"], second["revision"])
        self.assertEqual(first["active_items"][0]["id"], second["active_items"][0]["id"])

    def test_rewrite_is_a_fresh_candidate_with_exact_original_evidence(self):
        plan = deepcopy(self.plan)
        plan["item_ops"] = [dict(action="keep", item_id=iid, reason="保留明确动作") for iid in ("a", "b")]
        plan["item_ops"].append(dict(action="rewrite", item_ids=["c"], kind="open", title="是否需要采购机器？",
                                     detail="仅为讨论举例，未形成采购决定。", due="", evidence_ids=["u3"],
                                     reason="采购假设不能当作已定待办"))
        out = self.project(plan=plan)
        rewritten = out["active_items"][2]
        self.assertEqual(rewritten["kind"], "open")
        self.assertEqual(rewritten["evidence_ids"], ["u3"])
        self.assertNotEqual(rewritten["id"], "c")
        self.assertFalse(rewritten["claimed"])
        self.assertIsNone(rewritten["review"])
        self.assertEqual(out["history_items"], self.items)
        protected = self.project(plan=plan, protected_ids=["c"])
        self.assertEqual(protected["active_items"], self.items)
        plan["item_ops"][2]["evidence_ids"] = ["u1"]
        self.assert_invalid(plan, "merge_evidence_not_exact_union")

    def test_malformed_source_and_unhashable_fields_fail_safely(self):
        rows = deepcopy(self.rows); rows[0]["start_ms"] = True
        self.assertEqual(self.project(rows=rows)["errors"], ["source_time_invalid"])
        items = deepcopy(self.items); items[0]["kind"] = ["task"]
        self.assertEqual(self.project(items=items)["errors"], ["item_kind_invalid"])
        plan = deepcopy(self.plan); plan["sentences"][0]["mode"] = ["fold"]
        self.assert_invalid(plan, "sentence_mode_invalid")
        self.assertEqual(self.project(protected_ids="a")["errors"], ["protected_ids_invalid"])

    def test_empty_meeting_has_explicit_empty_valid_plan(self):
        plan = dict(schema=1, meeting_id="m1", source_hash=curation.source_hash([]),
                    origin_items_hash=curation.origin_items_hash([]), item_ops=[], sentences=[], summary=[])
        self.assertEqual(self.project(plan=plan, rows=[], items=[])["status"], "ready")


if __name__ == "__main__":
    unittest.main()
