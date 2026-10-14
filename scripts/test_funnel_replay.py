#!/usr/bin/env python3
"""funnel_replay: forks come from recorded events or the backend's own rules, never invented."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import funnel_replay as fr  # noqa: E402


def replay(utterances, events):
    return dict(utterances=utterances, events=events)


def utt(uid, text, end=1000):
    return dict(id=uid, text=text, start_ms=end - 800, end_ms=end, speaker=None)


def tag(uid, value, prob, engine="jev-1.13.0", clause=None, latency=500):
    return dict(kind="tag", id=uid, at_ms=0, latency_ms=latency, error=None, tag=value, prob=prob,
                engine=engine, task_clause=clause)


class FunnelReplayTest(unittest.TestCase):
    def forks(self, utterances, events):
        return fr.build(replay(utterances, events), "t", "example")["sentences"]

    def test_filler_stops_in_code_without_a_model_call(self):
        [s] = self.forks([utt("u1", "嗯。")], [tag("u1", "chitchat", .9)])
        self.assertEqual("code", s["route"])
        self.assertEqual([("code", True)], [(f["layer"], f["settled"]) for f in s["forks"]])
        self.assertEqual("语气词，隐藏", s["outcome"])

    def test_confident_jev_answer_settles_and_keeps_its_probability(self):
        [s] = self.forks([utt("u1", "我们就定了，先做安卓。")], [tag("u1", "decision", .97)])
        jev = [f for f in s["forks"] if f["q"] == "这句话是什么？"][0]
        self.assertEqual((0.97, True, 500), (jev["p"], jev["settled"], jev["ms"]))
        self.assertEqual("jev", s["route"])

    def test_low_probability_is_reported_as_uncertain(self):
        [s] = self.forks([utt("u1", "这个嘛我也说不好")], [tag("u1", "uncertain", .41)])
        self.assertIn("说不准", s["forks"][1]["a"])
        self.assertFalse(s["forks"][1]["settled"])

    def test_clause_upgrade_keeps_unknown_first_probability_null(self):
        text = "那今天就到这，周五再对一下进度。"
        events = [tag("u1", "commitment", .78, "jev-1.13.0+clauses", "周五再对一下进度。"),
                  dict(kind="task", id="u1", at_ms=0, latency_ms=900, error=None,
                       tasks=[dict(is_task=True, what="周五对进度", owner_role="unknown", owner_name=None, due_raw="周五")])]
        [s] = self.forks([utt("u1", text)], events)
        whole, clause = s["forks"][1], s["forks"][2]
        self.assertIsNone(whole["p"])
        self.assertEqual(0.78, clause["p"])
        self.assertEqual("you", s["route"])
        self.assertTrue(any("选负责人" in f["a"] for f in s["forks"] if f["layer"] == "you"))
        self.assertEqual("待办，等你确认", s["outcome"])

    def test_quality_veto_comes_from_item_quality_and_blocks_the_task(self):
        events = [tag("u1", "commitment", .87), dict(kind="task", id="u1", at_ms=0, latency_ms=900, error=None,
                                                    tasks=[dict(is_task=True, what="弄", owner_role="speaker")])]
        [s] = self.forks([utt("u1", "我不用再发报告了。")], events)
        veto = [f for f in s["forks"] if f["q"] == "这个待办站得住吗？"][0]
        self.assertTrue(veto["a"].startswith("否决"))
        self.assertEqual("uncertain", s["tag"])
        self.assertFalse(any(f["layer"] == "model" for f in s["forks"]))
        self.assertEqual("待办被规则否决", s["outcome"])

    def test_question_shape_then_deepseek_outcome(self):
        events = [tag("u1", "idea", .6), dict(kind="question", id="u1", at_ms=0, status="research", final="release",
                                              how="search", value=3, same_as=None, question="月费多少？")]
        [s] = self.forks([utt("u1", "同类App一个月大概多少钱？")], events)
        layers = [f["layer"] for f in s["forks"]]
        self.assertIn("model", layers)
        self.assertEqual("you", layers[-1])
        self.assertEqual("查到答案，推给你", s["outcome"])

    def test_lens_counts_rules_against_jev(self):
        data = fr.build(replay([utt("u1", "那我周五前把新方案发你"), utt("u2", "随便聊聊", 3000)],
                               [tag("u1", "commitment", .98), tag("u2", "chitchat", .9)]), "t", "example")
        self.assertEqual((1, 1, 0), (data["lens"]["rules_decided"], data["lens"]["agree"], data["lens"]["disagree"]))

    def test_example_output_is_labelled_and_reproducible(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "s.json")
            fr.main(["--example", "-o", out])
            with open(out, encoding="utf-8") as stream:
                data = json.load(stream)
            with open(fr.SAMPLE_OUT, encoding="utf-8") as stream:
                committed = json.load(stream)
        self.assertEqual("example", data["source"]["kind"])
        self.assertEqual(committed, data, "public/funnel-sample.json is stale: run scripts/funnel_replay.py --example")


if __name__ == "__main__":
    unittest.main()
