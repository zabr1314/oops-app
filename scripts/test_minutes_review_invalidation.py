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


def legacy_job(actions, kind):
    """A job queued by the old server, before personal mobile authorization."""
    row = actions.backend.meetings.load("s")
    job, _ = actions.jobs.add(kind, dict(session_id="s", transcript="旧稿输入", title="旧会议",
        minutes_source_fingerprint=actions.minutes_fingerprint(row)), ["ou_lin"], key=kind + "-s")
    return job


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
    assert len(texts(calls)) == 4 and all("回到 Oops" in line for line in texts(calls))
    assert all(call[:2] == ["im", "+messages-send"] for call in calls)
    click(actions, "history", "ou_lin", dict(a="calendar", sid="s", i=1))
    assert "回到 Oops" in texts(calls)[-1]
    assert actions.state.get("calendar", "s:1")["url"] == "https://history/calendar"
    assert not any(call[:2] == ["calendar", "+create"] for call in calls)


def test_queued_and_legacy_manual_jobs_stop_at_poll_when_their_minutes_change():
    for legacy in (False, True):
        actions, meetings, calls, _ = fixture()
        legacy_job(actions, "ppt")
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
        legacy_job(actions, "report")
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
            receipt = actions.agent_call("result", result, job["id"])
            assert receipt["generation_status"] == "ready" and receipt["delivery_status"] == "invalidated"
        saved = actions.jobs.load(job["id"])
        # Generation really finished; withdrawing its source must block delivery,
        # not label it a generation failure that could authorize another run.
        assert saved["status"] == "done" and saved["generation_status"] == "ready"
        assert saved["delivery_status"] == "invalidated" and saved["reason"] == "source_changed" and calls == []


def test_old_pending_result_stays_private_then_source_change_blocks_reuse():
    actions, meetings, calls, _ = fixture()
    job = legacy_job(actions, "report")
    actions.agent_call("poll", dict(agent="test", wait=0))
    calls.clear()
    actions.deliver(job["id"], dict(markdown="# 报告", brief="结果"))
    done = actions.jobs.load(job["id"])
    assert done["status"] == "done" and done["private_result"] and not done.get("doc_url")
    assert calls == []
    review(actions, "u0", verdict="rejected")
    try:
        actions.send_result(done, ["ou_lin"], "retry")
        raise AssertionError("old private result shared")
    except ValueError:
        pass
    assert calls == [] and actions.jobs.load(job["id"])["status"] == "done"


def test_minutes_generation_never_creates_a_document_or_bypasses_mobile_review():
    actions, meetings, calls, _ = fixture(generate=False)

    def unexpected_document(*args, **kwargs):
        raise AssertionError("private generation submitted a Feishu document")

    actions.bot.doc = unexpected_document
    actions.after_meeting(meetings.load("s"))
    assert calls == [] and actions.state.get("meetings", "s", "delivery_status") == "needs_review"
    review(actions, owner="江古月")
    assert_stale(actions, meetings)
    actions.after_meeting(meetings.load("s"))
    assert calls == []  # neither automatic retry nor a changed source can publish


def test_old_result_completion_keeps_historical_receipts_without_new_delivery():
    actions, meetings, calls, _ = fixture()
    job = legacy_job(actions, "report")
    stored = actions.jobs.load(job["id"])
    stored.update(status="delivering", title="报告", requesters=["ou_lin", "ou_hong"],
                  doc_url="https://history/report", sent=True)
    actions.jobs.save(stored)
    calls.clear()
    actions.deliver(job["id"], dict(markdown="# 报告", brief="结果"))
    done = actions.jobs.load(job["id"])
    assert done["status"] == "done" and done["doc_url"] == "https://history/report" and done["sent"]
    assert done["private_result"] and calls == []


def test_completed_result_history_survives_but_cannot_be_resent_from_stale_minutes():
    actions, meetings, calls, _ = fixture()
    legacy_job(actions, "ppt")
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


def test_legacy_reviewed_minutes_and_unbound_automatic_jobs_cannot_publish():
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
    assert actions.agent_call("poll", dict(agent="test", wait=0))["job"] is None
    stopped = actions.jobs.load(auto["id"])
    assert stopped["status"] == "failed" and stopped["reason"] == "source_changed"
    assert calls == []



if __name__ == "__main__":
    tests = [test for name, test in list(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"minutes review invalidation ok ({len(tests)} tests)")
