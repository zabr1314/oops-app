import copy
import unittest

from label_workflow import content_audit, current_label, expressions, row_fingerprint, speaker_audit


def row(uid="u1-1", text="这是需要完整核对的第一段话。", start=0, end=2000, **extra):
    return dict(id=uid, parent="u1", text=text, start_ms=start, end_ms=end, **extra)


def expression_labels(rows, kind="info", **extra):
    unit = expressions(rows)[0]
    source = {"mode": "expression", "id": unit["id"], "fingerprint": unit["fingerprint"]}
    return {"人甲": {uid: dict(kind=kind, kind_source=source, **extra) for uid in unit["ids"]}}


class ExpressionTest(unittest.TestCase):
    def test_joins_same_parent_voice_and_preserves_atomic_evidence(self):
        rows = [row(text="嗯。", end=300, voice="人甲"),
                row("u1-2", "这个方案需要周五之前完整提交。", 500, 3000, voice="人甲")]
        before = copy.deepcopy(rows)
        unit = expressions(rows)[0]
        self.assertEqual(["u1-1", "u1-2"], unit["ids"])
        self.assertEqual("嗯。这个方案需要周五之前完整提交。", unit["text"])
        self.assertEqual((0, 3000, True), (unit["start_ms"], unit["end_ms"], unit["required"]))
        self.assertEqual(before, rows)

    def test_voice_role_parent_gap_overlap_and_invalid_time_break_groups(self):
        first = row(voice="人甲", role="A")
        base = row("u1-2", start=2500, end=4000, voice="人甲", role="A")
        for update in (dict(voice="人乙"), dict(voice=None), dict(role="B"), dict(parent="u2"),
                       dict(parent=None), dict(start_ms=3001), dict(start_ms=1999), dict(end_ms=None)):
            with self.subTest(update=update):
                self.assertEqual(2, len(expressions([first, dict(base, **update)])))
        self.assertEqual(1, len(expressions([first, dict(base, start_ms=3000)])))
        no_parent = dict(first); no_parent.pop("parent")
        self.assertEqual(2, len(expressions([no_parent, dict(base, parent=None)])))
        self.assertEqual(2, len(expressions([dict(first, voice="multi"), dict(base, voice="multi")])))

    def test_expression_bounds_and_short_context(self):
        self.assertEqual(2, len(expressions([row(text="甲" * 100), row("u1-2", "乙" * 61, 2000, 4000)])))
        self.assertEqual(1, len(expressions([row(text="甲" * 100), row("u1-2", "乙" * 60, 2000, 4000)])))
        self.assertEqual(2, len(expressions([row(end=24000), row("u1-2", start=24000, end=26000)])))
        self.assertFalse(expressions([row(text="嗯，对。")])[0]["required"])

    def test_fingerprint_changes_with_any_member_evidence_and_rejects_duplicate_ids(self):
        rows = [row(), row("u1-2", start=2000, end=3000)]
        fingerprint = expressions(rows)[0]["fingerprint"]
        for update in (dict(text="改过的原话"), dict(start_ms=2001), dict(voice="人乙"), dict(role="A")):
            altered = [rows[0], dict(rows[1], **update)]
            self.assertNotEqual(fingerprint, expressions(altered)[0]["fingerprint"])
        with self.assertRaises(ValueError):
            expressions([row(), row()])


class ContentAuditTest(unittest.TestCase):
    def test_content_work_does_not_require_speaker_and_short_context_remains_unlabelled(self):
        rows = [row(), dict(row("u2-1", "对。", 3000, 3300), parent="u2")]
        labels = {"人甲": {"u1-1": {"kind": "task", "owner": "人甲"}}}
        report = content_audit(rows, labels)
        self.assertTrue(report["ready_for_content"])
        self.assertEqual(["u1-1"], report["complete_ids"])
        self.assertNotIn("u2-1", report["kinds"])
        self.assertEqual(1, report["context_expression_count"])
        self.assertEqual(0, report["speaker_confirmed_rows"])

    def test_expression_label_explicitly_covers_children_but_missing_child_blocks(self):
        rows = [row(text="嗯。", end=300), row("u1-2", start=300)]
        labels = expression_labels(rows, "task", owner="人甲")
        before = copy.deepcopy((rows, labels))
        report = content_audit(rows, labels)
        self.assertTrue(report["ready_for_content"])
        self.assertEqual(2, report["content_label_sources"]["expression"])
        self.assertEqual(before, (rows, labels))
        del labels["人甲"]["u1-1"]
        report = content_audit(rows, labels)
        self.assertFalse(report["ready_for_content"])
        self.assertEqual(["u1-1"], report["expressions"][0]["missing_ids"])

    def test_kind_and_owner_disputes_block_content_speaker_dispute_does_not(self):
        rows = [row()]
        labels = {"人甲": {"u1-1": {"kind": "task", "owner": "人甲", "speaker": "人甲"}},
                  "人乙": {"u1-1": {"kind": "task", "owner": "人甲", "speaker": "人乙"}}}
        report = content_audit(rows, labels)
        self.assertTrue(report["ready_for_content"])
        self.assertEqual(1, len(report["speaker_disputes"]))
        labels["人乙"]["u1-1"]["owner"] = "人乙"
        report = content_audit(rows, labels)
        self.assertFalse(report["ready_for_content"])
        self.assertIn("owner", report["content_disputes"][0])
        labels["人乙"]["u1-1"]["kind"] = "noise"
        self.assertIn("kind", content_audit(rows, labels)["content_disputes"][0])

    def test_labelled_short_task_needs_owner_and_empty_dataset_is_not_ready(self):
        rows = [row(text="周五交。")]  # Optional context until a human says it carries a task.
        self.assertTrue(content_audit(rows, {})["ready_for_content"])
        labels = {"人甲": {"u1-1": {"kind": "task"}}}
        report = content_audit(rows, labels)
        self.assertFalse(report["ready_for_content"])
        self.assertEqual(1, report["required_expression_count"])
        labels["人甲"]["u1-1"]["owner"] = "人甲"
        self.assertTrue(content_audit(rows, labels)["ready_for_content"])
        self.assertFalse(content_audit([], {})["ready_for_content"])

    def test_changed_expression_withdraws_linked_content_but_single_correction_survives(self):
        rows = [row(), row("u1-2", start=2000, end=4000)]
        labels = expression_labels(rows, "task", owner="人甲")
        rows[1]["text"] += "修改。"
        report = content_audit(rows, labels)
        self.assertFalse(report["ready_for_content"])
        self.assertEqual(["u1-1", "u1-2"], report["stale_kind_ids"])
        self.assertEqual({}, report["kinds"])
        labels["人甲"]["u1-2"].pop("kind_source")
        report = content_audit(rows, labels)
        self.assertEqual(["u1-2"], report["complete_ids"])
        self.assertEqual(1, report["content_label_sources"]["legacy"])

    def test_malformed_sources_fail_closed_and_direct_human_fields_stay_separate(self):
        source_row = row(voice="人甲")
        for source in (None, {}, {"mode": "auto"}, {"mode": "expression", "id": "other", "fingerprint": "x"}):
            label = {"kind": "task", "owner": "人甲", "kind_source": source, "speaker": "人甲"}
            current = current_label(source_row, label, expressions([source_row])[0])
            self.assertNotIn("kind", current)
            self.assertNotIn("owner", current)
            self.assertEqual("人甲", current["speaker"])

    def test_versioned_single_correction_ignores_suggestion_changes_but_not_changed_original(self):
        original = row(voice="人甲", role="A")
        source = {"mode": "single", "id": original["id"], "fingerprint": row_fingerprint(original)}
        label = {"kind": "task", "owner": "人甲", "kind_source": source,
                 "speaker": "人乙", "speaker_source": source}
        rows = [dict(original, voice="人乙", role="B")]
        report = content_audit(rows, {"人甲": {original["id"]: label}})
        self.assertTrue(report["ready_for_content"])
        self.assertEqual({"single": 1, "legacy": 0, "expression": 0}, report["content_label_sources"])
        self.assertEqual(1, report["speaker_label_sources"]["single"])
        self.assertEqual(1, report["independent_speaker_rows"])
        for update in (dict(text="变更后的原文。"), dict(start_ms=1), dict(end_ms=3000), dict(parent="u2")):
            with self.subTest(update=update):
                report = content_audit([dict(original, **update)], {"人甲": {original["id"]: label}})
                self.assertEqual([], report["complete_ids"])
                self.assertEqual({}, report["speakers"])
                self.assertEqual([original["id"]], report["stale_kind_ids"])
                self.assertEqual([original["id"]], report["stale_speaker_ids"])


class SpeakerAuditTest(unittest.TestCase):
    def test_batch_identity_is_linked_coverage_and_never_independent_sentence_truth(self):
        rows = [row(voice_group_id="voice:A", voice_group_fingerprint="hash")]
        source = {"mode": "voice_group", "id": "voice:A", "fingerprint": "hash"}
        labels = {"人甲": {"u1-1": {"speaker": "人甲", "speaker_source": source}}}
        report = speaker_audit(rows, labels)
        self.assertEqual({"u1-1": "人甲"}, report["speakers"])
        self.assertEqual((0, 1), (report["independent_speaker_rows"], report["grouped_speaker_rows"]))
        self.assertEqual(1, report["speaker_label_sources"]["voice_group"])
        labels["人乙"] = {"u1-1": {"speaker": "人甲"}}
        report = speaker_audit(rows, labels)
        self.assertEqual((1, 0), (report["independent_speaker_rows"], report["grouped_speaker_rows"]))

    def test_changed_group_or_exclusion_withdraws_only_identity(self):
        rows = [row(voice_group_id="voice:A", voice_group_fingerprint="new")]
        label = {"kind": "info", "speaker": "人甲", "speaker_source":
                 {"mode": "voice_group", "id": "voice:A", "fingerprint": "old"}}
        labels = {"人甲": {"u1-1": label}}
        report = content_audit(rows, labels)
        self.assertTrue(report["ready_for_content"])
        self.assertEqual({}, report["speakers"])
        self.assertEqual(["u1-1"], report["stale_speaker_ids"])
        label["speaker_source"]["fingerprint"] = "new"
        label["speaker_excluded"] = True
        self.assertEqual({}, speaker_audit(rows, labels)["speakers"])
        label.pop("speaker_source")  # A single-sentence correction can name the exception.
        self.assertEqual(1, speaker_audit(rows, labels)["independent_speaker_rows"])

    def test_automatic_voice_and_role_prefills_do_not_become_human_answers(self):
        rows = [row(voice="人甲", role="A", claimed=True)]
        report = content_audit(rows, {})
        self.assertEqual({}, report["speakers"])
        self.assertEqual(0, report["speaker_confirmed_rows"])
        self.assertEqual([], report["complete_ids"])


if __name__ == "__main__":
    unittest.main()
