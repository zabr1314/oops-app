#!/usr/bin/env python3
"""Question rules without a model: which questions get a search, a quick answer, or nothing."""
import unittest

import question_watch as qw


def q(kind="external", how="search", value=3, same_as=None):
    return dict(kind=kind, how=how, value=value, same_as=same_as, question="q")


class PlanTest(unittest.TestCase):
    def test_pressing_searches_start_at_once_and_repeats_or_examples_never_do(self):
        plan = qw.Plan()
        self.assertEqual("research", plan.on_detect(q()))
        self.assertEqual("repeat", plan.on_detect(q(same_as="u1")))
        self.assertEqual("skip", plan.on_detect(q(kind="rhetorical")))
        self.assertEqual("skip", plan.on_detect(q(value=1)))
        self.assertEqual("wait", plan.on_detect(q(value=2)))
        self.assertEqual("wait", plan.on_detect(q(how="quick")))

    def test_after_the_wait_answered_questions_are_left_alone(self):
        plan = qw.Plan()
        self.assertEqual("release", plan.on_answered(q(), "research", False))
        self.assertEqual("answered", plan.on_answered(q(), "research", True))
        self.assertEqual("answered", plan.on_answered(q(value=2), "wait", True))
        self.assertEqual("research_late", plan.on_answered(q(value=2), "wait", False))
        self.assertEqual("quick", plan.on_answered(q(how="quick", value=2), "wait", False))

    def test_budgets_keep_the_last_search_for_a_pressing_question(self):
        plan = qw.Plan(research_used=4, research_limit=5)
        self.assertEqual("quick", plan.on_answered(q(value=2), "wait", False))  # the last search is reserved
        self.assertEqual("research", plan.on_detect(q(value=3)))
        self.assertEqual("wait", plan.on_detect(q(value=3)))  # none left: it waits and may get a quick answer
        full = qw.Plan(research_used=5, quick_used=8)
        self.assertEqual("over_budget", full.on_answered(q(value=2), "wait", False))


class HelpersTest(unittest.TestCase):
    def test_ids_from_the_model_in_any_shape(self):
        known = [{"id": "u43"}, {"id": "u7"}]
        for value, expected in ((43, "u43"), ("43", "u43"), ("u7", "u7"), (None, None), (True, None), ("u99", None)):
            self.assertEqual(expected, qw.match_id(value, known))

    def test_question_shape_and_similarity(self):
        self.assertTrue(qw.looks_like_question("这个板子大概多少钱"))
        self.assertFalse(qw.looks_like_question("好的我们继续"))
        self.assertTrue(qw.similar("市面上有没有现成的声纹识别方案", "市面上有没有现成的声纹识别产品"))
        self.assertFalse(qw.similar("声纹识别方案", "开发板价格"))

    def test_silence_after_a_question_means_nobody_answered(self):
        rows = [dict(id="u1", text="多少钱？", start_ms=0, end_ms=2000), dict(id="u2", text="嗯", start_ms=200_000, end_ms=201_000)]
        self.assertFalse(qw.answered(None, rows, 0, "多少钱"))  # no model call needed


if __name__ == "__main__":
    unittest.main()
