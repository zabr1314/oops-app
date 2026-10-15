#!/usr/bin/env python3
"""Probe the app's streaming ASR configuration; credentials never enter evidence/logs.

Run with .venv-voice/bin/python (websocket-client). Raw replies and definite sentences
stay under ignored evidence/asr-words/. --seconds is only for a preliminary smoke probe;
omit it for the two complete non-enrollment recordings.
"""
import argparse
import difflib
import gzip
import json
import math
import os
import re
from pathlib import Path
import struct
import threading
import time
import unicodedata
import uuid
import wave

ROOT = Path(__file__).resolve().parent.parent
ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"


def credentials(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip()
    return {k: values.get(k) or os.environ.get(k, "") for k in
            ("VOLC_API_KEY", "VOLC_APP_ID", "VOLC_ACCESS_TOKEN", "VOLC_RESOURCE_ID")}


# Same hotwords as the app (Settings.HOTWORDS); without them the probe transcribes names differently from live.
HOTWORDS = ["Oops", "欧普斯", "Lydia", "黄丽萍", "江古月", "洪玉麟", "林春源"]


def request_json(hotwords=True, end_window_size=None):
    # Keep in sync with VolcRequest.json; diarization is deliberately disabled.
    request = {"model_name": "bigmodel", "enable_nonstream": True,
               "enable_itn": True, "enable_punc": True,
               "show_utterances": True, "result_type": "single"}
    if hotwords:
        words = [{"word": w} for w in HOTWORDS]
        request["corpus"] = {"context": json.dumps({"hotwords": words}, ensure_ascii=False)}
    if end_window_size is not None:
        # Silence (ms) after which the provider ends a sentence; the app leaves the provider default.
        request["end_window_size"] = end_window_size
    return {"user": {"uid": "oops-words-probe-" + uuid.uuid4().hex},
            "audio": {"format": "pcm", "codec": "raw", "rate": 16000, "bits": 16, "channel": 1},
            "request": request}


def frame(kind, payload, last=False, compressed=False, final_sequence=False):
    return bytes((0x11, (kind << 4) | (3 if last and final_sequence else 2 if last else 0), 0x11 if compressed else 0, 0)) \
        + (struct.pack(">i", -1) if last and final_sequence else b"") \
        + struct.pack(">I", len(payload)) + payload


def decode(data):
    if not isinstance(data, bytes) or len(data) < 8:
        raise ValueError("invalid ASR binary response")
    kind, flags, compression = data[1] >> 4, data[1] & 15, data[2] & 15
    offset = (data[0] & 15) * 4
    if data[0] >> 4 != 1 or offset < 4 or offset > len(data) - 4 or flags not in range(4) or compression not in (0, 1):
        raise ValueError('invalid ASR response header')
    if kind == 15:
        if len(data) - offset < 8:
            raise ValueError('truncated ASR error header')
        code = struct.unpack_from(">I", data, offset)[0]
        size = struct.unpack_from(">I", data, offset + 4)[0]
        if size != len(data) - offset - 8:
            raise ValueError('invalid ASR error size')
        payload = data[offset + 8:]
        if compression == 1 and payload:
            payload = gzip.decompress(payload)
        raise RuntimeError(f"ASR provider error {code}: " + payload.decode(errors="replace")[:300])
    if kind != 9:
        raise ValueError('unsupported ASR response type')
    if flags & 1:
        offset += 4
    if len(data) - offset < 4:
        raise ValueError('truncated ASR response header')
    size = struct.unpack_from(">I", data, offset)[0]
    if size != len(data) - offset - 4:
        raise ValueError('invalid ASR response size')
    payload = data[offset + 4:]
    if compression == 1 and payload:
        payload = gzip.decompress(payload)
    reply = json.loads(payload) if payload else {}
    if not isinstance(reply, dict):
        raise ValueError('ASR response is not an object')
    return reply, bool(flags & 2)


def clean(text):
    return "".join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith("P"))


def difference_kind(final, words):
    spoken = "".join(w.get("text", w.get("word", "")) for w in words)
    if spoken == final:
        return "none"
    source, target = clean(spoken), clean(final)
    if source == target:
        return "punctuation"
    numeric = re.compile(r"[0-9零〇一二三四五六七八九十百千万亿兆两壹贰叁肆伍陆柒捌玖拾佰仟点负百分之]+")
    changes = [(source[a:b], target[c:d]) for op, a, b, c, d in
               difflib.SequenceMatcher(None, source, target, autojunk=False).get_opcodes() if op != "equal"]
    # Numeric-only spelling changes are ITN candidates, requiring manual confirmation.
    return "itn_candidate" if all(numeric.fullmatch(a) and numeric.fullmatch(b) for a, b in changes) else "revision"


def summarize(utterances):
    rows = []
    for u in utterances:
        words = u.get("words") or []
        text, spoken = clean(u.get("text", "")), clean("".join(w.get("text", w.get("word", "")) for w in words))
        matcher = difflib.SequenceMatcher(None, spoken, text, autojunk=False)
        covered = sum(b.size for b in matcher.get_matching_blocks()) / max(1, len(text))
        # ASR emits whitespace tokens with sentinel -1 timestamps; these are not spoken words.
        timed = [w for w in words if clean(w.get("text", w.get("word", "")))]
        valid = bool(timed) and all("end_time" in w and
                                    u.get("start_time", 0) <= w.get("start_time", 0) <=
                                    w.get("end_time", 0) <= u.get("end_time", 0) for w in timed)
        temporal = max(0, timed[-1].get("end_time", 0) - timed[0].get("start_time", 0)) \
            / max(1, u.get("end_time", 0) - u.get("start_time", 0)) if valid else 0
        rows.append({"start_ms": u.get("start_time", 0), "end_ms": u.get("end_time", 0),
                     "has_word_times": valid, "exact_character_coverage": round(covered, 4),
                     "word_span_fraction": round(temporal, 4),
                     "difference": difference_kind(u.get("text", ""), words)})
    n = len(rows)
    return {"final_count": n, "with_word_times": sum(r["has_word_times"] for r in rows),
            "coverage_ge_90_count": sum(r["has_word_times"] and r["exact_character_coverage"] >= .9 for r in rows),
            "coverage_ge_90_fraction": round(sum(r["has_word_times"] and r["exact_character_coverage"] >= .9 for r in rows) / max(1, n), 4),
            "difference_counts": {d: sum(r["difference"] == d for r in rows)
                                  for d in ("none", "punctuation", "itn_candidate", "revision")},
            "rows": rows}


class ProbeStream:
    """One socket, one EOS, one terminal outcome. Never reconnects or resends audio."""
    def __init__(self, ws, secrets=()):
        self.ws, self.secrets = ws, tuple(secret for secret in secrets if secret)
        self.lock = threading.RLock()
        self.done = threading.Event()
        self.finals, self.seen, self.errors = [], set(), []
        self.eos_attempted, self.eos_sent, self.server_last, self.termination = False, False, False, None
        self.skipped_empty = 0

    def fail(self, detail, termination):
        with self.lock:
            if self.done.is_set():
                return
            for secret in self.secrets:
                detail = detail.replace(secret, '[redacted]')
            self.errors.append(detail)
            self.termination = termination
            self.done.set()

    def send_audio(self, pcm):
        with self.lock:
            if self.done.is_set() or self.eos_attempted:
                return False
            sent = self.ws.send_binary(frame(2, pcm))
            if sent is False or type(sent) is int and sent <= 0:
                raise RuntimeError('ASR audio send failed')
            return True

    def finish(self, final_sequence=False):
        with self.lock:
            if self.done.is_set() or self.eos_attempted:
                return
            # Audio samples remain exact. This separate control packet carries no
            # additional audio/silence and is submitted once, including on empty input.
            self.eos_attempted = True
            sent = self.ws.send_binary(frame(2, b'', last=True, final_sequence=final_sequence))
            if sent is False or type(sent) is int and sent <= 0:
                raise RuntimeError('ASR EOS send failed')
            self.eos_sent = True

    def receive(self, raw):
        reply, last = decode(raw)
        with self.lock:
            if self.done.is_set():
                return reply
            utterances = (reply.get('result') or {}).get('utterances', [])
            if not isinstance(utterances, list):
                raise ValueError('invalid ASR utterances')
            for utterance in utterances:
                if not isinstance(utterance, dict):
                    raise ValueError('invalid ASR utterance')
                text = utterance.get('text')
                if not isinstance(text, str) or not text.strip():
                    if utterance.get('definite'):
                        self.skipped_empty += 1
                    continue
                key = (utterance.get('start_time', 0), utterance.get('end_time', 0), text)
                if utterance.get('definite') and key not in self.seen:
                    self.finals.append(utterance)
                    self.seen.add(key)
            if last:
                self.server_last = True
                if self.eos_sent:
                    self.termination = 'acknowledged'
                    self.done.set()
                else:
                    self.fail('ASR ended before the explicit EOS; completeness is unconfirmed', 'premature_server_end')
        return reply

    def wait_for_finish(self, timeout):
        if not self.done.wait(timeout):
            self.fail('ASR finish acknowledgement timed out; captured finals retained', 'finish_timeout')


def probe(path, args):
    import websocket
    # Validate before opening a chargeable connection.
    with wave.open(str(path)) as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (16000, 1, 2):
            raise ValueError('requires 16 kHz mono s16le WAV')
        total_samples = audio.getnframes()
    limit = min(total_samples, int(args.seconds * 16000)) if args.seconds else total_samples
    dest = Path(args.output) / path.stem
    dest.mkdir(parents=True, exist_ok=True)
    if any((dest / name).exists() for name in ('responses.jsonl', 'finals.json', 'summary.json')):
        raise FileExistsError('Probe evidence already exists; use a new output directory, no automatic paid retry')
    creds = credentials(ROOT / "android/local.properties")
    headers = {"X-Api-Resource-Id": creds["VOLC_RESOURCE_ID"] or "volc.seedasr.sauc.duration",
               "X-Api-Connect-Id": str(uuid.uuid4())}
    if creds["VOLC_API_KEY"]:
        headers["X-Api-Key"] = creds["VOLC_API_KEY"]
    elif creds["VOLC_APP_ID"] and creds["VOLC_ACCESS_TOKEN"]:
        headers.update({"X-Api-App-Key": creds["VOLC_APP_ID"], "X-Api-Access-Key": creds["VOLC_ACCESS_TOKEN"]})
    else:
        raise RuntimeError("ASR credentials are not configured")
    ws = websocket.create_connection(ENDPOINT, header=headers, timeout=30, enable_multithread=True)
    stream = ProbeStream(ws, creds.values())

    def receive():
        try:
            with (dest / "responses.jsonl").open("w") as out:
                while not stream.done.is_set():
                    raw = ws.recv()
                    if not raw:
                        stream.fail('ASR socket closed without a terminal acknowledgement', 'closed_without_ack')
                        break
                    reply = stream.receive(raw)
                    out.write(json.dumps(reply, ensure_ascii=False) + "\n")
                    out.flush()
        except Exception as exc:
            detail = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
            stream.fail(detail, 'provider_error' if isinstance(exc, RuntimeError) else 'receive_error')

    reader = threading.Thread(target=receive, daemon=True)
    sent_samples = 0
    try:
        ws.send_binary(frame(1, gzip.compress(json.dumps(request_json(not getattr(args, 'no_hotwords', False), getattr(args, 'end_window_size', None)), ensure_ascii=False).encode()), compressed=True))
        reader.start()
        with wave.open(str(path)) as audio:
            started, progress_at = time.monotonic(), time.monotonic()
            while sent_samples < limit and not stream.done.is_set():
                data = audio.readframes(min(3200, limit - sent_samples))
                if not data:
                    break
                if not stream.send_audio(data):
                    break
                sent_samples += len(data) // 2
                wait = started + sent_samples / 16000 / args.speed - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                if time.monotonic() - progress_at >= 30:
                    print(json.dumps({"recording": path.name, "sent_seconds": round(sent_samples / 16000),
                                      "final_count": len(stream.finals)}), flush=True)
                    progress_at = time.monotonic()
            if sent_samples == limit and not stream.done.is_set():
                stream.finish(final_sequence=getattr(args, 'final_sequence', False))
            stream.wait_for_finish(getattr(args, 'finish_timeout', 30.0))
    except Exception as exc:
        detail = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
        stream.fail(detail, 'send_error')
    finally:
        try:
            ws.close()
        except Exception:
            stream.fail('ASR socket cleanup failed; captured finals retained', 'close_error')
        finally:
            if reader.ident is not None:
                reader.join(2)
    finals = stream.finals
    finals.sort(key=lambda u: (u.get("start_time", 0), u.get("end_time", 0)))
    (dest / "finals.json").write_text(json.dumps(finals, ensure_ascii=False, indent=2) + "\n")
    report = {"recording": path.name, "sent_seconds": round(sent_samples / 16000, 3),
              "complete": not args.seconds and sent_samples == limit and not stream.errors
                          and stream.eos_sent and stream.termination == 'acknowledged',
              "eos_attempted": stream.eos_attempted, "eos_sent": stream.eos_sent, "termination": stream.termination,
              "all_samples_sent": sent_samples == limit, "total_samples": total_samples,
              "server_last_received": stream.server_last,
              "skipped_empty_final_count": stream.skipped_empty,
              "transport_errors": stream.errors, **summarize(finals)}
    (dest / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "rows"}, ensure_ascii=False), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", nargs="*", type=Path)
    parser.add_argument("--output", default=str(ROOT / "evidence/asr-words"))
    parser.add_argument("--seconds", type=float)
    parser.add_argument("--speed", type=float, default=1.0, help="audio send pace; 1 matches the live app")
    parser.add_argument("--no-hotwords", action="store_true", help="omit the app's hotwords (the pre-2026-10-08 probe behaviour)")
    parser.add_argument("--end-window-size", type=int, help="sentence-ending silence in ms; unset = provider default, as in the app")
    parser.add_argument("--final-sequence", action="store_true", help="final negative sequence packet for transport diagnosis")
    parser.add_argument('--finish-timeout', type=float, default=30.0, help='seconds to await provider terminal acknowledgement after one empty EOS')
    args = parser.parse_args()
    if (not math.isfinite(args.speed) or args.speed <= 0 or not math.isfinite(args.finish_timeout)
            or args.finish_timeout <= 0 or args.seconds is not None and (not math.isfinite(args.seconds) or args.seconds <= 0)):
        parser.error('speed, seconds and finish-timeout must be finite and positive')
    paths = args.wav or [p for p in sorted((ROOT / "test-media").glob("*-16k-mono.wav"))
                         if "_0236_" in p.name or "_0238_" in p.name]
    if not paths:
        parser.error("no evaluation recordings found")
    reports = [probe(p, args) for p in paths]
    if any(r["transport_errors"] or not r["final_count"] or (not args.seconds and not r["complete"]) for r in reports):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
