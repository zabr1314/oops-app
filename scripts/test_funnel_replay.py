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
        [s] = self.forks([utt("u1", "嗯。")], [])
        self.assertEqual("code", s["route"])
        self.assertEqual([("code", True)], [(f["layer"], f["settled"]) for f in s["forks"]])
        self.assertEqual("语气词，隐藏", s["outcome"])

    def test_confident_jev_answer_keeps_probability_without_inventing_an_auto_stop(self):
        [s] = self.forks([utt("u1", "我们就定了，先做安卓。")], [tag("u1", "decision", .97)])
        jev = [f for f in s["forks"] if f["q"] == "这句话的分类记录"][0]
        self.assertEqual((0.97, False, 500), (jev["p"], jev["settled"], jev["ms"]))
        self.assertEqual("jev", s["route"])

    def test_low_probability_is_reported_as_uncertain(self):
        [s] = self.forks([utt("u1", "这个嘛我也说不好")], [tag("u1", "uncertain", .41)])
        self.assertIn("说不准", s["forks"][1]["a"])
        self.assertFalse(s["forks"][1]["settled"])

    def test_clause_upgrade_does_not_invent_unrecorded_first_answer(self):
        text = "那今天就到这，周五再对一下进度。"
        events = [tag("u1", "commitment", .78, "jev-1.13.0+clauses", "周五再对一下进度。"),
                  dict(kind="task", id="u1", at_ms=0, latency_ms=900, error=None,
                       tasks=[dict(is_task=True, what="周五对进度", owner_role="unknown", owner_name=None, due_raw="周五")])]
        [s] = self.forks([utt("u1", text)], events)
        recorded = [f for f in s["forks"] if f["layer"] == "jev"]
        self.assertEqual(1, len(recorded))
        self.assertEqual(0.78, recorded[0]["p"])
        self.assertIn("周五再对一下进度", recorded[0]["a"])
        self.assertEqual("you", s["route"])
        self.assertTrue(any("选负责人" in f["a"] for f in s["forks"] if f["layer"] == "you"))
        self.assertEqual("待办，等你确认", s["outcome"])

    def test_current_quality_comparison_does_not_rewrite_historical_tag_or_task(self):
        events = [tag("u1", "commitment", .87), dict(kind="task", id="u1", at_ms=0, latency_ms=900, error=None,
                                                    tasks=[dict(is_task=True, what="弄", owner_role="speaker")])]
        [s] = self.forks([utt("u1", "我不用再发报告了。")], events)
        veto = [f for f in s["forks"] if f["q"] == "当前规则：待办依据够吗？"][0]
        self.assertTrue(veto["a"].startswith("当前规则提示"))
        self.assertEqual("recomputed", veto["provenance"])
        self.assertEqual("commitment", s["tag"])
        self.assertTrue(any(f["layer"] == "model" for f in s["forks"]))

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

    def test_post_meeting_items_are_checked_and_queued_by_backend_code(self):
        minutes = dict(kind="minutes", at_ms=9000, latency_ms=4200, error=None, minutes=dict(
            overview="定了方案", decisions=[dict(text="先做安卓", ids=["u2"])],
            actions=[dict(task="周五前把方案发给春源", owner="玉麟", due="周五前", ids=["u1"])],
            open_questions=[dict(question="预算够吗？", id="u9")]))
        data = fr.build(replay([utt("u1", "那我周五前把方案发你"), utt("u2", "我们就定了，先做安卓", 3000)],
                               [tag("u1", "commitment", .98), tag("u2", "decision", .96), minutes]), "t", "example")
        post = data["post"]
        self.assertEqual(4200, post["latency_ms"])
        self.assertEqual(["task", "decision"], [i["kind"] for i in post["items"]])  # u9 is not in the transcript
        self.assertTrue(all(i["quality"]["label"] in ("通过", "待人核对", "否决") for i in post["items"]))
        self.assertEqual([("task", ["u1"]), ("decision", ["u2"])], [(q["item_kind"], q["ids"]) for q in post["queue"]][:2])
        self.assertIsNone(post["generation"]["recorded_calls"])
        self.assertEqual(3, post["generation"]["configured_runs"])

    def test_no_minutes_means_no_post_section(self):
        data = fr.build(replay([utt("u1", "好的")], [tag("u1", "chitchat", .9)]), "t", "example")
        self.assertIsNone(data["post"])

    def test_missing_event_does_not_invent_jev_negative_clause_or_historical_fallback(self):
        [sentence] = fr.build(replay([utt("u", "周五把报告发我")], []), "t", "replay")["sentences"]
        self.assertEqual("unknown", sentence["route"])
        self.assertTrue(all(f["provenance"] == "recomputed" for f in sentence["forks"]))
        self.assertIsNone(sentence["tag"])

    def test_stored_final_tag_is_not_presented_as_a_jev_trace(self):
        row = dict(session_id="s", utterances=[dict(utt("u", "周五把报告发我"), tag="commitment")])
        data = fr.build_stored(row, dict(status="pending", reason="writing"))
        [sentence] = data["sentences"]
        self.assertEqual(("unknown", "stored", []), (sentence["route"], sentence["tag_provenance"], sentence["forks"]))
        self.assertEqual("pending", data["post_status"]["status"])
        self.assertIsNone(data["post"])
        self.assertNotIn("settle", data["thresholds"])

    def test_stored_and_reanalysis_titles_use_existing_theme_without_renaming_source(self):
        row = dict(session_id="s", agenda=dict(goal="原议程"), utterances=[utt("u", "我们先核对方案")])
        view = dict(status="ready", minutes=dict(theme="已有纪要主题", actions=[], decisions=[]))
        self.assertEqual("已有纪要主题", fr.build_stored(row, view)["source"]["label"])
        record = dict(run_id="run1", source_session_id="s", status="complete", events=[], raw_calls=[])
        self.assertEqual("重新分析 · 已有纪要主题", fr.build_reanalysis(record, row, view)["source"]["label"])
        self.assertNotIn("title", row)
        self.assertNotIn("display_title", row)
        self.assertEqual("原议程", fr.build_stored(row, dict(status="pending"))["source"]["label"])
        named = dict(row, title="手工会议名称")
        self.assertEqual("手工会议名称", fr.build_stored(named, view)["source"]["label"])
        self.assertEqual("显示名称", fr.build_stored(dict(named, display_title="显示名称"), view)["source"]["label"])

    def test_stored_trace_keeps_exact_recorded_probability_and_excludes_unvalidated_context(self):
        row = dict(session_id="s", utterances=[utt("u", "周五把报告发我")])
        trace = dict(kind="tag", id="u", recorded_at="2026-10-14T00:00:00Z", context=["old private text"],
                     result=dict(tag="commitment", prob=.96, engine="jev-old", timing_ms=dict(jev_ms=734)))
        data = fr.build_stored(row, dict(status="unavailable"), [trace])
        [fork] = data["sentences"][0]["forks"]
        self.assertEqual((.96, "jev-old", 734, "recorded"), (fork["p"], fork["engine"], fork["ms"], fork["provenance"]))
        self.assertEqual([], fork["context"])
        self.assertEqual("2026-10-14T00:00:00Z", fork["recorded_at"])

    def test_trace_without_an_engine_is_not_claimed_as_jev(self):
        row = dict(session_id="s", utterances=[utt("u", "我们先做安卓")])
        trace = dict(kind="tag", id="u", result=dict(tag="decision", prob=.99))
        sentence = fr.build_stored(row, dict(status="pending"), [trace])["sentences"][0]
        self.assertEqual("unknown", sentence["route"])
        self.assertEqual("unknown", sentence["forks"][0]["layer"])
        self.assertEqual(.99, sentence["forks"][0]["p"])

    def test_recorded_intermediate_stages_are_not_replaced_by_final_clause_upgrade(self):
        row = dict(session_id="s", utterances=[utt("u", "我们先停，周五再对进度")])
        trace = dict(kind="tag", id="u", result=dict(tag="commitment", prob=.94, engine="jev-1+clauses"),
                     stages=[dict(kind="whole_tag", layer="jev", status="ok", latency_ms=401,
                                  result=dict(tag="idea", prob=.82, engine="jev-1")),
                             dict(kind="task_clauses", layer="jev", status="ok", selected="周五再对进度", threshold=.7,
                                  clauses=[dict(text="周五再对进度", yes_prob=.94)], latency_ms=502)])
        sentence = fr.build_stored(row, dict(status="pending"), [trace])["sentences"][0]
        self.assertEqual([.82, .94], [f["p"] for f in sentence["forks"]])
        self.assertEqual([401, 502], [f["ms"] for f in sentence["forks"]])
        self.assertEqual("想法", sentence["forks"][0]["a"])
        self.assertEqual("commitment", sentence["tag"])

    def test_stored_minutes_generation_evidence_is_preserved_and_queue_uses_items(self):
        row = dict(session_id="s", utterances=[utt("u", "我们定了先做安卓")])
        generation = dict(recorded_calls=2, configured_runs=2, mode="majority_vote", evidence="recorded")
        view = dict(status="ready", generation=generation, minutes=dict(decisions=[dict(text="先做安卓", ids=["u"])]))
        data = fr.build_stored(row, view)
        self.assertEqual(generation, data["post"]["generation"])
        self.assertEqual("item", data["post"]["queue"][0]["kind"])
        self.assertEqual(["u"], data["post"]["queue"][0]["ids"])

    def test_delivery_summary_keeps_only_safe_typed_receipt_flags(self):
        row = dict(session_id="s", utterances=[utt("u", "我们定了先做安卓")])
        delivery = dict(document_created=True, sent_receipts=2, ledger_written=None, done=False,
                        doc_url="private-document", recipients=["private-person"])
        view = dict(status="ready", delivery_record=delivery,
                    minutes=dict(decisions=[dict(text="先做安卓", ids=["u"])]))
        post = fr.build_stored(row, view)["post"]
        self.assertEqual(dict(document_created=True, sent_receipts=2, ledger_written=None, done=False),
                         post["delivery_record"])
        self.assertNotIn("private-document", json.dumps(post))
        self.assertNotIn("private-person", json.dumps(post))

    def test_reanalysis_displays_actual_request_options_and_full_probabilities_without_changing_original(self):
        original = dict(session_id="s", utterances=[dict(utt("u", "下周把报告发我"), tag="idea")])
        call = dict(utterance_id="u", stage="whole_tag", attempt=1, latency_ms=712,
                    request=dict(model="jev-latest", headers=dict(Authorization="private-token"),
                                 state=dict(utterance="下周把报告发我", context=["前一句"]),
                                 questions=dict(q=dict(type="choice", instructions="分类", criteria=dict(commitment="明确待办", idea="建议")))),
                    response=dict(model="jev-1.14", answers=dict(q=dict(choice="commitment", probabilities=dict(commitment=.87654321, idea=.12345679)))))
        event = dict(kind="tag", id="u", result=dict(tag="commitment", prob=.87654321, engine="jev-1.14"))
        record = dict(run_id="run1", source_session_id="s", raw_calls=[call], events=[event])
        view = dict(status="ready", minutes=dict(actions=[dict(task="发报告", ids=["u"])]))
        output = fr.build_reanalysis(record, original, view)
        self.assertEqual("reanalysis", output["source"]["kind"])
        self.assertEqual("idea", original["utterances"][0]["tag"])
        [f] = output["sentences"][0]["forks"]
        self.assertEqual(dict(commitment=.87654321, idea=.12345679), f["probabilities"])
        self.assertEqual(["前一句"], f["request"]["state"]["context"])
        self.assertEqual(("jev-latest", "jev-1.14", 712), (f["requested_model"], f["response_model"], f["call_latency_ms"]))
        self.assertNotIn("private-token", json.dumps(output))
        self.assertEqual("reused_history", output["post"]["generation"]["evidence"])
        self.assertIn("没有调用 DeepSeek", output["post"]["note"])

    def test_reanalysis_batched_questions_do_not_multiply_request_latency(self):
        call = dict(stage="task_clauses", latency_ms=500,
                    request=dict(model="jev", questions={k: dict(criteria=dict(yes="是", no="否")) for k in ("c0", "c1")}),
                    response=dict(answers={k: dict(choice="no", probabilities=dict(yes=.2, no=.8)) for k in ("c0", "c1")}))
        forks = fr.reanalysis_call_forks(call, 0)
        self.assertEqual([500, 0], [f["ms"] for f in forks])
        self.assertEqual([500, 500], [f["call_latency_ms"] for f in forks])

    def test_post_handoffs_keep_missing_history_and_recomputed_checks_distinct(self):
        row = dict(session_id="s", utterances=[utt("u", "我们定了先做安卓")])
        view = dict(status="ready", historical_records=dict(query_records=0),
                    generation=dict(evidence="stored", successful_runs=3, configured_runs=3),
                    minutes=dict(decisions=[dict(text="先做安卓", ids=["u"])]))
        output = fr.build_reanalysis(dict(run_id="r", source_session_id="s", events=[], raw_calls=[]), row, view)
        handoffs = output["post"]["handoffs"]
        self.assertEqual(("presentation", "not_recorded", "jev_only"),
                         (handoffs["order"], handoffs["chronology"], handoffs["run_scope"]))
        stages = {stage["id"]: stage for stage in handoffs["stages"]}
        self.assertEqual("reused", stages["minutes"]["provenance"])
        self.assertEqual(3, stages["minutes"]["counts"]["successful_runs"])
        self.assertIsNone(stages["minutes"]["counts"]["recorded_calls"])
        for key in ("evidence", "current_rules"):
            self.assertEqual("recomputed", stages[key]["provenance"])
        for key in ("research", "review", "delivery"):
            self.assertEqual(("missing", "not_recorded", "not_run"),
                             (stages[key]["provenance"], stages[key]["status"], stages[key]["run_scope"]))
        self.assertTrue(all(stage["recorded_at"] is None and stage["latency_ms"] is None
                            for stage in stages.values()))
        self.assertEqual(1, stages["review"]["counts"]["pending"])

    def test_old_delivery_receipt_is_historical_even_when_reused_in_new_jev_run(self):
        post = fr.post_from_minutes(dict(decisions=[dict(text="先做安卓", ids=["u"])]), [utt("u", "我们定了先做安卓")],
            generation=dict(evidence="reused_history", recorded_at="2026-10-08T03:00:00Z", latency_ms=120),
            delivery_record=dict(document_created=True, sent_receipts=2, done=True, recipients=["secret-person"],
                                 doc_url="https://private.invalid/token"))
        stages = {stage["id"]: stage for stage in post["handoffs"]["stages"]}
        self.assertEqual(("recorded", "historical_receipt", "not_run"),
            (stages["delivery"]["provenance"], stages["delivery"]["status"], stages["delivery"]["run_scope"]))
        self.assertEqual(2, stages["delivery"]["counts"]["sent_receipts"])
        self.assertEqual("2026-10-08T03:00:00Z", stages["minutes"]["recorded_at"])
        self.assertEqual(120, stages["minutes"]["latency_ms"])
        self.assertIsNone(stages["delivery"]["recorded_at"])
        for secret in ("secret-person", "private.invalid"):
            self.assertNotIn(secret, json.dumps(post))

    def test_current_human_reviews_are_counted_without_exposing_actor_or_owner(self):
        row = dict(session_id="s", utterances=[utt("u", "我们定了先做安卓")])
        minutes = dict(decisions=[dict(text="先做安卓", ids=["u"])])
        [item] = fr.minutes_items.present(fr.minutes_items.build(minutes), row)
        row["item_reviews"] = {item["id"]: dict(status="confirmed", fingerprint=item["fingerprint"],
              by="secret-reviewer", owner="secret-owner", at="2026-10-08T01:00:00Z")}
        post = fr.post_from_minutes(minutes, row["utterances"], row=row)
        review = next(stage for stage in post["handoffs"]["stages"] if stage["id"] == "review")
        self.assertEqual(("recorded", 1, 0), (review["provenance"], review["counts"]["confirmed"], review["counts"]["pending"]))
        self.assertNotIn("secret-reviewer", json.dumps(post))
        self.assertNotIn("secret-owner", json.dumps(post))
        row["utterances"][0]["text"] = "我们还没定，先核对"
        post = fr.post_from_minutes(minutes, row["utterances"], row=row)
        review = next(stage for stage in post["handoffs"]["stages"] if stage["id"] == "review")
        self.assertEqual(("missing", 0, 1), (review["provenance"], review["counts"]["confirmed"], review["counts"]["stale"]))

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
