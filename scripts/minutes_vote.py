#!/usr/bin/env python3
"""Steadier minutes: the model writes the minutes several times independently, and an item stays only when most
runs agree on it — the same decision or task, backed by overlapping sentences.

The bot (feishu_actions.FeishuActions.analyse) calls `vote` on the cleaned results of RUNS runs.
Topics are free text, so they are not voted item by item: the run whose topics agree most with the others is used.
"""
import re
import datetime as dt

RUNS = 3


def _chars(text):
    t = re.sub(r"[^\w]", "", str(text or "").lower())
    return {t[i:i + 2] for i in range(len(t) - 1)}


def same_item(a, b, text_key):
    """Two items from different runs are one when they cite overlapping sentences, or say nearly the same thing."""
    if text_key == 'title' and ('start' in a or 'start' in b):
        if schedule_key(a) != schedule_key(b):
            return False
    ids_a, ids_b = source_ids(a), source_ids(b)
    if ids_a & ids_b:
        return True
    x, y = _chars(a.get(text_key)), _chars(b.get(text_key))
    return bool(x and y) and len(x & y) / len(x | y) >= 0.5


def source_ids(item):
    return set(item.get('ids') or ([item['id']] if item.get('id') else []))


def schedule_key(item):
    try:
        start = dt.datetime.fromisoformat(str(item.get('start')).replace('Z', '+00:00'))
        if start.tzinfo is None:
            return None
        return start.astimezone(dt.timezone.utc).isoformat(), item.get('minutes')
    except (ValueError, TypeError):
        return None


def vote_follow_ups(runs, quorum):
    """Vote source-bound schedules; conflicting times remain human-review questions."""
    candidates = [(r, f) for r, run in enumerate(runs) for f in run.get('follow_ups', [])]
    conflicts = []
    for n, (r, a) in enumerate(candidates):
        for s, b in candidates[:n]:
            if r == s or not source_ids(a) & source_ids(b):
                continue
            if schedule_key(a) != schedule_key(b):
                ids = sorted(source_ids(a) | source_ids(b))
                if not any(set(c['ids']) == set(ids) for c in conflicts):
                    conflicts.append(dict(topic='日程时间或时长需核对',
                        views=f"{a.get('title', '安排')}：{a.get('start')} / {a.get('minutes')}分钟；"
                              f"{b.get('title', '安排')}：{b.get('start')} / {b.get('minutes')}分钟",
                        ids=ids))
    # One conflict applies to all copies of this source-bound event, including a third agreeing run.
    conflict_ids = set().union(*(set(c['ids']) for c in conflicts)) if conflicts else set()
    allowed = [[f for f in run.get('follow_ups', []) if schedule_key(f) is not None
                and not source_ids(f) & conflict_ids] for run in runs]
    return vote_items(allowed, 'title', quorum), conflicts


def vote_items(runs, text_key, quorum):
    """Items found in at least `quorum` runs, in the order they first appear; the wording of the most-agreed copy."""
    groups = []  # each: list of (run index, item)
    for r, items in enumerate(runs):
        for item in items:
            group = next((g for g in groups if all(r != gr for gr, _ in g) and any(same_item(item, gi, text_key) for _, gi in g)), None)
            if group is None:
                group = []
                groups.append(group)
            group.append((r, item))
    kept = []
    for g in groups:
        if len({r for r, _ in g}) < quorum:
            continue
        items = [it for _, it in g]
        best = max(items, key=lambda it: sum(same_item(it, other, text_key) for other in items))
        merged = dict(best)
        if "ids" in best:
            merged["ids"] = sorted({i for it in items for i in it.get("ids") or []}, key=lambda i: int(re.sub(r"\D", "", i) or 0))
        if text_key == "task" and not merged.get("owner"):  # an owner any agreeing run named is kept
            merged["owner"] = next((it["owner"] for it in items if it.get("owner")), "")
        if text_key == "task" and "priority" in best:  # main line when most agreeing runs say so
            merged["priority"] = "main" if sum(it.get("priority") == "main" for it in items) * 2 > len(items) else "other"
        kept.append(merged)
    return kept


def topic_agreement(run, others):
    mine = [_chars(t["topic"] + "".join(t["points"])) for t in run.get("topics") or []]
    score = 0.0
    for other in others:
        theirs = [_chars(t["topic"] + "".join(t["points"])) for t in other.get("topics") or []]
        for m in mine:
            score += max((len(m & t) / len(m | t) for t in theirs if m and t), default=0)
    return score


def vote(runs):
    """One result from several runs of the same minutes prompt (each already cleaned by analyse)."""
    runs = [r for r in runs if r]
    if not runs:
        return None
    if len(runs) == 1:
        return runs[0]
    quorum = len(runs) // 2 + 1
    base = max(runs, key=lambda r: topic_agreement(r, [o for o in runs if o is not r]))
    out = dict(base)
    out["decisions"] = vote_items([r["decisions"] for r in runs], "text", quorum)
    out["actions"] = vote_items([r["actions"] for r in runs], "task", quorum)
    out["undecided"] = vote_items([r.get("undecided") or [] for r in runs], "topic", quorum)
    out["open_questions"] = vote_items([r["open_questions"] for r in runs], "question", quorum)
    out["follow_ups"], conflicts = vote_follow_ups(runs, quorum)
    out["undecided"].extend(conflicts)
    substantive = sum(1 for r in runs if r["substantive"]) >= quorum
    useful = out["decisions"] or out["actions"] or out["topics"] or out["undecided"] or out["open_questions"] or out["follow_ups"]
    out["substantive"] = bool(useful) and substantive
    out["overview"] = base["overview"] if out["substantive"] else ""
    out["runs"] = len(runs)
    return out
