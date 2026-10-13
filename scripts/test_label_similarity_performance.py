#!/usr/bin/env python3
"""Regression for the source hash work on the live similarity review path."""
import copy
import json
import os
import unittest
from unittest.mock import patch

import label_ai as ai
import test_label_similarity_api as api_fixture


class ResponseHashTest(unittest.TestCase):
    def setUp(self):
        self.rows = [dict(id="a", parent="p", text="这台设备内置麦克风。", start_ms=0, end_ms=1000, role="A"),
                     dict(id="b", parent="p", text="也可以语音唤醒。", start_ms=1100, end_ms=2200, role="A"),
                     dict(id="c", parent="p", text="我建议先测试连接。", start_ms=2300, end_ms=3400, role="A")]
        self.batch = dict(id="batch:a", ids=["a", "b", "c"], candidate_blocks=[["a", "b", "c"]])
        self.raw = dict(expressions=[dict(ids=["a", "b"], kind="fact", reason="描述设备能力。"),
                                    dict(ids=["c"], kind="info", reason="提出测试建议。")])

    def validate(self):
        return ai.validate_response(self.raw, self.batch, self.rows, "synthetic-frozen-v1")

    def test_frozen_suggestions_retain_byte_identical_fingerprints(self):
        # Captured from the pre-optimization validator. Source evidence and
        # previously generated sidecars must remain valid after deployment.
        result = self.validate()
        self.assertEqual(["d81bcfe586dd92a381960c3c004eea62c7bfb95b7cc639b2b46885a71c2a3ec8",
                          "ddfa9ce0b0a3f8d29da43edd42a86b5db19ad0daf69f19deb5a62a12d8ed9cf4"],
                         [item["fingerprint"] for item in result])
        self.assertEqual(["6e3b8e64ee583c9b9a1546a6bd171d5cc43d8d188c58bcc28e115faf5bb562ba",
                          "de159328812bcb60b55e9840f092588fcba7380d067ad5bc3160121db3fc11f6"],
                         [item["suggestion_fingerprint"] for item in result])

    def test_entire_source_is_hashed_once_per_response_not_once_per_expression(self):
        raw = dict(expressions=[dict(ids=[row["id"]], kind="fact", reason="合成事实依据。") for row in self.rows])
        with patch("label_ai.source_hash", wraps=ai.source_hash) as source_hash:
            ai.validate_response(raw, self.batch, self.rows, "synthetic-frozen-v1")
        self.assertEqual(1, source_hash.call_count)

    def test_new_validation_always_rehashes_current_source_including_other_expression(self):
        first = self.validate()
        self.rows[2]["text"] += "来源已修订。"
        with patch("label_ai.source_hash", wraps=ai.source_hash) as source_hash:
            changed = self.validate()
        self.assertEqual(1, source_hash.call_count)
        self.assertEqual(first[0]["fingerprint"], changed[0]["fingerprint"])
        self.assertNotEqual(first[0]["suggestion_fingerprint"], changed[0]["suggestion_fingerprint"])
        self.assertNotEqual(first[1]["fingerprint"], changed[1]["fingerprint"])

    def test_blind_boundaries_and_atomic_coverage_are_still_strict(self):
        broken = copy.deepcopy(self.raw)
        broken["expressions"][0]["ids"] = ["a", "b", "c"]
        with self.assertRaises(ai.InvalidSuggestion):
            ai.validate_response(broken, self.batch, self.rows, "synthetic-frozen-v1")
        batch = dict(self.batch, candidate_blocks=[["a"], ["b", "c"]])
        with self.assertRaises(ai.InvalidSuggestion):
            ai.validate_response(self.raw, batch, self.rows, "synthetic-frozen-v1")


class SidecarHashTest(unittest.TestCase):
    # Reuse the production-valid synthetic fixture's setup/helpers, without
    # importing or inheriting its already-covered HTTP test cases.
    setUp = api_fixture.SimilarityAPITest.setUp
    create_meeting = api_fixture.SimilarityAPITest.create_meeting
    write_json = staticmethod(api_fixture.SimilarityAPITest.write_json)
    read_json = staticmethod(api_fixture.SimilarityAPITest.read_json)
    def test_sidecar_validation_hash_work_scales_with_batches(self):
        mid = "0235"
        path = os.path.join(self.folder, "meetings", mid, "suggestions.json")
        rows = self.data.meetings[mid]["rows"]
        expected = self.read_json(path)
        before = json.dumps(expected["expressions"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with patch("label_ai.source_hash", wraps=ai.source_hash) as source_hash:
            loaded = ai.load_sidecar(path, rows, mid)
        after = json.dumps(loaded["expressions"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        self.assertEqual(before, after)
        complete_batches = sum(batch["status"] == "complete" for batch in expected["batches"])
        self.assertLessEqual(source_hash.call_count, complete_batches + 2)
        self.assertNotIn("blind", {uid for expression in loaded["expressions"] for uid in expression["ids"]})

    def test_changed_sidecar_is_not_reused_after_a_successful_load(self):
        path = os.path.join(self.folder, "meetings", "0235", "suggestions.json")
        rows = self.data.meetings["0235"]["rows"]
        self.assertIsNotNone(ai.load_sidecar(path, rows, "0235"))
        changed = self.read_json(path)
        changed["expressions"][0]["suggestion_fingerprint"] = "tampered-after-load"
        self.write_json(path, changed)
        with self.assertRaises(ai.InvalidSuggestion):
            ai.load_sidecar(path, rows, "0235")
        self.assertRaises(api_fixture.tl.RevisionConflict, self.data.similar_payload,
                          "0235", api_fixture.ALICE, "ai:anchor")

    def test_changed_source_cannot_reuse_previously_valid_sidecar(self):
        path = os.path.join(self.folder, "meetings", "0235", "suggestions.json")
        rows = self.data.meetings["0235"]["rows"]
        self.assertIsNotNone(ai.load_sidecar(path, rows, "0235"))
        changed = copy.deepcopy(rows)
        changed[-1]["text"] += "来源已变更。"
        with self.assertRaises(ai.InvalidSuggestion):
            ai.load_sidecar(path, changed, "0235")


if __name__ == "__main__":
    unittest.main()
