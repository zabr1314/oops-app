"""会后逐句复核：用第二个语音识别模型（小米 MiMo）把每句话的原始录音再识别一遍，只给 AI 写纪要时参考。

实时字幕和每句话的起止时间仍来自手机上的火山流式识别；这里不改任何原话、时间或说话人。
录音上传完成后，按已有的起止时间从 audio.pcm 截出这句话（Recordings.clip，遵守删除和保留期），
交给 MiMo，结果存在这场会的录音目录里（asr_review.json，转写到期时随转写一起删除）。
写纪要时，两边写法不同的句子在行末附上「另一识别：…」，帮模型判断专有名词和听错的词。

只有设置了 MIMO_API_KEY 才开启。花钱有上限：每场会、每天各有一个音频秒数上限（OOPS_ASR_REVIEW_MEETING_S、
OOPS_ASR_REVIEW_DAILY_S），用完就停，纪要照常用原文写。
"""
import base64
import datetime as dt
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from recordings import RecordingError

FILE = "asr_review.json"
MODEL = "mimo-v2.5-asr"
MIN_MS, MAX_MS = 600, 30_000  # Recordings.clip refuses longer sentences; very short ones are "对" "嗯"
CONSECUTIVE_FAILURES = 5  # the service is down or the key is wrong: stop and let the minutes go ahead


def fingerprint(u):
    """The sentence the second reading belongs to; a re-split or edited sentence is read again."""
    body = f"{u.get('id')}|{u.get('start_ms')}|{u.get('end_ms')}|{u.get('text')}"
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:24]


_PUNCT = re.compile(r"[\s，。！？、；：,.!?;:…\"'“”‘’（）()\[\]【】《》<>·~～—-]+")


def normalized(text):
    return _PUNCT.sub("", str(text or "")).lower()


def eligible(u):
    start, end = u.get("start_ms"), u.get("end_ms")
    return (isinstance(u.get("id"), str) and type(start) is int and type(end) is int and 0 <= start
            and MIN_MS <= end - start <= MAX_MS and bool(normalized(u.get("text"))))


class MimoClient:
    def __init__(self, api_key, base_url="https://api.xiaomimimo.com/v1", model=MODEL, timeout=60):
        self.api_key, self.base_url, self.model, self.timeout = api_key, base_url.rstrip("/"), model, timeout

    def transcribe(self, wav):
        body = {"model": self.model, "asr_options": {"language": "auto"}, "messages": [{"role": "user", "content": [
            {"type": "input_audio", "input_audio": {"data": "data:audio/wav;base64," + base64.b64encode(wav).decode()}}]}]}
        request = urllib.request.Request(self.base_url + "/chat/completions", data=json.dumps(body).encode(),
                                         headers={"Authorization": "Bearer " + self.api_key,
                                                  "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                data = json.load(response)
        except urllib.error.HTTPError as error:  # never echo the request: it carries the key
            raise RuntimeError(f"MiMo HTTP {error.code}") from None
        text = ((data.get("choices") or [{}])[0].get("message") or {}).get("content")
        if not isinstance(text, str):
            raise RuntimeError("MiMo 返回里没有文字")
        return text.strip(), (data.get("usage") or {}).get("seconds")


class AsrReview:
    def __init__(self, recordings, usage_path, client, log=print, meeting_s=None, daily_s=None, workers=4):
        self.recordings, self.usage_path, self.client, self.log = recordings, usage_path, client, log
        self.meeting_s = meeting_s if meeting_s is not None else int(os.environ.get("OOPS_ASR_REVIEW_MEETING_S", "7200"))
        self.daily_s = daily_s if daily_s is not None else int(os.environ.get("OOPS_ASR_REVIEW_DAILY_S", "14400"))
        self.workers = workers
        self.lock = threading.Lock()

    @classmethod
    def from_env(cls, recordings, state_dir, log=print):
        key = os.environ.get("MIMO_API_KEY", "").strip()
        if not key or recordings is None:
            return None
        client = MimoClient(key, os.environ.get("MIMO_BASE_URL", "https://api.xiaomimimo.com/v1"),
                            os.environ.get("MIMO_ASR_MODEL", MODEL))
        return cls(recordings, os.path.join(state_dir, "asr-review-usage.json"), client, log)

    # storage --------------------------------------------------------------------------------

    def _path(self, sid):
        return os.path.join(self.recordings.folder(sid), FILE)

    def _readable(self, sid):
        """The second reading is transcript text: gone with the meeting, the audio or the transcript."""
        status = self.recordings.status(sid)  # raises for deleted meetings; expires files first
        return bool(status.get("complete")) and status["assets"].get("audio") == "available" \
            and status["assets"].get("transcript") != "expired"

    def _load(self, sid):
        try:
            with open(self._path(sid), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {"sentences": {}}

    def _save(self, sid, data):
        path = self._path(sid)
        temp = path + ".tmp"
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(temp, path)

    def _spend(self, seconds):
        """Reserve audio seconds against today's cap before asking; False when the day is used up."""
        today = dt.datetime.now(dt.timezone.utc).date().isoformat()
        with self.lock:
            try:
                with open(self.usage_path, encoding="utf-8") as f:
                    usage = json.load(f)
            except (OSError, ValueError):
                usage = {}
            used = usage.get(today, 0)
            if used + seconds > self.daily_s:
                return False
            usage = {today: used + seconds}
            os.makedirs(os.path.dirname(self.usage_path), exist_ok=True)
            temp = self.usage_path + ".tmp"
            with open(temp, "w", encoding="utf-8") as f:
                json.dump(usage, f)
            os.replace(temp, self.usage_path)
            return True

    # the job ---------------------------------------------------------------------------------

    def settled(self, row):
        """Nothing more to wait for: every sentence read, or the review finished or gave up for this version."""
        sid = row["session_id"]
        try:
            if not self._readable(sid):
                return False
        except RecordingError:
            return True  # no recording, or deleted: minutes go ahead on the original text
        data = self._load(sid)
        if data.get("finished") == self._row_print(row):
            return True
        done = data.get("sentences", {})
        return all(done.get(u["id"], {}).get("fp") == fingerprint(u) for u in row["utterances"] if eligible(u))

    @staticmethod
    def _row_print(row):
        return hashlib.sha256("\n".join(fingerprint(u) for u in sorted(row["utterances"], key=lambda u: u["id"]))
                              .encode()).hexdigest()[:24]

    def run(self, row):
        """Read every not-yet-read sentence of a meeting whose recording is complete. Safe to call again."""
        sid = row["session_id"]
        try:
            if not self._readable(sid):
                return 0
        except RecordingError:
            return 0
        data = self._load(sid)
        sentences = data.setdefault("sentences", {})
        todo = [u for u in sorted(row["utterances"], key=lambda u: u["start_ms"])
                if eligible(u) and sentences.get(u["id"], {}).get("fp") != fingerprint(u)]
        spent = sum(v.get("ms", 0) for v in sentences.values()) / 1000
        started, failures, stop = time.monotonic(), [0], [None]
        state_lock = threading.Lock()

        def one(u):
            if stop[0]:
                return
            ms = u["end_ms"] - u["start_ms"]
            with state_lock:
                nonlocal spent
                if spent + ms / 1000 > self.meeting_s:
                    stop[0] = "这场会的复核时长已到上限"
                    return
                if not self._spend(ms / 1000):
                    stop[0] = "今天的复核时长已到上限"
                    return
                spent += ms / 1000
            try:
                wav = self.recordings.clip(sid, u["start_ms"], u["end_ms"])
                text, _ = self.client.transcribe(wav)
            except RecordingError as error:
                stop[0] = f"录音不可用：{error}"
                return
            except Exception as error:  # noqa: BLE001 - one failed sentence keeps its original text only
                with state_lock:
                    failures[0] += 1
                    if failures[0] >= CONSECUTIVE_FAILURES:
                        stop[0] = f"连续失败：{type(error).__name__}: {str(error)[:120]}"
                return
            with state_lock:
                failures[0] = 0
                sentences[u["id"]] = {"fp": fingerprint(u), "text": text[:600], "ms": ms}

        with ThreadPoolExecutor(self.workers) as pool:
            list(pool.map(one, todo))
        with self.recordings.lock:
            try:
                if not self._readable(sid):  # deleted or expired while we were reading: keep nothing
                    return 0
            except RecordingError:
                return 0
            data.update(model=getattr(self.client, "model", MODEL), finished=self._row_print(row),
                        stopped=stop[0], at=dt.datetime.now(dt.timezone.utc).isoformat())
            self._save(sid, data)
        read = sum(1 for u in todo if sentences.get(u["id"], {}).get("fp") == fingerprint(u))
        self.log(f"asr review {sid[:8]}: {read}/{len(todo)} sentences in {int(time.monotonic() - started)}s"
                 + (f"; stopped: {stop[0]}" if stop[0] else ""))
        return read

    def hints(self, row):
        """id → MiMo's text, only for sentences it reads differently and only while the sources are live."""
        sid = row["session_id"]
        if row.get("transcript_status") == "expired":
            return {}
        try:
            if not self._readable(sid):
                return {}
        except RecordingError:
            return {}
        sentences = self._load(sid).get("sentences", {})
        out = {}
        for u in row["utterances"]:
            seen = sentences.get(u.get("id")) or {}
            if seen.get("fp") == fingerprint(u) and normalized(seen.get("text")) \
                    and normalized(seen["text"]) != normalized(u.get("text")):
                out[u["id"]] = seen["text"][:max(40, 2 * len(u.get("text") or "") + 20)]
        return out
