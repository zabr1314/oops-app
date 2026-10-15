"""Second ASR reading for the minutes: real Recordings, fake MiMo; no network."""
import datetime as dt
import hashlib
import json
import os
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(__file__))
import feishu_actions as fa  # noqa: E402
from asr_review import AsrReview, fingerprint  # noqa: E402
from recordings import Recordings  # noqa: E402
from test_feishu_actions import FakeResolver, make, utter  # noqa: E402

SID = "session-asr-0001"


def sha(data):
    return hashlib.sha256(data).hexdigest()


class FakeMimo:
    model = "fake-mimo"

    def __init__(self, answers=None, fail=False):
        self.answers, self.fail, self.calls = answers or {}, fail, []

    def transcribe(self, wav):
        assert wav[:4] == b"RIFF"
        self.calls.append(len(wav))
        if self.fail:
            raise RuntimeError("down")
        return self.answers.get(len(self.calls), "同样的话"), None


def recording(tmp, seconds=60, sid=SID):
    store = Recordings(os.path.join(tmp, "rec"), deleted=lambda s: False)
    audio = b"\x01\x00" * 16000 * seconds
    store.manifest(sid, {"files": [{"name": "audio.pcm", "size": len(audio), "sha256": sha(audio)}]})
    for at in range(0, len(audio), 1_000_000):
        part = audio[at:at + 1_000_000]
        store.chunk(sid, "audio.pcm", at, part, sha(part))
    store.complete(sid)
    return store


def row(*utterances, sid=SID):
    return {"session_id": sid, "utterances": list(utterances)}


def u(i, text, start, ms=3000):
    return dict(id=f"u{i}", text=text, start_ms=start, end_ms=start + ms)


def review(tmp, store, client, **caps):
    return AsrReview(store, os.path.join(tmp, "usage.json"), client, log=lambda *_: None, workers=1, **caps)


def test_reads_each_sentence_once_and_hints_only_differences():
    tmp = tempfile.mkdtemp()
    store = recording(tmp)
    client = FakeMimo({1: "声纹要怎么处理。", 2: "好的，我们走。"})
    r = review(tmp, store, client)
    meeting = row(u(1, "深吻要怎么处理", 0), u(2, "好的我们走", 5000), u(3, "嗯", 9000, ms=300))
    assert not r.settled(meeting)
    assert r.run(meeting) == 2 and len(client.calls) == 2  # the 0.3 s "嗯" is not worth a request
    assert r.settled(meeting)
    assert r.hints(meeting) == {"u1": "声纹要怎么处理。"}  # punctuation-only differences are not hints
    assert r.run(meeting) == 0 and len(client.calls) == 2  # cached
    edited = row(u(1, "深吻要怎么处理呢", 0), u(2, "好的我们走", 5000))
    assert not r.settled(edited) and r.hints(edited) == {}  # a changed sentence is read again
    r.run(edited)
    assert len(client.calls) == 3
    saved = json.load(open(os.path.join(store.folder(SID), "asr_review.json")))
    assert saved["sentences"]["u1"]["fp"] == fingerprint(edited["utterances"][0])
    assert oct(os.stat(os.path.join(store.folder(SID), "asr_review.json")).st_mode & 0o777) == "0o600"


def test_caps_and_failures_stop_but_settle():
    tmp = tempfile.mkdtemp()
    store = recording(tmp)
    meeting = row(*[u(i, f"第{i}句", i * 4000) for i in range(6)])
    capped = review(tmp, store, FakeMimo(), meeting_s=7)
    assert capped.run(meeting) == 2  # 3 s each: the third would pass 7 s
    assert capped.settled(meeting)  # finished for this version; the minutes do not wait for the rest
    tmp2 = tempfile.mkdtemp()
    store2 = recording(tmp2)
    daily = review(tmp2, store2, FakeMimo(), daily_s=4)
    assert daily.run(meeting) == 1
    down = FakeMimo(fail=True)
    tmp3 = tempfile.mkdtemp()
    failing = review(tmp3, recording(tmp3), down)
    assert failing.run(row(*[u(i, f"第{i}句", i * 4000) for i in range(12)])) == 0
    assert len(down.calls) == 5  # stops after five failures in a row instead of burning the whole meeting


def test_unavailable_sources_never_hint():
    tmp = tempfile.mkdtemp()
    store = recording(tmp)
    r = review(tmp, store, FakeMimo({1: "别的写法"}))
    meeting = row(u(1, "原话", 0))
    r.run(meeting)
    assert r.hints(meeting) == {"u1": "别的写法"}
    assert r.hints(dict(meeting, transcript_status="expired")) == {}
    store.delete(SID)
    assert r.hints(meeting) == {} and r.settled(meeting)  # no recording: minutes go ahead
    missing = row(u(1, "原话", 0), sid="session-none-01")
    assert r.settled(missing) and r.run(missing) == 0


def test_upload_not_complete_keeps_waiting():
    tmp = tempfile.mkdtemp()
    store = Recordings(os.path.join(tmp, "rec"), deleted=lambda s: False)
    audio = b"\0\0" * 16000
    store.manifest(SID, {"files": [{"name": "audio.pcm", "size": len(audio), "sha256": sha(audio)}]})
    r = review(tmp, store, FakeMimo())
    assert not r.settled(row(u(1, "原话", 0))) and r.run(row(u(1, "原话", 0))) == 0


def test_expired_transcript_removes_the_second_reading():
    tmp = tempfile.mkdtemp()
    store = recording(tmp)
    r = review(tmp, store, FakeMimo({1: "别的写法"}))
    meeting = row(u(1, "原话", 0))
    r.run(meeting)
    path = os.path.join(store.folder(SID), "manifest.json")
    manifest = json.load(open(path))
    now = dt.datetime.now(dt.timezone.utc)
    manifest["storage_policy"] = {"audio_expires_at": (now + dt.timedelta(days=9)).isoformat(),
                                  "transcript_expires_at": (now - dt.timedelta(minutes=1)).isoformat()}
    json.dump(manifest, open(path, "w"))
    store._expire(SID)
    assert not os.path.exists(os.path.join(store.folder(SID), "asr_review.json"))
    assert r.hints(meeting) == {}


def test_minutes_wait_for_the_reading_then_use_it():
    tmp = tempfile.mkdtemp()
    seen = []
    resolver = FakeResolver({"analysis": lambda user: seen.append(user) or {
        "substantive": True, "overview": "", "decisions": [], "topics": [], "open_questions": [], "follow_ups": [],
        "actions": [{"owner": "", "task": "调研声纹方案", "due": "", "ids": ["u1"]}]}})
    actions, meetings, calls = make(tmp, resolver)
    started = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5)).isoformat()
    meetings.sync(dict(session_id="s1", started_at=started, time_zone="Asia/Shanghai",
                       utterances=[utter(i, "深吻要怎么处理" if i == 1 else f"第{i}句", "林春源") for i in range(6)]))
    meetings.sync(dict(session_id="s1", started_at=started, ended_at=dt.datetime.now(dt.timezone.utc).isoformat(), utterances=[]))
    ran = []
    fake = types.SimpleNamespace(settled=lambda r: bool(ran), run=lambda r: ran.append(r["session_id"]),
                                 hints=lambda r: {"u1": "声纹要怎么处理"})
    actions.asr_review = fake
    actions.after_meeting_safe = lambda sid, source="device": calls.append(["after", sid])
    later = dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=3)
    actions.state.put((dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).isoformat(), "since")
    actions.tick(later)
    import time
    for _ in range(100):
        if ran: break
        time.sleep(0.02)
    assert ran == ["s1"] and ["after", "s1"] not in calls  # waiting for the reading
    actions.tick(later)
    for _ in range(100):
        if ["after", "s1"] in calls: break
        time.sleep(0.02)
    assert ["after", "s1"] in calls
    ran.clear()
    actions.tick(dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30))  # never waits past the limit
    actions.analyse_once(meetings.load("s1"))
    assert "深吻要怎么处理（另一识别：声纹要怎么处理）" in seen[-1]
    assert "另一识别" in fa.MINUTES_PROMPT
