#!/usr/bin/env python3
"""Replay a recorded meeting through the backend's judgement steps and log what Oops would have done, and when.

    # on the Hong Kong server (Jev answers only there), with the deployed modules and the backend's keys:
    sudo -u oops sh -c 'set -a; . /var/lib/oops/backend.env; set +a; \\
        /opt/oops/venv/bin/python replay_meeting.py --app /opt/oops/app/scripts --jev-env /var/lib/oops/jev.env \\
        meeting-live.json replay.json'

Input: {"utterances": [{id, text, start_ms, end_ms, speaker}]} at the granularity the phone sends (ASR finals).
Steps, each timed at the moment the phone would trigger it:
  tag        every final, with the 4 previous finals as context (Backend.tag: Jev, then the clause check)
  task       finals tagged as commitments → DeepSeek task resolver (who / what / when, quotes verified)
  conflict   decisions and constraints → conflict check against the earlier ones in this meeting
  question   question-shaped finals → search now / wait / quick answer / skip, as the bot decides (question_watch)
  minutes    after the end → the bot's minutes (feishu_actions.analyse)
Read-only: nothing is written to Feishu, the meeting store or the task log. Python 3.10.
"""
import argparse
import json
import os
import sys
import time
import types
from concurrent.futures import ThreadPoolExecutor


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("meeting")
    p.add_argument("out")
    p.add_argument("--app", required=True, help="directory holding local_backend.py and friends")
    p.add_argument("--jev-env", required=True)
    p.add_argument("--started-at", default="2026-10-05T15:01:43Z")
    args = p.parse_args()
    sys.path.insert(0, args.app)
    import local_backend
    import question_watch
    from feishu_actions import FeishuActions
    from meeting_features import judge_notice
    from task_resolver import load_deepseek, resolve_all

    rows = json.load(open(args.meeting, encoding="utf-8"))["utterances"]
    jev = local_backend.load_jev(types.SimpleNamespace(jev_env=args.jev_env, jev_model="jev-latest", no_jev=False))
    resolver = load_deepseek(os.path.dirname(args.app))
    if jev is None or resolver is None:
        sys.exit("缺少 Jev 或 DeepSeek 凭据")
    backend = local_backend.Backend.__new__(local_backend.Backend)
    backend.jev, backend.tags = jev, local_backend.TagCache()
    log = {"meeting": os.path.basename(args.meeting), "app": args.app, "events": [], "errors": []}

    def timed(fn, *a):
        started = time.monotonic()
        try:
            return fn(*a), int((time.monotonic() - started) * 1000), None
        except Exception as e:  # noqa: BLE001 - a failed step is part of the report
            return None, int((time.monotonic() - started) * 1000), f"{type(e).__name__}: {str(e)[:200]}"

    # 1. tags, as the phone sends each final
    def tag(i):
        u = rows[i]
        req = {"session_id": "replay", "utterance_id": u["id"], "text": u["text"], "start_ms": u["start_ms"],
               "end_ms": u["end_ms"], "context": [x["text"][-120:] for x in rows[max(0, i - 4):i]]}
        return timed(backend.tag, req)
    with ThreadPoolExecutor(6) as pool:
        tags = list(pool.map(tag, range(len(rows))))
    for u, (result, ms, err) in zip(rows, tags):
        u["tag"] = (result or {}).get("tag")
        log["events"].append({"kind": "tag", "id": u["id"], "at_ms": u["end_ms"], "latency_ms": ms, "error": err,
                              "tag": u["tag"], "prob": (result or {}).get("prob"), "engine": (result or {}).get("engine"),
                              "task_clause": (result or {}).get("task_clause")})

    # 2. task drafts for commitments (the phone asks once the sentence is tagged)
    lines = [{"id": u["id"], "text": u["text"], "speaker": u.get("speaker")} for u in rows]
    commitments = [u for u in rows if u["tag"] == "commitment"]
    with ThreadPoolExecutor(4) as pool:
        drafts = list(pool.map(lambda u: timed(resolve_all, resolver, lines, u["id"], 12, 0, 30), commitments))
    for u, (tasks, ms, err) in zip(commitments, drafts):
        log["events"].append({"kind": "task", "id": u["id"], "at_ms": u["end_ms"], "latency_ms": ms, "error": err,
                              "tasks": tasks or []})

    # 3. conflicts between decisions/constraints of this meeting
    def brief(u):
        return {k: u[k] for k in ("id", "text", "start_ms", "end_ms")}

    previous = []
    for u in rows:
        if u["tag"] not in ("decision", "constraint"):
            continue
        if previous:
            req = {"kind": "conflict", "session_id": "replay", "utterance": brief(u), "previous": previous[-30:]}
            result, ms, err = timed(judge_notice, req, jev, local_backend.overlap, [])
            log["events"].append({"kind": "conflict", "id": u["id"], "at_ms": u["end_ms"], "latency_ms": ms,
                                  "error": err, "result": result})
        previous.append(brief(u))

    # 4. questions, through the same steps as the bot
    for item in question_watch.plan_meeting(rows, resolver, log=lambda _: None):
        log["events"].append(dict(item, kind="question"))

    # 5. minutes, as the bot writes them after the meeting
    fa = FeishuActions.__new__(FeishuActions)
    team = types.SimpleNamespace(data={"people": {n: None for n in local_backend.TEAM}})  # names only, no open_ids
    fa.backend = types.SimpleNamespace(resolver=resolver, people=team)
    row = {"utterances": rows, "started_at": args.started_at, "time_zone": "Asia/Shanghai"}
    minutes, ms, err = timed(fa.analyse, row)
    log["events"].append({"kind": "minutes", "at_ms": rows[-1]["end_ms"] + 90_000, "latency_ms": ms, "error": err,
                          "minutes": minutes})
    log["utterances"] = rows
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=1)
    counts = {}
    for e in log["events"]:
        counts[e["kind"]] = counts.get(e["kind"], 0) + 1
    print(json.dumps({"events": counts, "errors": sum(1 for e in log["events"] if e.get("error"))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
