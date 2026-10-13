#!/usr/bin/env python3
"""Similarity route integration: synthetic source data, zero model calls."""
import copy
import http.client
import json
import os
import tempfile
import threading
import unittest
import urllib.parse
import wave
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import label_ai as ai
import label_similarity_review as sr
import team_label as tl
from label_similarity import SimilarityIndex


ALICE, BOB = tl.PEOPLE[:2]
SECRET = "similarity-api-synthetic-fixture-only"
BASE = "这台设备内置麦克风，可以语音唤醒。"
NEAR = "这台设备内置麦克风，也可以语音唤醒。"
MIDS = ("0235", "0236", "0238")


class SimilarityAPITest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = self.temp.name
        self.sequence = 0
        self.server = None
        # HTTP tests use http.client, so disabling urllib also proves no
        # unexpected model/network path is hidden in the similarity endpoint.
        for target in ("label_ai.load_deepseek", "urllib.request.urlopen"):
            guard = patch(target, side_effect=AssertionError("No model/network request allowed"))
            guard.start()
            self.addCleanup(guard.stop)
        for mid in MIDS:
            self.create_meeting(mid)
        self.data = tl.Data(self.folder)

    @staticmethod
    def read_json(path):
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)

    @staticmethod
    def write_json(path, value):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)

    def create_meeting(self, mid):
        entries = [("anchor", BASE, "fact"), ("same", BASE, "fact"), ("near", NEAR, "fact"),
                   ("blind", BASE, "fact"), ("task", BASE, "task"), ("decision", BASE, "decision"),
                   ("uncertain", BASE, "uncertain"), ("info", BASE, "info"),
                   ("negative", "这台设备没有内置麦克风，不可以语音唤醒。", "fact"),
                   ("number", "这台设备内置 12 个麦克风，可以语音唤醒。", "fact"),
                   ("noise", "嗯嗯。", "noise")]
        rows = [dict(id=uid, parent="parent:" + uid, text=text, start_ms=i * 5000,
                     end_ms=i * 5000 + 3000) for i, (uid, text, kind) in enumerate(entries)]
        folder = os.path.join(self.folder, "meetings", mid)
        self.write_json(os.path.join(folder, "meeting.json"), dict(id=mid, title="合成测试 " + mid, utterances=rows))
        with wave.open(os.path.join(folder, "audio.wav"), "wb") as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(8000)
            stream.writeframes(b"\0\0" * 8)
        # Make a real, immutable whole-parent reservation. All response objects
        # are constructed locally and pass the production sidecar validator.
        blind = ai.build_blind_plan(rows, mid, excluded_ids=[r["id"] for r in rows if r["id"] != "blind"])
        kinds = {uid: kind for uid, text, kind in entries}
        batches = ai.build_batches(rows, blind)
        model = "synthetic-local-sidecar-no-model-call"
        semantic, records = [], []
        for batch in batches:
            response = dict(expressions=[dict(ids=[uid], kind=kinds[uid], reason="合成界面测试依据。")
                                         for uid in batch["ids"]])
            semantic.extend(ai.validate_response(response, batch, rows, model))
            records.append(dict(id=batch["id"], input_hash=batch["input_hash"], status="complete", model=model))
        doc = dict(schema=1, meeting_id=mid, source_hash=ai.source_hash(rows), prompt_version=ai.PROMPT_VERSION,
                   model=model, blind=blind, status="ready", updated_at="synthetic-fixture-v1",
                   expressions=semantic, batches=records)
        path = os.path.join(folder, "suggestions.json")
        self.write_json(path, doc)
        self.assertIsNotNone(ai.load_sidecar(path, rows, mid))

    def request_id(self):
        self.sequence += 1
        return "similarity-api-%06d" % self.sequence

    def group(self, mid="0235", uid="anchor", scope="all", threshold=80, name=ALICE):
        return self.data.similar_payload(mid, name, "ai:" + uid, threshold, scope)

    def body(self, group=None, items=None):
        group = group or self.group()
        selected = items if items is not None else ([group["anchor"]] + group["candidates"])
        return dict(action="confirm_group", request_id=self.request_id(),
                    anchor=copy.deepcopy(group["anchor"]), items=copy.deepcopy(selected),
                    group_fingerprint=group["group_fingerprint"], revisions=copy.deepcopy(group["revisions"]),
                    scope=group["scope"], threshold=group["threshold"])

    def saved(self, mid="0235", name=ALICE):
        path = self.data.labels_path(mid, name)
        return self.read_json(path) if os.path.exists(path) else None

    def all_saved(self):
        return {mid: self.saved(mid) for mid in MIDS}

    def set_row(self, mid, uid, kind="fact"):
        payload = self.data.meeting_payload(mid, ALICE, "assisted")
        row = next(row for row in payload["rows"] if row["id"] == uid)
        return self.data.review(mid, ALICE, dict(action="set", request_id=self.request_id(),
            review_mode="assisted", revision=payload["revision"], scope="row", id=uid,
            fingerprint=row["fingerprint"], field="kind", value=kind))

    def start_http(self):
        if self.server is not None:
            return
        handler = tl.make_handler(self.data, SECRET)
        handler.log_message = lambda *_args: None
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_http)

    def close_http(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def http(self, path, body=None, key=True, person=ALICE, labeler=None):
        self.start_http()
        headers = {}
        if key:
            headers["Authorization"] = "Bearer " + tl.make_key(SECRET, person)
        if labeler is not None:
            headers["X-Labeler"] = urllib.parse.quote(labeler)
        raw = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        if raw is not None:
            headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            conn.request("POST" if body is not None else "GET", path, raw, headers)
            response = conn.getresponse()
            result = response.read()
            return response.status, json.loads(result)
        finally:
            conn.close()

    @staticmethod
    def query(scope="all", threshold=80, meeting="0235", expression="ai:anchor"):
        return "/api/similar?" + urllib.parse.urlencode(dict(meeting=meeting, expression=expression,
                                                          scope=scope, threshold=threshold))

    def test_cross_three_meetings_scores_are_real_and_direct_from_anchor(self):
        group = self.group()
        self.assertEqual(set(MIDS), {m["meeting"] for m in [group["anchor"]] + group["candidates"]})
        self.assertEqual(8, len(group["candidates"]))
        pool = []
        for mid in MIDS:
            ai_doc, _ = self.data.annotation_state(mid)
            kinds = {e["id"]: e["kind"] for e in ai_doc["expressions"]}
            pool.extend(dict(u, id=mid + "/" + u["id"], kind=kinds.get(u["id"]))
                        for u in self.data.content_units(mid))
        index = SimilarityIndex(pool, protected_terms=tl.PEOPLE + [p[-2:] for p in tl.PEOPLE])
        expected = {m["id"]: m["score"] for m in index.matches("0235/ai:anchor", 80)}
        self.assertEqual(expected, {m["meeting"] + "/" + m["expression"]: m["score"] for m in group["candidates"]})
        self.assertTrue(any(80 <= m["score"] < 100 for m in group["candidates"]))
        self.assertEqual("text-char-v1", group["method"])
        self.assertTrue(all(saved is None for saved in self.all_saved().values()))

    def test_current_scope_and_all_scope_are_distinct(self):
        current, all_groups = self.group(scope="current"), self.group(scope="all")
        self.assertEqual({"0235"}, {m["meeting"] for m in current["candidates"]})
        self.assertEqual(2, len(current["candidates"]))
        self.assertEqual(8, len(all_groups["candidates"]))
        self.assertNotEqual(current["group_fingerprint"], all_groups["group_fingerprint"])
        self.assertEqual({"0235"}, set(current["revisions"]))

    def test_blind_unsafe_kinds_and_guarded_changes_never_appear_or_expose(self):
        group = self.group()
        forbidden = {"ai:" + uid for uid in ("blind", "task", "decision", "uncertain", "info", "negative", "number", "noise")}
        self.assertFalse(forbidden.intersection(m["expression"] for m in group["candidates"]))
        for mid in MIDS:
            self.assertNotIn("blind", self.data._exposed(mid, ALICE))
            self.assertIsNone(self.saved(mid))

    def test_existing_answers_and_single_sentence_exceptions_are_excluded(self):
        self.set_row("0236", "same", "info")
        self.write_json(self.data.labels_path("0238", ALICE), dict(revision=4, labels={"same": {"kind": "fact"}}))
        before = self.all_saved()
        group = self.group()
        self.assertNotIn(("0236", "ai:same"), {(m["meeting"], m["expression"]) for m in group["candidates"]})
        self.assertNotIn(("0238", "ai:same"), {(m["meeting"], m["expression"]) for m in group["candidates"]})
        self.assertEqual(before, self.all_saved())
        self.data.review_similar(ALICE, self.body(group))
        self.assertEqual("info", self.saved("0236")["labels"]["same"]["kind"])
        self.assertEqual("single", self.saved("0236")["labels"]["same"]["kind_source"]["mode"])
        self.assertEqual({"kind": "fact"}, self.saved("0238")["labels"]["same"])

    def test_already_confirmed_anchor_is_readonly_but_can_review_new_candidates(self):
        group = self.group()
        self.data.review_similar(ALICE, self.body(group, items=[group["anchor"]]))
        next_group = self.group()
        self.assertTrue(next_group["anchor"]["readonly"])
        self.assertEqual(8, len(next_group["candidates"]))
        self.assertRaises(ValueError, self.data.review_similar, ALICE, self.body(next_group))
        result = self.data.review_similar(ALICE, self.body(next_group, items=next_group["candidates"]))
        self.assertEqual(8, result["transaction"]["affected_expressions"])

    def test_single_corrected_anchor_is_not_eligible(self):
        self.set_row("0235", "anchor", "fact")
        self.assertRaises(tl.RevisionConflict, self.group)

    def test_thresholds_scope_and_unknown_anchor_validate_over_http(self):
        for threshold in (60, 70, 80):
            self.assertEqual(200, self.http(self.query(threshold=threshold))[0])
        self.assertEqual(400, self.http(self.query(threshold=75))[0])
        self.assertEqual(400, self.http(self.query(scope="everything"))[0])
        self.assertEqual(400, self.http(self.query(meeting="9999"))[0])
        self.assertEqual(409, self.http(self.query(expression="ai:blind"))[0])

    def test_http_authentication_and_team_selection_cannot_be_bypassed(self):
        self.assertEqual(401, self.http(self.query(), key=False)[0])
        self.assertEqual(401, self.http("/api/similar/review", self.body(), key=False)[0])
        self.assertNotEqual(200, self.http(self.query(), person=tl.TEAM)[0])
        self.assertEqual(200, self.http(self.query(), person=tl.TEAM, labeler=ALICE)[0])
        self.assertTrue(all(saved is None for saved in self.all_saved().values()))

    def test_http_confirm_is_personal_idempotent_and_group_undo_is_complete(self):
        status, group = self.http(self.query())
        self.assertEqual(200, status)
        body = self.body(group)
        status, result = self.http("/api/similar/review", body)
        self.assertEqual(200, status)
        self.assertEqual(9, result["transaction"]["affected_expressions"])
        self.assertEqual(set(MIDS), set(result["meetings"]))
        for mid in MIDS:
            self.assertEqual(3, len(self.saved(mid)["labels"]))
            self.assertTrue(all(label["kind_source"]["review_mode"] == "ai_assisted"
                                for label in self.saved(mid)["labels"].values()))
            self.assertIsNone(self.saved(mid, BOB))
        before = self.all_saved()
        self.assertEqual((200, result), self.http("/api/similar/review", body))
        self.assertEqual(before, self.all_saved())
        undo = dict(action="undo_group", request_id=self.request_id(), group_request_id=body["request_id"],
                    revisions=result["meetings"])
        status, receipt = self.http("/api/similar/review", undo)
        self.assertEqual(200, status)
        self.assertEqual(9, receipt["transaction"]["affected_expressions"])
        self.assertTrue(all(saved["labels"] == {} for saved in self.all_saved().values()))
        self.assertEqual((200, receipt), self.http("/api/similar/review", undo))

    def test_http_subset_confirmation_saves_only_explicitly_selected_members(self):
        group = self.group()
        member = next(m for m in group["candidates"] if m["meeting"] == "0238")
        body = self.body(group, [group["anchor"], member])
        status, result = self.http("/api/similar/review", body)
        self.assertEqual(200, status)
        self.assertEqual(2, result["transaction"]["affected_expressions"])
        self.assertIsNone(self.saved("0236"))
        self.assertEqual(1, len(self.saved("0238")["labels"]))

    def test_http_stale_revision_and_group_fingerprint_never_partially_write(self):
        group = self.group()
        body = self.body(group)
        self.set_row("0238", "number", "fact")
        before = self.all_saved()
        self.assertEqual(409, self.http("/api/similar/review", body)[0])
        self.assertEqual(before, self.all_saved())
        body = self.body()
        body["group_fingerprint"] = "outdated-group"
        self.assertEqual(409, self.http("/api/similar/review", body)[0])
        self.assertEqual(before, self.all_saved())

    def test_http_stale_source_withdraws_meeting_and_rejects_old_confirmation(self):
        group = self.group()
        body = self.body(group)
        path = os.path.join(self.folder, "meetings", "0236", "suggestions.json")
        changed = self.read_json(path)
        changed["source_hash"] = "outdated-source"
        self.write_json(path, changed)
        now = self.group()
        self.assertNotIn("0236", {member["meeting"] for member in now["candidates"]})
        self.assertEqual(409, self.http("/api/similar/review", body)[0])
        self.assertTrue(all(saved is None for saved in self.all_saved().values()))

    def test_http_unviewed_blind_member_and_changed_score_filter_are_rejected(self):
        group = self.group()
        body = self.body(group)
        invented = copy.deepcopy(body["items"][0])
        invented["expression"] = "ai:blind"
        body["items"].append(invented)
        self.assertEqual(409, self.http("/api/similar/review", body)[0])
        body = self.body(group)
        body["scope"] = "current"
        self.assertEqual(409, self.http("/api/similar/review", body)[0])
        self.assertTrue(all(saved is None for saved in self.all_saved().values()))

    def test_http_malformed_or_reused_request_cannot_change_saved_group(self):
        self.assertEqual(400, self.http("/api/similar/review", ["not", "an", "object"])[0])
        body = self.body()
        self.assertEqual(200, self.http("/api/similar/review", body)[0])
        before = self.all_saved()
        self.assertEqual(400, self.http("/api/similar/review", dict(body, threshold=60))[0])
        self.assertEqual(before, self.all_saved())

    def test_http_get_and_post_stop_with_503_when_recovery_journal_is_invalid(self):
        body = self.body()
        journal = os.path.join(self.folder, "similarity_requests", ALICE, "invalid-local-journal.json")
        self.write_json(journal, {"version": "invalid"})
        expected = (503, {"error": "recovery_required"})
        self.assertEqual(expected, self.http(self.query()))
        self.assertEqual(expected, self.http("/api/similar/review", body))
        self.assertTrue(all(saved is None for saved in self.all_saved().values()))

    def test_http_storage_failure_keeps_recoverable_group_receipt(self):
        body = self.body()
        original_write = sr._atomic_write
        failed = False

        def interrupt_label_write(path, value):
            nonlocal failed
            if not failed and os.sep + "labels" + os.sep in path:
                failed = True
                raise OSError("synthetic interrupted disk write")
            return original_write(path, value)

        with patch("label_similarity_review._atomic_write", side_effect=interrupt_label_write):
            self.assertEqual((503, {"error": "storage_unavailable"}), self.http("/api/similar/review", body))
        self.assertTrue(failed)
        # The exact request is safe to replay. Forward recovery finishes every
        # meeting before idempotency returns the originally committed receipt.
        status, result = self.http("/api/similar/review", body)
        self.assertEqual(200, status)
        self.assertEqual(set(MIDS), set(result["meetings"]))
        self.assertTrue(all(len(saved["labels"]) == 3 for saved in self.all_saved().values()))
        before = self.all_saved()
        self.assertEqual((200, result), self.http("/api/similar/review", body))
        self.assertEqual(before, self.all_saved())


if __name__ == "__main__":
    unittest.main()
