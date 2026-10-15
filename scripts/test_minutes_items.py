#!/usr/bin/env python3
"""After a meeting people check minutes items (to do / decided / open), not sentences; checks never stale the minutes."""
import tempfile
import unittest

import minutes_items
import minutes_vote
from meeting_features import Meetings

TEAM = ("林春源", "洪玉麟", "江古月", "黄丽萍")
ROWS = [dict(id=f"u{i}", text=t, start_ms=i * 1000, end_ms=i * 1000 + 900, tag=None, speaker=None) for i, t in enumerate([
    "大家好", "酒店按个人申请", "我去问一下对接人是不是两人一间", "那就先把 App 跑通", "硬件是附加项",
    "固定设备要不要和录音豆结合", "我觉得不用结合"], start=1)]
ANALYSIS = dict(
    actions=[dict(task="问对接人是否两人一间", owner="", due="", priority="other", ids=["u2", "u3"]),
             dict(task="比赛前完成 App", owner="洪玉麟", due="比赛前", priority="main", ids=["u4"])],
    decisions=[dict(text="P0 先把 App 跑通，硬件是附加项", ids=["u4", "u5"])],
    undecided=[dict(topic="固定设备是否要和录音豆结合？", views="一方要结合，一方认为冲突", ids=["u6", "u7"])],
    open_questions=[dict(question="组委会是否报销外地选手机票", quote="", id="u2")])


class Build(unittest.TestCase):
    def test_kinds_order_and_stable_ids(self):
        items = minutes_items.build(ANALYSIS)
        self.assertEqual([i["kind"] for i in items], ["task", "task", "decision", "open", "open"])
        self.assertEqual(items[0]["title"], "比赛前完成 App")  # main line first
        self.assertEqual(items[0]["owner_hint"], "洪玉麟")
        self.assertEqual([i["id"] for i in items], [i["id"] for i in minutes_items.build(ANALYSIS)])
        self.assertEqual(minutes_items.build(dict(actions=[dict(task="没有依据", ids=[])])), [])

    def test_vote_keeps_undecided_with_quorum_and_old_runs_without_it(self):
        base = dict(substantive=True, theme="", overview="x", decisions=[], actions=[], topics=[], open_questions=[], follow_ups=[])
        runs = [dict(base, undecided=[dict(topic="固定设备是否要和录音豆结合", ids=["u6"])]),
                dict(base, undecided=[dict(topic="固定设备要不要和录音豆结合", ids=["u6", "u7"])]), dict(base)]
        self.assertEqual(len(minutes_vote.vote(runs)["undecided"]), 1)


class Flow(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = dict(analysis=ANALYSIS, invalidated=False)
        self.meetings = Meetings(self.temp.name, team=TEAM, cited=lambda sid: dict(
            items=minutes_items.build(self.state["analysis"]), invalidated=self.state["invalidated"],
            tasks=set(), decisions=set(), theme=None))
        self.meetings.sync({"session_id": "m1", "started_at": "2026-10-12T09:00:00+08:00", "time_zone": "Asia/Shanghai",
                            "utterances": ROWS})

    def act(self, **req):
        wanted = req.pop("item_id")
        item = next(i for i in self.meetings.load("m1")["items"] if i["id"] == wanted)
        return self.meetings.review_item(dict(session_id="m1", item_id=item["id"], fingerprint=item["fingerprint"], by="林春源", **req))

    def test_queue_is_items_not_sentences_and_listing_counts_kinds(self):
        row = self.meetings.load("m1")
        self.assertEqual({q["kind"] for q in row["review_queue"]}, {"item"})
        self.assertEqual(len(row["review_queue"]), 5)
        self.assertEqual(row["items"][2]["evidence"][0]["text"], "那就先把 App 跑通")
        pending = self.meetings.listing()["items"][0]["review_pending"]
        self.assertEqual(pending, dict(task=2, decision=1, open=2))

    def test_task_needs_owner_then_leaves_the_queue_without_touching_sentence_reviews(self):
        task = self.meetings.load("m1")["items"][1]
        with self.assertRaises(ValueError):
            self.act(item_id=task["id"], action="confirm")
        with self.assertRaises(ValueError):
            self.act(item_id=task["id"], action="confirm", owner="路人")
        out = self.act(item_id=task["id"], action="confirm", owner="黄丽萍", title="问对接人：是否两人一间")
        saved = next(i for i in out["items"] if i["id"] == task["id"])["review"]
        self.assertEqual((saved["status"], saved["owner"], saved["edited"]), ("confirmed", "黄丽萍", True))
        self.assertEqual(len(out["review_queue"]), 4)
        self.assertFalse(any(u.get("review") for u in self.meetings.load("m1")["utterances"]))
        self.act(item_id=task["id"], action="confirm", owner="大家")  # collective owner is allowed

    def test_reject_merge_reopen(self):
        items = self.meetings.load("m1")["items"]
        self.act(item_id=items[3]["id"], action="merge", into=items[2]["id"])
        self.act(item_id=items[4]["id"], action="reject")
        with self.assertRaises(ValueError):
            self.act(item_id=items[0]["id"], action="merge", into=items[0]["id"])
        self.assertEqual(len(self.meetings.load("m1")["review_queue"]), 3)
        out = self.act(item_id=items[4]["id"], action="reopen")
        self.assertEqual(len(out["review_queue"]), 4)

    def test_changed_item_conflicts_and_stale_minutes_are_read_only(self):
        item = self.meetings.load("m1")["items"][2]
        with self.assertRaises(minutes_items.ItemChanged):
            self.meetings.review_item(dict(session_id="m1", item_id=item["id"], fingerprint="x" * 64, action="reject"))
        self.state["invalidated"] = True
        row = self.meetings.load("m1")
        self.assertTrue(all(i["stale"] for i in row["items"]))
        self.assertEqual(row["review_queue"], [])
        with self.assertRaises(ValueError):
            self.act(item_id=item["id"], action="reject")

    def test_minutes_current_callback_marks_items_stale(self):
        self.meetings.minutes_current = lambda row: False
        self.assertTrue(all(i["stale"] for i in self.meetings.load("m1")["items"]))

    def test_review_from_an_old_item_does_not_carry_over_to_a_new_wording(self):
        task = self.meetings.load("m1")["items"][1]
        self.act(item_id=task["id"], action="reject")
        self.state["analysis"] = dict(ANALYSIS, actions=[dict(ANALYSIS["actions"][0], task="问清酒店是否两人一间")])
        self.assertTrue(all(i["review"] is None for i in self.meetings.load("m1")["items"] if i["kind"] == "task"))

    def test_without_minutes_the_old_sentence_queue_remains(self):
        meetings = Meetings(self.temp.name, team=TEAM, cited=lambda sid: None)
        row = meetings.load("m1")
        self.assertNotIn("items", row)


if __name__ == "__main__":
    unittest.main()
