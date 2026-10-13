#!/usr/bin/env python3
"""Voting over several minutes runs: what most runs agree on stays, one-off items go."""
import unittest

import minutes_vote as mv


def run(decisions=(), actions=(), topics=(("产品", ["要点"]),), questions=()):
    return dict(version=3, substantive=True, overview="o", follow_ups=[],
                decisions=[dict(text=t, ids=ids) for t, ids in decisions],
                actions=[dict(owner=o, task=t, due="", ids=ids) for o, t, ids in actions],
                topics=[dict(topic=t, points=p) for t, p in topics],
                open_questions=[dict(question=q, quote="", id=i) for q, i in questions])


class VoteTest(unittest.TestCase):
    def test_items_most_runs_agree_on_stay(self):
        runs = [run(decisions=[("先做 App", ["u5"])], actions=[("", "列出 P0 功能", ["u9"]), ("", "订酒店", ["u2"])]),
                run(decisions=[("先把 App 做出来", ["u5", "u6"])], actions=[("林春源", "列出 P0 功能点", ["u9"])]),
                run(decisions=[], actions=[("", "列 P0 页面", ["u9", "u10"])])]
        out = mv.vote(runs)
        self.assertEqual([["u5", "u6"]], [d["ids"] for d in out["decisions"]])  # 2 of 3 runs, evidence pooled
        self.assertEqual(1, len(out["actions"]))  # 订酒店 appeared once only
        self.assertEqual("林春源", out["actions"][0]["owner"])  # an owner one agreeing run named is kept
        self.assertEqual(["u9", "u10"], out["actions"][0]["ids"])

    def test_same_wording_without_shared_evidence_still_matches(self):
        a = dict(text="MVP 先聚焦最简单的会议场景", ids=["u1"])
        b = dict(text="MVP 先聚焦最简单的会议场景，权责以后再说", ids=["u3"])
        self.assertTrue(mv.same_item(a, b, "text"))
        self.assertFalse(mv.same_item(a, dict(text="酒店住宿申请", ids=["u8"]), "text"))

    def test_nothing_agreed_means_not_substantive(self):
        runs = [run(topics=()), dict(run(topics=()), substantive=False), dict(run(topics=()), substantive=False)]
        out = mv.vote(runs)
        self.assertFalse(out["substantive"])
        self.assertEqual("", out["overview"])
        self.assertIsNone(mv.vote([]))
        self.assertEqual(runs[0], mv.vote(runs[:1]))


if __name__ == "__main__":
    unittest.main()
