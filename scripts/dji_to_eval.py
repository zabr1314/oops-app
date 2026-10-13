#!/usr/bin/env python3
"""Turn one DJI discussion recording, already transcribed by asr_words_probe.py, into inputs for the offline tools.

    dji_to_eval.py prepare 0236 --purpose meeting-development   # → label_meeting.py <session>
    dji_to_eval.py truth 0236                                     # after labelling → truth-live.json for task_eval.py

The streaming ASR cuts a lively discussion into ~20 s finals that hold several speakers. For labelling, each
final is split at sentence punctuation, timed from its word timestamps, so one row is (mostly) one speaker.
The live pipeline still tags whole finals, so task labels are folded back onto their final for task_eval.py:

  evidence/<session>/meeting.json       sentences (u<final>-<n>, with `parent`) for label_meeting.py
  evidence/<session>/meeting-live.json  whole finals (u<final>), the granularity the phone sends to the backend
  evidence/<session>/truth-live.json    truth.json folded onto finals (written by `truth`)
  test-media/<session>-16k-mono.wav     symlink to the converted recording (+ .json with the purpose)

The session id is a fixed UUID derived from the recording name, because label_meeting.py only takes UUIDs.
"""
import argparse
import json
import os
import sys
import unicodedata
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PURPOSES = ("meeting-development", "meeting-holdout")
ENDS = "。？！?!"
FILLERS = set("嗯啊呃哦噢唉哎诶欸")


def recording(short):
    name = next((f for f in sorted(os.listdir(os.path.join(ROOT, "test-media")))
                 if f.startswith("DJI_") and f"_{short}_" in f and f.endswith("-16k-mono.wav")), None)
    if not name:
        raise ValueError(f"test-media/ 里没有 {short} 的 16k WAV")
    return name[:-len(".wav")]


def session_id(stem):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "oops-dji/" + stem))


def is_mark(c):
    return unicodedata.category(c)[0] in "PZ"


def char_times(final):
    """Start/end ms for every character of the final's text; punctuation inherits the previous character."""
    text, words = final["text"], timed_words(final)
    spoken = [i for i, c in enumerate(text) if not is_mark(c)]
    letters = lambda w: [c for c in w["text"] if not is_mark(c)]  # word tokens carry spaces and hyphens
    if "".join(c for w in words for c in letters(w)) != "".join(text[i] for i in spoken):
        return None
    times, k = [None] * len(text), 0
    for w in words:
        for _ in letters(w):
            times[spoken[k]] = (w["start_time"], w["end_time"])
            k += 1
    last = (words[0]["start_time"],) * 2
    for i, t in enumerate(times):
        times[i] = last = t or last
    return times


def timed_words(final):
    """Words with usable times; the ASR occasionally reports start_time -1."""
    return [w for w in final.get("words") or [] if 0 <= w["start_time"] <= w["end_time"]]


def pieces(text):
    """Sentence-sized character ranges; a piece that is only interjections joins the one before it."""
    out, start = [], 0
    for i, c in enumerate(text):
        if c in ENDS:
            out.append([start, i + 1])
            start = i + 1
    if start < len(text) and text[start:].strip():
        out.append([start, len(text)])
    merged = []
    for a, b in out:
        core = [c for c in text[a:b] if not is_mark(c)]
        if merged and all(c in FILLERS for c in core):
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return merged


def prepare(short, purpose):
    stem = recording(short)
    sid = session_id(stem)
    finals_path = os.path.join(ROOT, "evidence", "asr-words-complete", stem, "finals.json")
    finals = json.load(open(finals_path, encoding="utf-8"))
    live, rows, unsplit = [], [], 0
    for n, f in enumerate(finals, 1):
        words = timed_words(f)
        if not f["text"].strip() or not words:
            continue
        parent = f"u{n}"
        start, end = words[0]["start_time"], words[-1]["end_time"]
        live.append({"id": parent, "text": f["text"], "start_ms": start, "end_ms": end, "speaker": None})
        times = char_times(f)
        if times is None:
            unsplit += 1
            rows.append({"id": f"{parent}-1", "parent": parent, "text": f["text"], "start_ms": start, "end_ms": end, "speaker": None})
            continue
        for k, (a, b) in enumerate(pieces(f["text"]), 1):
            rows.append({"id": f"{parent}-{k}", "parent": parent, "text": f["text"][a:b].strip(),
                         "start_ms": times[a][0], "end_ms": times[b - 1][1], "speaker": None})
    folder = os.path.join(ROOT, "evidence", sid)
    os.makedirs(folder, exist_ok=True)
    common = {"session_id": sid, "recording": stem, "purpose": purpose, "source": "dji+asr-words-complete"}
    write(os.path.join(folder, "meeting.json"), {**common, "granularity": "sentence", "utterances": rows})
    write(os.path.join(folder, "meeting-live.json"), {**common, "granularity": "final", "utterances": live})
    wav = os.path.join(ROOT, "test-media", f"{sid}-16k-mono.wav")
    if not os.path.lexists(wav):
        os.symlink(f"{stem}.wav", wav)
    sidecar = os.path.splitext(wav)[0] + ".json"
    if os.path.exists(sidecar) and json.load(open(sidecar, encoding="utf-8")).get("purpose") != purpose:
        raise ValueError(f"{stem} 已登记为别的用途，不能改成 {purpose}")
    write(sidecar, {"purpose": purpose, "session": sid, "source": "dji", "recording": stem})
    return {"session": sid, "recording": stem, "finals": len(live), "sentences": len(rows), "unsplit_finals": unsplit,
            "label": f"python3 scripts/label_meeting.py {sid}"}


def fold_truth(short):
    sid = session_id(recording(short))
    folder = os.path.join(ROOT, "evidence", sid)
    with open(os.path.join(folder, "meeting.json"), encoding="utf-8") as stream:
        parent = {u["id"]: u["parent"] for u in json.load(stream)["utterances"]}
    with open(os.path.join(folder, "truth.json"), encoding="utf-8") as stream:
        truth = json.load(stream)
    tasks, seen = [], set()
    for t in truth["tasks"]:
        p = parent[t["utterance"]]
        tasks.append({**t, "utterance": p, "sentence": t["utterance"]})
        seen.add(p)
    # A final holding any task is a positive for the live pipeline, so it cannot also be a hard negative.
    non_tasks = [{**n, "utterance": parent[n["utterance"]], "sentence": n["utterance"]} for n in truth["non_tasks"]
                 if parent[n["utterance"]] not in seen]
    by_final = {}
    for t in tasks:
        by_final.setdefault(t["utterance"], []).append(t)
    groups = [sorted({parent[u] for u in g}) for g in truth.get("duplicates", [])]
    out = {**truth, "granularity": "final", "tasks": [ts[0] for ts in by_final.values()],
           "tasks_per_final": {p: [t["sentence"] for t in ts] for p, ts in by_final.items() if len(ts) > 1},
           "non_tasks": list({n["utterance"]: n for n in non_tasks}.values()),
           "duplicates": [g for g in groups if len(g) >= 2]}
    write(os.path.join(folder, "truth-live.json"), out)
    return {"truth": os.path.join(folder, "truth-live.json"), "sentence_tasks": len(truth["tasks"]), "final_tasks": len(out["tasks"])}


def write(path, value):
    with open(path, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=1)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("recording", help="录音编号，如 0236")
    p.add_argument("--purpose", required=True, choices=PURPOSES)
    t = sub.add_parser("truth")
    t.add_argument("recording")
    args = parser.parse_args(argv)
    try:
        result = prepare(args.recording, args.purpose) if args.cmd == "prepare" else fold_truth(args.recording)
    except (ValueError, OSError, KeyError) as error:
        print("失败：" + str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
