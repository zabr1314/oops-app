#!/usr/bin/env python3
"""Temporary-data integration checks for grouped identity/content reviews."""
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
import wave
from http.server import ThreadingHTTPServer

import team_label as tl
from label_workflow import content_audit


SECRET = "workflow-test-only-" + "s" * 32
ALICE, BOB = tl.PEOPLE[:2]
ROWS = [
    dict(id="a1", parent="final-a", text="我们把这个方案", start_ms=500, end_ms=1500),
    dict(id="a2", parent="final-a", text="明天整理完发给大家。", start_ms=1600, end_ms=3100),
    dict(id="a3", parent="final-a", text="对。", start_ms=3200, end_ms=3600),
    dict(id="short", parent="final-short", text="嗯。", start_ms=3800, end_ms=4200),
    dict(id="b1", parent="final-b", text="这一句由另一组的说话人来说。", start_ms=4500, end_ms=6000),
]
OTHER_ROWS = [
    dict(id="c1", parent="final-c", text="另一场会议也有同一个音色的人。", start_ms=500, end_ms=2000),
    dict(id="c2", parent="final-d", text="这个片段来自已识别的另一个音色。", start_ms=2500, end_ms=4000),
]


class WorkflowFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = self.temp.name
        self.sequence = 0
        for mid, rows in (("0235", ROWS), ("0236", OTHER_ROWS)):
            path = os.path.join(self.folder, "meetings", mid)
            os.makedirs(path)
            self.write_json(os.path.join(path, "meeting.json"),
                dict(id=mid, session="test-session-" + mid, title="合成测试会议", utterances=rows))
            with wave.open(os.path.join(path, "audio.wav"), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b"\0\0" * 16000 * 8)
            role_rows = {row["id"]: {"role": "A" if row["id"] != "b1" else "B"}
                         for row in rows if row["id"] != "c2"}
            self.write_json(os.path.join(path, "roles.json"),
                dict(roles={"A": {"seconds": 20}, "B": {"seconds": 2}}, rows=role_rows))
            if mid == "0236":
                self.write_json(os.path.join(path, "voice.json"), dict(rows={"c2": {"name": BOB}}))
        self.data = tl.Data(self.folder)

    @staticmethod
    def write_json(path, value):
        with open(path, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False)

    @staticmethod
    def read_json(path):
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)

    def request_id(self):
        self.sequence += 1
        return "test-request-%04d" % self.sequence

    def identity_body(self, action="confirm", group="role:A", speaker=ALICE, name=ALICE):
        payload = self.data.identity_payload(name)
        chosen = next(item for item in payload["groups"] if item["id"] == group)
        return dict(request_id=self.request_id(), revision=payload["revision"], action=action,
                    group=group, fingerprint=chosen["fingerprint"], speaker=speaker)

    def expression_body(self, field="kind", value="info", mid="0235", uid="a1", name=ALICE):
        payload = self.data.meeting_payload(mid, name)
        expression = next(item for item in payload["expressions"] if uid in item["ids"])
        return dict(request_id=self.request_id(), revision=payload["revision"], action="set",
                    scope="expression", expression=expression["id"], fingerprint=expression["fingerprint"],
                    field=field, value=value)

    def row_body(self, uid, field, value, mid="0235", name=ALICE):
        payload = self.data.meeting_payload(mid, name)
        row = next(item for item in payload["rows"] if item["id"] == uid)
        return dict(request_id=self.request_id(), revision=payload["revision"],
                    action="set", scope="row", id=uid, field=field, value=value, fingerprint=row["fingerprint"])

    def set_row(self, uid, field, value, mid="0235", name=ALICE):
        return self.data.review(mid, name, self.row_body(uid, field, value, mid, name))

    def set_expression(self, field="kind", value="info", mid="0235", uid="a1", name=ALICE):
        return self.data.review(mid, name, self.expression_body(field, value, mid, uid, name))

    def labels(self, mid="0235", name=ALICE):
        return self.data.meeting_payload(mid, name)["labels"]

    def undo(self, identity=False, mid="0235", name=ALICE):
        payload = self.data.identity_payload(name) if identity else self.data.meeting_payload(mid, name)
        body = dict(action="undo", request_id=self.request_id(), revision=payload["revision"])
        return self.data.review_identity(name, body) if identity else self.data.review(mid, name, body)


class IdentityWorkflowTest(WorkflowFixture):
    def test_group_confirmation_links_across_meetings_without_persisting_row_truth(self):
        self.set_expression()
        before = self.read_json(self.data.labels_path("0235", ALICE))
        result = self.data.review_identity(ALICE, self.identity_body())
        group = next(item for item in result["groups"] if item["id"] == "role:A")
        self.assertEqual(5, group["count"])
        self.assertTrue(group["current"])
        for mid, ids in (("0235", ("a1", "a2", "a3", "short")), ("0236", ("c1",))):
            for uid in ids:
                label = self.labels(mid)[uid]
                self.assertEqual(ALICE, label["speaker"])
                self.assertEqual("voice_group", label["speaker_source"]["mode"])
        self.assertFalse(self.labels().get("b1", {}).get("speaker"))
        self.assertFalse(self.labels("0236").get("c2", {}).get("speaker"))
        self.assertEqual(before, self.read_json(self.data.labels_path("0235", ALICE)))
        self.assertFalse(os.path.exists(self.data.labels_path("0236", ALICE)))
        self.assertTrue(os.path.isfile(os.path.join(self.folder, "identities", ALICE + ".json")))
        audit = content_audit(self.data.rows_with_claims("0235"), {ALICE: self.data.load("0235", ALICE)})
        self.assertEqual((0, 4), (audit["independent_speaker_rows"], audit["grouped_speaker_rows"]))

    def test_identity_approval_and_undo_are_personal(self):
        self.data.review_identity(ALICE, self.identity_body())
        self.assertEqual({}, {uid: label for uid, label in self.labels(name=BOB).items() if label})
        self.assertTrue(all(not group["current"] for group in self.data.identity_payload(BOB)["groups"]))
        self.data.review_identity(BOB, self.identity_body(speaker=BOB, name=BOB))
        self.assertEqual((ALICE, BOB), (self.labels()["a1"]["speaker"], self.labels(name=BOB)["a1"]["speaker"]))
        self.undo(identity=True, name=BOB)
        self.assertEqual(ALICE, self.labels()["a1"]["speaker"])
        self.assertFalse(self.labels(name=BOB).get("a1", {}).get("speaker"))

    def test_single_correction_and_exclusion_survive_revoke_and_identity_undo(self):
        self.data.review_identity(ALICE, self.identity_body())
        self.set_row("a1", "speaker", BOB)
        self.set_row("a2", "speaker", None)
        self.assertEqual("single", self.labels()["a1"]["speaker_source"]["mode"])
        stored = self.read_json(self.data.labels_path("0235", ALICE))
        self.data.review_identity(ALICE, self.identity_body(action="revoke"))
        self.assertEqual(BOB, self.labels()["a1"]["speaker"])
        self.assertTrue(self.labels()["a2"]["speaker_excluded"])
        self.assertFalse(self.labels().get("a2", {}).get("speaker"))
        self.assertFalse(self.labels().get("a3", {}).get("speaker"))
        self.data = tl.Data(self.folder)
        self.undo(identity=True)
        self.assertEqual(ALICE, self.labels()["a3"]["speaker"])
        self.assertEqual(BOB, self.labels()["a1"]["speaker"])
        self.assertFalse(self.labels().get("a2", {}).get("speaker"))
        self.assertEqual(stored, self.read_json(self.data.labels_path("0235", ALICE)))

    def test_identity_request_replay_is_idempotent_but_changed_body_is_rejected(self):
        body = self.identity_body()
        first = self.data.review_identity(ALICE, body)
        self.data = tl.Data(self.folder)
        second = self.data.review_identity(ALICE, body)
        self.assertEqual(first, second)
        with self.assertRaises(ValueError):
            self.data.review_identity(ALICE, dict(body, speaker=BOB))
        with self.assertRaises(tl.RevisionConflict):
            self.data.review_identity(ALICE, dict(body, request_id=self.request_id()))
        self.assertEqual(1, self.data.identity_payload(ALICE)["revision"])

    def test_changed_group_invalidates_linked_identity_but_preserves_single_correction(self):
        self.data.review_identity(ALICE, self.identity_body())
        self.set_row("a1", "speaker", BOB)
        path = os.path.join(self.folder, "meetings", "0236", "meeting.json")
        changed = self.read_json(path)
        changed["utterances"][0]["text"] += "来源已更新。"
        self.write_json(path, changed)
        self.data = tl.Data(self.folder)
        self.assertFalse(next(group for group in self.data.identity_payload(ALICE)["groups"]
                              if group["id"] == "role:A")["current"])
        self.assertEqual(BOB, self.labels()["a1"]["speaker"])
        self.assertFalse(self.labels().get("a2", {}).get("speaker"))
        self.assertFalse(self.labels("0236").get("c1", {}).get("speaker"))


class ContentWorkflowTest(WorkflowFixture):
    def test_expression_label_covers_all_pieces_including_short_context(self):
        payload = self.set_expression(value="info")
        expression = next(unit for unit in payload["expressions"] if "a1" in unit["ids"])
        self.assertEqual(["a1", "a2", "a3"], expression["ids"])
        for uid in expression["ids"]:
            self.assertEqual("info", payload["labels"][uid]["kind"])
            self.assertEqual(dict(mode="expression", id=expression["id"], fingerprint=expression["fingerprint"]),
                             payload["labels"][uid]["kind_source"])
            self.assertFalse(payload["labels"][uid].get("speaker"))
        self.assertFalse(payload["labels"].get("short", {}).get("kind"))
        self.assertEqual({}, {uid: label for uid, label in self.labels(name=BOB).items() if label})

    def test_task_owner_and_duplicate_fields_follow_content_kind(self):
        self.set_expression(field="owner", value=ALICE)
        self.assertTrue(all(not label.get("owner") for label in self.labels().values()))
        self.set_expression(value="task")
        self.set_expression(field="owner", value=BOB)
        self.set_expression(field="dup", value="A")
        for uid in ("a1", "a2", "a3"):
            self.assertEqual(("task", BOB, "A"), tuple(self.labels()[uid][key] for key in ("kind", "owner", "dup")))
        self.set_expression(value="decision")
        self.assertTrue(all(not self.labels()[uid].get("owner") for uid in ("a1", "a2", "a3")))
        self.set_expression(value="noise")
        self.assertTrue(all(not self.labels()[uid].get("dup") for uid in ("a1", "a2", "a3")))

    def test_expression_changes_keep_single_and_legacy_content_exceptions(self):
        self.data.save("0235", ALICE, {"a1": {"kind": "noise"}})
        self.set_row("a2", "kind", "decision")
        self.set_expression(value="task")
        labels = self.labels()
        self.assertEqual(("noise", "decision", "task"), tuple(labels[uid]["kind"] for uid in ("a1", "a2", "a3")))
        self.assertNotIn("kind_source", labels["a1"])
        self.assertEqual("single", labels["a2"]["kind_source"]["mode"])
        self.assertEqual("expression", labels["a3"]["kind_source"]["mode"])

    def test_single_owner_correction_is_not_overwritten_by_whole_expression(self):
        self.set_expression(value="task")
        self.set_expression(field="owner", value=ALICE)
        self.set_row("a2", "owner", BOB)
        self.set_expression(field="owner", value=ALICE)
        self.assertEqual((ALICE, BOB, ALICE), tuple(self.labels()[uid]["owner"] for uid in ("a1", "a2", "a3")))

    def test_content_and_single_undo_survive_data_reload(self):
        self.set_expression(value="info")
        self.set_row("a3", "kind", "noise")
        self.data = tl.Data(self.folder)
        self.assertEqual("noise", self.labels()["a3"]["kind"])
        self.undo()
        self.assertEqual("info", self.labels()["a3"]["kind"])
        self.data = tl.Data(self.folder)
        self.undo()
        self.assertTrue(all(not label.get("kind") for label in self.labels().values()))

    def test_content_request_replay_conflict_and_validation_do_not_double_apply(self):
        body = self.expression_body()
        first = self.data.review("0235", ALICE, body)
        self.data = tl.Data(self.folder)
        self.assertEqual(first, self.data.review("0235", ALICE, body))
        with self.assertRaises(ValueError):
            self.data.review("0235", ALICE, dict(body, value="noise"))
        with self.assertRaises(tl.RevisionConflict):
            self.data.review("0235", ALICE, dict(body, request_id=self.request_id()))
        bad = self.expression_body()
        bad["fingerprint"] = "outdated"
        with self.assertRaises(tl.RevisionConflict):
            self.data.review("0235", ALICE, bad)
        self.assertEqual(1, self.data.meeting_payload("0235", ALICE)["revision"])
        self.assertEqual(1, len(self.read_json(self.data.labels_path("0235", ALICE))["history"]))

    def test_changed_expression_withdraws_linked_content_and_owner(self):
        self.set_expression(value="task")
        self.set_expression(field="owner", value=ALICE)
        self.set_row("a1", "kind", "info")
        path = os.path.join(self.folder, "meetings", "0235", "meeting.json")
        changed = self.read_json(path)
        changed["utterances"][1]["text"] += "后来改了。"
        self.write_json(path, changed)
        self.data = tl.Data(self.folder)
        payload = self.data.meeting_payload("0235", ALICE)
        self.assertEqual("info", payload["labels"]["a1"]["kind"])
        for uid in ("a2", "a3"):
            self.assertFalse(payload["labels"].get(uid, {}).get("kind"))
            self.assertFalse(payload["labels"].get(uid, {}).get("owner"))
            self.assertIn(uid, payload["stale_ids"])
        stored = self.read_json(self.data.labels_path("0235", ALICE))["labels"]
        self.assertEqual("task", stored["a2"]["kind"], "Invalidation must preserve the original review for audit")

    def test_expression_scope_cannot_establish_speaker_identity(self):
        with self.assertRaises(ValueError):
            self.set_expression(field="speaker", value=ALICE)
        self.assertEqual(0, self.data.meeting_payload("0235", ALICE)["revision"])

    def test_changed_sentence_invalidates_versioned_single_corrections(self):
        self.set_row("a1", "kind", "task")
        self.set_row("a1", "owner", ALICE)
        self.set_row("a1", "speaker", BOB)
        path = os.path.join(self.folder, "meetings", "0235", "meeting.json")
        changed = self.read_json(path)
        changed["utterances"][0]["text"] = "这是替换过的句子。"
        self.write_json(path, changed)
        self.data = tl.Data(self.folder)
        payload = self.data.meeting_payload("0235", ALICE)
        label = payload["labels"].get("a1", {})
        self.assertFalse(any(label.get(field) for field in ("kind", "owner", "speaker")))
        self.assertIn("a1", payload["stale_ids"])


class WorkflowHttpTest(WorkflowFixture):
    def setUp(self):
        super().setUp()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), tl.make_handler(self.data, SECRET))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = "http://127.0.0.1:%s" % self.server.server_address[1]

    def call(self, path, key=None, body=None, name=None, headers=None):
        headers = dict(headers or {})
        if key:
            headers["Authorization"] = "Bearer " + key
        if name:
            headers["X-Labeler"] = urllib.parse.quote(name)
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, headers=headers,
                                        data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.read()

    def test_new_routes_need_authentication_and_a_named_shared_link_labeler(self):
        for path, body in (("/api/identity", None), ("/api/identity", self.identity_body()),
                           ("/api/meeting/0235/review", self.expression_body()),
                           ("/clip/0235/a1.wav?through=a3", None)):
            self.assertEqual(401, self.call(path, body=body)[0], path)
        team = tl.make_key(SECRET, tl.TEAM)
        self.assertEqual(401, self.call("/api/identity", team, self.identity_body())[0])
        self.assertEqual(401, self.call("/api/meeting/0235/review", team, self.expression_body())[0])
        self.assertEqual(200, self.call("/api/identity", team, self.identity_body(), name=ALICE)[0])
        personal = tl.make_key(SECRET, ALICE)
        self.assertEqual(ALICE, json.loads(self.call("/api/meeting/0236", personal)[1])["labels"]["c1"]["speaker"])
        other = tl.make_key(SECRET, BOB)
        self.assertFalse(json.loads(self.call("/api/meeting/0236", other)[1])["labels"].get("c1", {}).get("speaker"))

    def test_review_endpoints_report_revision_and_fingerprint_conflicts(self):
        key = tl.make_key(SECRET, ALICE)
        identity = self.identity_body()
        self.assertEqual(200, self.call("/api/identity", key, identity)[0])
        self.assertEqual(200, self.call("/api/identity", key, identity)[0])
        self.assertEqual(400, self.call("/api/identity", key, dict(identity, speaker=BOB))[0])
        self.assertEqual(409, self.call("/api/identity", key,
                                      dict(identity, request_id=self.request_id()))[0])
        body = self.expression_body()
        path = "/api/meeting/0235/review"
        self.assertEqual(200, self.call(path, key, body)[0])
        self.assertEqual(200, self.call(path, key, body)[0])
        self.assertEqual(400, self.call(path, key, dict(body, value="noise"))[0])
        self.assertEqual(409, self.call(path, key, dict(body, request_id=self.request_id()))[0])
        stale = self.expression_body()
        self.assertEqual(409, self.call(path, key, dict(stale, fingerprint="outdated"))[0])
        stale_row = self.row_body("a1", "kind", "decision")
        self.assertEqual(409, self.call(path, key, dict(stale_row, fingerprint="outdated"))[0])
        stale_group = self.identity_body()
        self.assertEqual(409, self.call("/api/identity", key, dict(stale_group, fingerprint="outdated"))[0])
        self.assertEqual(1, json.loads(self.call("/api/meeting/0235", key)[1])["revision"])

    def test_legacy_bulk_save_requires_current_revision(self):
        key = tl.make_key(SECRET, ALICE)
        path = "/api/meeting/0235/labels"
        content = {"a1": {"kind": "noise"}}
        self.assertEqual(409, self.call(path, key, content)[0])
        self.assertEqual(200, self.call(path, key, content, headers={"X-Label-Revision": "0"})[0])
        self.assertEqual(409, self.call(path, key, {}, headers={"X-Label-Revision": "0"})[0])
        payload = json.loads(self.call("/api/meeting/0235", key)[1])
        self.assertEqual((1, "noise"), (payload["revision"], payload["labels"]["a1"]["kind"]))

    def test_full_expression_audio_is_bounded_by_the_exact_expression(self):
        key = tl.make_key(SECRET, ALICE)
        status, result = self.call("/clip/0235/a1.wav?through=a3&pad=0", key)
        self.assertEqual(200, status)
        with wave.open(io.BytesIO(result), "rb") as clip:
            self.assertEqual((1, 2, 16000), (clip.getnchannels(), clip.getsampwidth(), clip.getframerate()))
            self.assertEqual((3600 - 500) * 16, clip.getnframes())
        for path in ("/clip/0235/a1.wav?through=short", "/clip/0235/a1.wav?through=b1",
                     "/clip/0235/a2.wav?through=a3", "/clip/0235/a1.wav?through=missing"):
            self.assertEqual(400, self.call(path, key)[0], path)


if __name__ == "__main__":
    unittest.main()
