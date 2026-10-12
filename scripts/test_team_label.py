#!/usr/bin/env python3
"""Team labelling site: personal keys, blind pages, per-person storage and the merge into one truth."""
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

SECRET = "s" * 40
ROWS = [{"id": f"u1-{i}", "parent": "u1", "text": f"这是第{i}句比较长的测试句子", "start_ms": i * 2000, "end_ms": i * 2000 + 1500} for i in range(1, 5)]


class KeyTest(unittest.TestCase):
    def test_key_names_its_holder_and_rejects_tampering(self):
        key = tl.make_key(SECRET, "江古月")
        self.assertEqual("江古月", tl.check_key(SECRET, key))
        self.assertIsNone(tl.check_key("t" * 40, key))
        self.assertIsNone(tl.check_key(SECRET, tl.make_key(SECRET, "路人甲")))
        forged = tl.make_key(SECRET, "林春源").split(".")[0] + "." + key.split(".")[1]
        self.assertIsNone(tl.check_key(SECRET, forged))
        for junk in ("", ".", "abc", None):
            self.assertIsNone(tl.check_key(SECRET, junk))


class MergeTest(unittest.TestCase):
    def test_clean_drops_unknown_values_and_orphan_fields(self):
        raw = {"u1-1": {"speaker": "路人", "kind": "noise", "owner": "林春源", "dup": "A"},
               "u1-2": {"kind": "task", "owner": "collective", "dup": "AB"}, "zz": {"kind": "task"}}
        self.assertEqual({"u1-1": {"kind": "noise"}, "u1-2": {"kind": "task", "owner": "collective"}}, tl.clean(raw, ROWS))

    def test_agreement_becomes_truth_and_disagreement_a_dispute(self):
        a = {"u1-1": {"speaker": "林春源", "kind": "task", "owner": "洪玉麟", "dup": "A"},
             "u1-2": {"speaker": "洪玉麟", "kind": "task", "owner": "洪玉麟", "dup": "A"},
             "u1-3": {"speaker": "江古月", "kind": "decision"}, "u1-4": {"kind": "noise"}}
        b = {"u1-1": {"speaker": "林春源", "kind": "task", "owner": "洪玉麟", "dup": "C"},
             "u1-3": {"speaker": "黄丽萍", "kind": "info"}}
        truth = tl.merge(ROWS, {"林春源": a, "洪玉麟": b})
        self.assertEqual([("u1-1", "洪玉麟"), ("u1-2", "洪玉麟")], [(t["utterance"], t["owner"]) for t in truth["tasks"]])
        self.assertEqual([], truth["decisions"])  # u1-3 kind is disputed, so it is neither
        self.assertEqual(["u1-4"], [n["utterance"] for n in truth["non_tasks"]])
        self.assertEqual([["u1-1", "u1-2"]], truth["duplicates"])
        self.assertEqual(["u1-3"], [d["utterance"] for d in truth["disputes"]])
        self.assertEqual({"kind", "speaker"}, set(truth["disputes"][0]) & {"kind", "speaker", "owner"})
        self.assertEqual({"u1-1": "林春源", "u1-2": "洪玉麟"}, truth["speakers"])

    def test_voice_prefill_counts_as_speaker_but_stays_apart_from_human_labels(self):
        rows = [dict(u, voice="洪玉麟") for u in ROWS[:3]] + ROWS[3:]
        self.assertTrue(tl.complete({"kind": "info"}, rows[0]))
        truth = tl.merge(rows, {"林春源": {"u1-1": {"kind": "info"}, "u1-2": {"kind": "info", "speaker": "林春源"},
                                         "u1-3": {"kind": "info", "speaker": "洪玉麟"}}})
        self.assertEqual({"u1-2": "林春源", "u1-3": "洪玉麟"}, truth["speakers"])
        self.assertEqual({"u1-1": "洪玉麟"}, truth["voice_prefill_unreviewed"])
        self.assertEqual({"u1-2": {"voice": "洪玉麟", "human": "林春源"}}, truth["voice_prefill_overruled"])

    def test_completion_allows_short_rows_without_speaker(self):
        short = {"start_ms": 0, "end_ms": 600}
        self.assertTrue(tl.complete({"kind": "noise"}, short))
        self.assertFalse(tl.complete({"kind": "noise"}, ROWS[0]))
        self.assertFalse(tl.complete({"kind": "task", "speaker": "林春源"}, ROWS[0]))


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        folder = os.path.join(self.dir.name, "meetings", "0236")
        os.makedirs(folder)
        with open(os.path.join(folder, "meeting.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "0236", "session": "x", "title": "t",
                       "utterances": [dict(u, speaker="林春源", tag="commitment") for u in ROWS]}, f, ensure_ascii=False)
        with wave.open(os.path.join(folder, "audio.wav"), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\0\0" * 16000 * 10)
        server = ThreadingHTTPServer(("127.0.0.1", 0), tl.make_handler(tl.Data(self.dir.name), SECRET))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.base = f"http://127.0.0.1:{server.server_address[1]}"

    def call(self, path, key=None, body=None):
        req = urllib.request.Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + key} if key else {})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_everything_but_the_page_needs_a_key(self):
        self.assertEqual(200, self.call("/")[0])
        for path in ("/api/me", "/api/meeting/0236", "/clip/0236/u1-1.wav", "/clip/0236/u1-1.wav?k=bad.key"):
            self.assertEqual(401, self.call(path)[0], path)
        self.assertEqual(401, self.call("/api/meeting/0236/labels", body={})[0])

    def test_labels_are_per_person_and_the_page_is_blind(self):
        a, b = tl.make_key(SECRET, "林春源"), tl.make_key(SECRET, "黄丽萍")
        status, _ = self.call("/api/meeting/0236/labels", a, {"u1-1": {"speaker": "林春源", "kind": "noise"}})
        self.assertEqual(200, status)
        mine = json.loads(self.call("/api/meeting/0236", a)[1])
        theirs = json.loads(self.call("/api/meeting/0236", b)[1])
        self.assertEqual({"u1-1": {"speaker": "林春源", "kind": "noise"}}, mine["labels"])
        self.assertEqual({}, theirs["labels"])
        self.assertNotIn("tag", json.dumps(mine["rows"]))
        self.assertNotIn("speaker", json.dumps(mine["rows"]))
        me = json.loads(self.call("/api/me", b)[1])
        self.assertEqual(("黄丽萍", {"林春源": 1}), (me["name"], me["meetings"][0]["progress"]))
        status, data = self.call(f"/clip/0236/u1-1.wav?pad=0&k={b}")
        self.assertEqual((200, 1500 * 32 + 44), (status, len(data)))

    def test_shared_link_needs_a_named_labeler(self):
        team = tl.make_key(SECRET, tl.TEAM)
        self.assertEqual({"name": None, "people": tl.PEOPLE}, json.loads(self.call("/api/me", team)[1]))
        self.assertEqual(400, self.call("/api/meeting/0236", team)[0])
        self.assertEqual(401, self.call("/api/meeting/0236/labels", team, {"u1-1": {"kind": "noise"}})[0])
        self.assertEqual(200, self.call(f"/clip/0236/u1-1.wav?k={team}")[0])
        req = urllib.request.Request(self.base + "/api/meeting/0236/labels", data=b'{"u1-1":{"kind":"noise"}}',
                                     headers={"Authorization": "Bearer " + team,
                                              "X-Labeler": urllib.parse.quote("江古月")})
        with urllib.request.urlopen(req) as r:
            self.assertEqual(200, r.status)
        mine = json.loads(self.call("/api/meeting/0236", tl.make_key(SECRET, "江古月"))[1])
        self.assertEqual({"u1-1": {"kind": "noise"}}, mine["labels"])


if __name__ == "__main__":
    unittest.main()
