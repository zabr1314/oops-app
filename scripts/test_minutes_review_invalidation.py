"""Cached minutes and their manual card work after review; all services are local fakes."""
import copy
import datetime as dt
import tempfile

from local_backend import Backend
from minutes_vote import RUNS  # the minutes are written RUNS times and voted on
from test_feishu_actions import EMPTY, FakeResolver, click, make, sent_to, texts, utter, wait_for


def fixture(resolver=None, generate=True):
    future = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=2)).strftime("%Y-%m-%dT15:00")
    analysis = dict(EMPTY, substantive=True, overview="确定周五交样片。",
                    decisions=[dict(text="周五交样片", ids=["u0"])],
                    actions=[dict(owner="林春源", task="发样片", due="周五", ids=["u1"])],
                    open_questions=[dict(question="横屏分辨率是多少", ids=["u2"])],
                    follow_ups=[dict(title="样片评审", start=future, minutes=30, attendees=["洪玉麟"], ids=["u3"])])
    resolver = resolver or FakeResolver(dict(analysis=analysis))
    actions, meetings, calls = make(tempfile.mkdtemp(), resolver)
    actions.backend.feishu = actions
    actions.backend.remember_review = lambda body: None
    started = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5)).isoformat()
    rows = [utter(0, "就定周五交样片", "林春源", "decision"),
            utter(1, "我来发样片", "林春源", "commitment"),
            utter(2, "横屏分辨率是多少？", "洪玉麟"),
            utter(3, "后天下午三点评审", "洪玉麟"),
            utter(4, "先看第一版", "林春源"), utter(5, "好的", "洪玉麟")]
    meetings.sync(dict(session_id="s", started_at=started, ended_at=started, time_zone="Asia/Shanghai", utterances=rows))
    if generate:
        actions.after_meeting(meetings.load("s"))
        assert actions.minutes_view(meetings.load("s"))["status"] == "ready"
    return actions, meetings, calls, resolver


def review(actions, uid="u1", **fields):
    return Backend.meeting_call(actions.backend, "review", dict(session_id="s", utterance_id=uid, **fields))


def assert_stale(actions, meetings):
    view = actions.minutes_view(meetings.load("s"))
    assert view["status"] == "unavailable" and view["reason"] == "source_changed", view
    assert "未重新生成" in view["message"] and "minutes" not in view


def test_each_review_withdraws_cached_minutes_without_erasing_history_or_current_digest():
    for uid, change in (("u0", dict(speaker="洪玉麟")), ("u1", dict(owner="江古月")), ("u0", dict(verdict="rejected"))):
        actions, meetings, calls, resolver = fixture()
        actions.state.put(dict(event_id="evt-old", url="https://history/calendar"), "calendar", "s:1")
        actions.state.put(True, "meetings", "s", "ledger_pending")
        history = copy.deepcopy(actions.state.get("meetings", "s"))
        calendar = copy.deepcopy(actions.state.get("calendar"))
        review(actions, uid, **change)
        assert_stale(actions, meetings)
        after = actions.state.get("meetings", "s")
        for key in ("analysis", "analysis_fingerprint", "doc_url", "sent", "ledger", "ledger_tables", "done"):
            assert after.get(key) == history.get(key), key
        assert actions.state.get("calendar") == calendar
        row = meetings.load("s")
        if change.get("verdict") == "rejected":
            assert not row["digest"]["decision"]
        else:
            item = row["digest"]["decision" if uid == "u0" else "commitment"][0]
            assert all(item["review"][key] == value for key, value in change.items())
        calls.clear()
        actions.after_meeting(row)
        actions.ledger_safe("s")
        assert calls == [] and resolver.asked == RUNS  # no automatic rewrite, resend or stale ledger retry


def test_same_review_and_clearing_absent_fields_leave_current_cache_ready():
    actions, meetings, calls, resolver = fixture(generate=False)
    review(actions, owner="江古月", by="林春源")
    actions.after_meeting(meetings.load("s"))
    fingerprint = actions.state.get("meetings", "s", "analysis_fingerprint")
    calls.clear()
    review(actions, owner="江古月", by="洪玉麟")  # only review audit metadata changes
    review(actions, "u0", speaker=None)  # no prior speaker correction to clear
    view = actions.minutes_view(meetings.load("s"))
    assert view["status"] == "ready" and view["minutes"]["actions"][0]["owner"] == "江古月"
    assert actions.state.get("meetings", "s", "analysis_fingerprint") == fingerprint
    assert not actions.state.get("meetings", "s", "analysis_invalidated")
    assert resolver.asked == RUNS and calls == []


def test_source_change_withdraws_minutes_title_but_keeps_review_citations():
    actions, meetings, calls, _ = fixture()
    analysis = actions.state.get('meetings', 's', 'analysis')
    actions.state.put(dict(analysis, theme='周五样片评审'), 'meetings', 's', 'analysis')
    meetings.cited = actions.cited_sentences
    assert meetings.load('s')['title_source'] == 'minutes'
    review(actions, owner='江古月')
    assert meetings.load('s')['title_source'] != 'minutes'
    assert actions.cited_sentences('s')['tasks'] == {'u1'}


def test_review_during_model_generation_keeps_result_as_history_and_never_sends_it():
    actions, meetings, calls, resolver = fixture(generate=False)
    complete = resolver.complete_json

    def concurrent_review(*args, **kwargs):
        review(actions, "u0", verdict="rejected")
        return complete(*args, **kwargs)

    resolver.complete_json = concurrent_review
    actions.after_meeting(meetings.load("s"))
    assert_stale(actions, meetings)
    assert actions.state.get("meetings", "s", "analysis") and calls == []
    actions.after_meeting(meetings.load("s"))
    assert resolver.asked == RUNS and calls == []


def test_old_card_buttons_cannot_create_new_actions_but_existing_receipt_is_readable():
    actions, meetings, calls, _ = fixture()
    actions.state.put(dict(event_id="evt-old", url="https://history/calendar"), "calendar", "s:1")
    review(actions, owner="江古月")
    calls.clear()
    for index, value in enumerate((dict(a="calendar", sid="s", i=0), dict(a="research", sid="s", i=0),
                                   dict(a="ppt", sid="s"), dict(a="report", sid="s"))):
        click(actions, "blocked-" + str(index), "ou_lin", value)
    assert not actions.jobs.all()
    assert len(texts(calls)) == 4 and all("旧纪要不能继续" in line for line in texts(calls))
    assert all(call[:2] == ["im", "+messages-send"] for call in calls)
    click(actions, "history", "ou_lin", dict(a="calendar", sid="s", i=1))
    assert "https://history/calendar" in texts(calls)[-1]
    assert not any(call[:2] == ["calendar", "+create"] for call in calls)


def test_queued_and_legacy_manual_jobs_stop_at_poll_when_their_minutes_change():
    for legacy in (False, True):
        actions, meetings, calls, _ = fixture()
        actions.hand_to_mac("ppt", "s", None, "ou_lin")
        job = actions.jobs.all()[0]
        assert job["payload"]["minutes_source_fingerprint"]
        if legacy:
            job["payload"].pop("minutes_source_fingerprint")
            actions.jobs.save(job)
        review(actions, owner="江古月")
        calls.clear()
        assert actions.agent_call("poll", dict(agent="test", wait=0))["job"] is None
        stopped = actions.jobs.load(job["id"])
        assert stopped["status"] == "failed" and stopped["reason"] == "source_changed" and calls == []


def test_running_job_cannot_return_stale_success_or_deliver_preaccepted_output():
    for accepted in (False, True):
        actions, meetings, calls, _ = fixture()
        actions.hand_to_mac("report", "s", None, "ou_lin")
        job = actions.agent_call("poll", dict(agent="test", wait=0))["job"]
        if accepted:
            stored = actions.jobs.load(job["id"])
            stored.update(status="delivering", title="旧报告")
            actions.jobs.save(stored)
        review(actions, "u0", speaker="洪玉麟")
        calls.clear()
        result = dict(ok=True, title="旧报告", markdown="# 旧负责人", brief="旧结果")
        if accepted:
            actions.deliver(job["id"], result)
        else:
            assert actions.agent_call("result", result, job["id"]) == dict(status="failed", reason="source_changed")
        assert actions.jobs.load(job["id"])["status"] == "failed" and calls == []


def test_review_while_creating_result_doc_prevents_sharing_and_result_messages():
    actions, meetings, calls, _ = fixture()
    actions.hand_to_mac("report", "s", None, "ou_lin")
    job = actions.agent_call("poll", dict(agent="test", wait=0))["job"]
    stored = actions.jobs.load(job["id"])
    stored.update(status="delivering", title="报告")
    actions.jobs.save(stored)
    doc = actions.bot.doc

    def concurrent_review(*args, **kwargs):
        result = doc(*args, **kwargs)
        review(actions, "u0", verdict="rejected")
        return result

    actions.bot.doc = concurrent_review
    calls.clear()
    actions.deliver(job["id"], dict(markdown="# 报告", brief="结果"))
    assert actions.jobs.load(job["id"])["status"] == "failed"
    assert len(calls) == 1 and calls[0][:2] == ["docs", "+create"]  # created doc stays private
    assert not sent_to(calls)


def test_review_while_creating_minutes_doc_prevents_sharing_and_cards():
    actions, meetings, calls, _ = fixture(generate=False)
    doc = actions.bot.doc

    def concurrent_review(*args, **kwargs):
        result = doc(*args, **kwargs)
        review(actions, owner="江古月")
        return result

    actions.bot.doc = concurrent_review
    try:
        actions.after_meeting(meetings.load("s"))
        raise AssertionError("stale minutes document shared")
    except ValueError:
        pass
    assert_stale(actions, meetings)
    assert len(calls) == 1 and calls[0][:2] == ["docs", "+create"]


def test_review_between_result_messages_stops_remaining_delivery_and_keeps_completed_history():
    actions, meetings, calls, _ = fixture()
    actions.hand_to_mac("report", "s", None, "ou_lin")
    job = actions.agent_call("poll", dict(agent="test", wait=0))["job"]
    stored = actions.jobs.load(job["id"])
    stored.update(status="delivering", title="报告", requesters=["ou_lin", "ou_hong"])
    actions.jobs.save(stored)
    dm_card = actions.bot.dm_card

    def concurrent_review(*args, **kwargs):
        result = dm_card(*args, **kwargs)
        review(actions, owner="江古月")
        return result

    actions.bot.dm_card = concurrent_review
    calls.clear()
    actions.deliver(job["id"], dict(markdown="# 报告", brief="结果"))
    done = actions.jobs.load(job["id"])
    assert done["status"] == "done" and done["doc_url"] and done["brief"] == "结果"
    assert sent_to(calls) == ["ou_lin"]  # the sent snapshot remains; the next recipient is blocked


def test_completed_result_history_survives_but_cannot_be_resent_from_stale_minutes():
    actions, meetings, calls, _ = fixture()
    actions.hand_to_mac("ppt", "s", None, "ou_lin")
    job = actions.jobs.all()[0]
    job.update(status="done", title="已发送 PPT", doc_url="https://history/ppt", brief="历史结果")
    actions.jobs.save(job)
    review(actions, owner="江古月")
    calls.clear()
    try:
        actions.send_result(job, ["ou_hong"], "retry")
        raise AssertionError("stale completed result resent")
    except ValueError:
        pass
    assert actions.jobs.load(job["id"]) == job and calls == []


def test_manual_review_precedes_generation_and_rejected_candidates_do_not_become_actions():
    actions, meetings, calls, resolver = fixture(generate=False)
    review(actions, "u0", verdict="rejected")
    review(actions, "u1", owner="江古月")
    review(actions, "u3", verdict="rejected")
    source = actions.transcript(meetings.load("s"))
    assert "人工核对负责人：江古月" in source and "人工已驳回" in source
    actions.after_meeting(meetings.load("s"))
    view = actions.minutes_view(meetings.load("s"))
    assert view["status"] == "ready"
    assert view["minutes"]["decisions"] == [] and view["minutes"]["follow_ups"] == []
    assert view["minutes"]["actions"][0]["owner"] == "江古月" and resolver.asked == RUNS


def test_legacy_reviewed_minutes_are_not_assumed_current_and_automatic_jobs_keep_their_rules():
    actions, meetings, calls, _ = fixture()
    # Simulate a cache from the server before fingerprints were saved.
    with actions.state.lock:
        actions.state.data["meetings"]["s"].pop("analysis_fingerprint")
        actions.state.save()
    assert actions.minutes_view(meetings.load("s"))["status"] == "ready"
    meetings.review(dict(session_id="s", utterance_id="u1", owner="江古月"))
    assert_stale(actions, meetings)  # also catches review written outside the HTTP method
    auto, _ = actions.jobs.add("research", dict(session_id="s", auto=True, question="横屏分辨率", quote="原话"), ["ou_lin"])
    calls.clear()
    job = actions.agent_call("poll", dict(agent="test", wait=0))["job"]
    assert job["id"] == auto["id"]
    assert actions.agent_call("result", dict(ok=True, markdown="# 独立检索结果", title="检索", brief="结果"), job["id"])["status"] == "delivering"
    wait_for(lambda: actions.jobs.load(job["id"])["status"] == "done")
    assert any(call[:2] == ["docs", "+create"] for call in calls)


if __name__ == "__main__":
    tests = [test for name, test in list(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"minutes review invalidation ok ({len(tests)} tests)")
