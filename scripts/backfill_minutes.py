#!/usr/bin/env python3
"""Write minutes for past meetings that never got any (most ended before the bot existed), so the App can show them.

    systemctl stop oops-backend          # the bot keeps its state in memory; it must not run meanwhile
    sudo -u oops sh -c 'set -a; . /var/lib/oops/backend.env; set +a; \\
        /opt/oops/venv/bin/python backfill_minutes.py --state-dir /var/lib/oops/backend --dry-run'
    systemctl start oops-backend

Only stores the minutes (the same voted analysis the bot writes, with its source fingerprint); nothing is sent to
Feishu, and meetings that already have minutes are left alone. A meeting qualifies when its id is a random UUID
(real, not a smoke test), it has at least 5 sentences, it is over (reported ended, or started more than a day ago),
and it has no stored minutes.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import types

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--state-dir", required=True)
    p.add_argument("--people", help="people.json with the team (default: <state-dir>/../people.json)")
    p.add_argument("--dry-run", action="store_true", help="list what would be written")
    args = p.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    import feishu_actions as fa
    from meeting_features import Meetings
    from task_resolver import load_deepseek

    people_path = args.people or os.path.join(os.path.dirname(args.state_dir.rstrip("/")), "people.json")
    people = json.load(open(people_path, encoding="utf-8")) if os.path.isfile(people_path) else {}
    meetings = Meetings(os.path.join(args.state_dir, "meetings"))
    state = fa.State(os.path.join(args.state_dir, "feishu"))
    model = load_deepseek(os.path.dirname(here))
    if model is None and not args.dry_run:
        sys.exit("没有可用的 DeepSeek 凭据")
    bot = fa.FeishuActions.__new__(fa.FeishuActions)  # analysis only: no Feishu client, nothing is sent
    bot.backend = types.SimpleNamespace(resolver=model, people=types.SimpleNamespace(data=people), meetings=meetings)
    bot.state, bot.log = state, print
    for name in sorted(os.listdir(meetings.dir)):
        sid = name[:-5]
        if not name.endswith(".json") or not UUID.fullmatch(sid) or state.get("meetings", sid, "analysis"):
            continue
        row = meetings.load(sid)
        started = fa.parse_ts(row["started_at"]) if row.get("started_at") else None
        old = started is not None and started < dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=1)
        if len(row["utterances"]) < 5 or not (row.get("ended_at") or row.get("last_sync_at") or old):
            continue
        print(f"{sid[:8]} {row.get('started_at', '')[:16]} {len(row['utterances'])} 句", flush=True)
        if args.dry_run:
            continue
        fingerprint = bot.minutes_fingerprint(row)
        analysis = bot.analyse(row)
        with state.lock:
            state.put(analysis, "meetings", sid, "analysis")
            state.put(fingerprint, "meetings", sid, "analysis_fingerprint")
            state.put(True, "meetings", sid, "backfilled")
        print(f"    主题：{analysis.get('theme') or '（没有实质内容）'}；决定 {len(analysis['decisions'])}，"
              f"主线 {sum(a.get('priority') == 'main' for a in analysis['actions'])}，其他 {sum(a.get('priority') != 'main' for a in analysis['actions'])}",
              flush=True)


if __name__ == "__main__":
    main()
