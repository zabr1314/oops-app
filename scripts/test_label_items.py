#!/usr/bin/env python3
"""Whole-meeting items: strict evidence, blind exclusion, budgeted generation and per-person review."""
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid
import wave
from http.server import ThreadingHTTPServer

import label_items as li
import team_label as tl

ROWS = [dict(id=f"u{i}-1", parent=f"u{i}", text=t, start_ms=i * 4000, end_ms=i * 4000 + 3000) for i, t in enumerate([
    "大家好。", "酒店按个人申请。", "我去问一下对接人是不是两人一间。", "这个是盲测的句子。",
    "那就先把 App 跑通。", "硬件是附加项。", "比赛前要做好。", "哈哈哈。"], start=1)]
BLIND = ["u4-1"]
SECRET = "items-test-only-" + "s" * 32


class Fake:
    model = "fake-model"

    def __init__(self, raw, usage=None, fail=None):
        self.raw, self.usage, self.fail, self.calls = raw, usage or {"prompt_tokens": 100, "completion_tokens": 50}, fail, []

    def complete(self, user, max_tokens, timeout):
        self.calls.append(user)
        if self.fail:
            raise li.ModelFailure(self.fail)
        return self.raw, self.model, self.usage


RAW = {"items": [
    {"kind": "task", "title": "问对接人是否两人一间", "detail": "酒店按个人申请", "due": "", "claimed": True,
     "evidence": [{"from": "u2-1", "to": "u3-1"}]},
    {"kind": "decision", "title": "先把 App 跑通，硬件是附加项", "detail": "", "due": "比赛前",
     "evidence": [{"from": "u5-1", "to": "u7-1"}, {"from": "u6-1", "to": "u6-1"}]},
    {"kind": "task", "title": "编造的事项", "evidence": [{"from": "u99-1", "to": "u99-2"}]},
    {"kind": "wish", "title": "未知类别", "evidence": [{"from": "u1-1", "to": "u1-1"}]},
]}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = self.temp.name
        folder = os.path.join(self.folder, "meetings", "0235")
        os.makedirs(folder)
        with open(os.path.join(folder, "meeting.json"), "w", encoding="utf-8") as f:
            json.dump(dict(id="0235", title="测试会", utterances=ROWS), f, ensure_ascii=False)
        with wave.open(os.path.join(folder, "audio.wav"), "wb") as w:
            w.setnchannels(1), w.setsampwidth(2), w.setframerate(16000), w.writeframes(b"\0\0" * 16000 * 40)
        self.data = tl.Data(self.folder)
        self.meetings = {"0235": (ROWS, BLIND, "测试会")}

    def generate(self, model, budget=1.0):
        quote = li.quote(self.meetings, model.model, 2, 8, max_tokens=1000)
        return quote, li.generate(self.folder, self.meetings, quote, budget, quote["quote_hash"], model)

    def payload(self, name=tl.PEOPLE[0]):
        return li.items_payload(tl.Data(self.folder), "0235", name)

    def act(self, name=tl.PEOPLE[0], **body):
        data = tl.Data(self.folder)
        revision = li.items_payload(data, "0235", name)["revision"]
        return li.review_items(data, "0235", name, dict(request_id=uuid.uuid4().hex, revision=revision, **body))


class RequestAndParse(unittest.TestCase):
    def test_blind_rows_never_reach_the_model_and_gaps_are_announced(self):
        request = li.build_request(ROWS, BLIND, "测试会")
        self.assertNotIn("盲测", request["user"])
        self.assertNotIn("u4-1", request["ids"])
        self.assertIn("原话未提供", request["user"])

    def test_only_evidenced_items_survive_and_spans_merge(self):
        request = li.build_request(ROWS, BLIND)
        items, dropped = li.parse_items(RAW, ROWS, request)
        self.assertEqual([i["kind"] for i in items], ["task", "decision"])
        self.assertEqual(dropped, 2)
        self.assertEqual(items[0]["evidence"], [["u2-1", "u3-1"]])
        self.assertEqual(items[1]["evidence"], [["u5-1", "u6-1", "u7-1"]])
        self.assertTrue(items[0]["claimed"])

    def test_span_across_blind_gap_skips_reserved_rows(self):
        request = li.build_request(ROWS, BLIND)
        items, _ = li.parse_items({"items": [{"kind": "open", "title": "跨过盲测", "evidence": [{"from": "u3-1", "to": "u5-1"}]}]},
                                  ROWS, request)
        self.assertEqual(items[0]["evidence"], [["u3-1", "u5-1"]])

    def test_overlong_span_is_dropped(self):
        rows = [dict(r, end_ms=r["start_ms"] + 200_000) for r in ROWS]
        request = li.build_request(rows, [])
        items, dropped = li.parse_items({"items": [{"kind": "task", "title": "太长", "evidence": [{"from": "u1-1", "to": "u2-1"}]}]},
                                        rows, request)
        self.assertEqual((items, dropped), ([], 1))


class Generation(Fixture):
    def test_budget_and_hash_guard(self):
        model = Fake(RAW)
        quote = li.quote(self.meetings, model.model, 2, 8, max_tokens=1000)
        with self.assertRaises(ValueError):
            li.generate(self.folder, self.meetings, quote, quote["upper_cny"] / 2, quote["quote_hash"], model)
        with self.assertRaises(ValueError):
            li.generate(self.folder, self.meetings, quote, 1, "0" * 64, model)
        self.assertEqual(model.calls, [])

    def test_generate_once_then_skip(self):
        model = Fake(RAW)
        quote, result = self.generate(model)
        self.assertEqual(result["0235"]["items"], 2)
        again = li.generate(self.folder, self.meetings, quote, 1, quote["quote_hash"], model)
        self.assertEqual(again["0235"]["skipped"], "already_attempted")
        self.assertEqual(len(model.calls), 1)

    def test_failure_reserves_cost_and_retry_needs_its_own_quote(self):
        _, result = self.generate(Fake(RAW, fail="transport_failed"))
        self.assertEqual(result["0235"]["status"], "failed")
        retry = li.quote(self.meetings, "fake-model", 2, 8, 1000, retry_folder=self.folder)
        self.assertEqual(retry["mode"], "retry")
        ok = Fake(RAW)
        result = li.generate(self.folder, self.meetings, retry, 1, retry["quote_hash"], ok)
        self.assertEqual(result["0235"]["status"], "ready")
        with open(li.items_path(self.folder, "0235"), encoding="utf-8") as f:
            self.assertEqual(len(json.load(f)["attempts"]), 2)
        self.assertEqual(li.generate(self.folder, self.meetings, retry, 1, retry["quote_hash"], ok)["0235"]["skipped"],
                         "not_in_quoted_retry_state")

    def test_changed_source_fails_closed(self):
        self.generate(Fake(RAW))
        meeting = os.path.join(self.folder, "meetings", "0235", "meeting.json")
        changed = [dict(r, text=r["text"] + "改") if r["id"] == "u2-1" else r for r in ROWS]
        with open(meeting, "w", encoding="utf-8") as f:
            json.dump(dict(id="0235", title="测试会", utterances=changed), f, ensure_ascii=False)
        self.assertEqual(self.payload()["status"], "stale")
        self.assertEqual(self.payload()["items"], [])


class Review(Fixture):
    def setUp(self):
        super().setUp()
        # Blind ids come from the sentence workbench sidecar in production; patch for the fixture.
        self._blind = li.blind_ids
        li.blind_ids = lambda folder, mid, rows: list(BLIND)
        self.addCleanup(setattr, li, "blind_ids", self._blind)
        self.generate(Fake(RAW))

    def test_task_needs_owner_and_reviews_are_per_person(self):
        task = self.payload()["items"][0]
        with self.assertRaises(ValueError):
            self.act(action="confirm", item=task["id"], fingerprint=task["fingerprint"])
        done = self.act(action="confirm", item=task["id"], fingerprint=task["fingerprint"], owner=tl.PEOPLE[1],
                        title="问对接人：是否两人一间")
        self.assertEqual(done["counts"]["confirmed"], 1)
        self.assertTrue(done["items"][0]["review"]["edited"])
        self.assertEqual(self.payload(tl.PEOPLE[1])["counts"]["todo"], 2)

    def test_reject_merge_add_undo(self):
        a, b = self.payload()["items"]
        self.act(action="reject", item=a["id"], fingerprint=a["fingerprint"])
        self.act(action="merge", item=b["id"], fingerprint=b["fingerprint"], into=a["id"])
        with self.assertRaises(ValueError):
            self.act(action="merge", item=b["id"], fingerprint=b["fingerprint"], into=b["id"])
        with self.assertRaises(ValueError):
            self.act(action="add", kind="task", title="补的事", owner=tl.PEOPLE[0], ids=["u4-1"])  # blind row
        added = self.act(action="add", kind="task", title="报销准备发票", owner=tl.PEOPLE[0], ids=["u8-1", "u2-1"])
        self.assertEqual(added["counts"], dict(todo=0, confirmed=1, rejected=2))
        human = next(i for i in added["items"] if i["source"] == "human")
        self.assertEqual([s["ids"] for s in human["evidence"]], [["u2-1"], ["u8-1"]])
        self.assertEqual(self.act(action="undo")["counts"]["confirmed"], 0)
        self.assertEqual(self.act(action="reopen", item=a["id"], fingerprint=a["fingerprint"])["counts"]["todo"], 1)

    def test_stale_fingerprint_conflicts(self):
        a = self.payload()["items"][0]
        with self.assertRaises(tl.RevisionConflict):
            self.act(action="reject", item=a["id"], fingerprint="0" * 64)

    def test_idempotent_request(self):
        a = self.payload()["items"][0]
        data = tl.Data(self.folder)
        body = dict(request_id="same-request-1", revision=0, action="reject", item=a["id"], fingerprint=a["fingerprint"])
        first = li.review_items(data, "0235", tl.PEOPLE[0], body)
        second = li.review_items(tl.Data(self.folder), "0235", tl.PEOPLE[0], body)
        self.assertEqual(first["revision"], second["revision"])

    def test_http_routes_and_clip_until(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), tl.make_handler(tl.Data(self.folder), SECRET))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        base, key = f"http://127.0.0.1:{server.server_port}", tl.make_key(SECRET, tl.PEOPLE[0])
        def call(path, body=None):
            req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body else None,
                                         headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.read()
        doc = json.loads(call("/api/meeting/0235/items"))
        self.assertEqual(len(doc["items"]), 2)
        item = doc["items"][1]
        out = json.loads(call("/api/meeting/0235/items/review", dict(request_id=uuid.uuid4().hex, revision=0,
                              action="confirm", item=item["id"], fingerprint=item["fingerprint"])))
        self.assertEqual(out["counts"]["confirmed"], 1)
        with wave.open(io.BytesIO(call(f"/clip/0235/u5-1.wav?pad=0&until=u7-1&k={key}"))) as w:
            self.assertAlmostEqual(w.getnframes() / 16000, 11.0, delta=0.1)
        with self.assertRaises(urllib.error.HTTPError) as bad:
            call(f"/clip/0235/u7-1.wav?until=u5-1&k={key}")
        self.assertEqual(bad.exception.code, 400)


class OpenAccess(Fixture):
    def serve(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), tl.make_handler(tl.Data(self.folder), SECRET))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        return f"http://127.0.0.1:{server.server_port}"

    def get(self, base, path, who=None):
        headers = {"X-Labeler": urllib.request.quote(who)} if who else {}
        with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=5) as r:
            return r.status, json.loads(r.read()), r.headers.get("X-Robots-Tag")

    def test_plain_address_needs_marker(self):
        base = self.serve()
        with self.assertRaises(urllib.error.HTTPError) as closed:
            self.get(base, "/api/me")
        self.assertEqual(closed.exception.code, 401)

    def test_marker_opens_team_picker_and_named_writes(self):
        open(os.path.join(self.folder, tl.OPEN_MARKER), "w").close()
        base = self.serve()
        status, me, robots = self.get(base, "/api/me")
        self.assertEqual((status, me["name"], robots), (200, None, "noindex, nofollow"))
        self.assertEqual(self.get(base, "/api/me", tl.PEOPLE[2])[1]["name"], tl.PEOPLE[2])
        req = urllib.request.Request(base + "/api/meeting/0235/items/review", data=b"{}", headers={"Content-Type": "application/json"})
        with self.assertRaises(urllib.error.HTTPError) as anonymous:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(anonymous.exception.code, 401)  # writes still need a picked name


if __name__ == "__main__":
    unittest.main()
