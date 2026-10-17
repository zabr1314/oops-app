#!/usr/bin/env python3
"""Steadier minutes: the model writes the minutes several times independently, and an item stays only when most
runs agree on it — the same decision or task, backed by overlapping sentences.

The bot (feishu_actions.FeishuActions.analyse) calls `vote` on the cleaned results of RUNS runs.
Topics are free text, so they are not voted item by item: the run whose topics agree most with the others is used.
"""
import re
import datetime as dt
from difflib import SequenceMatcher

RUNS = 3


def _chars(text):
    t = re.sub(r"[^\w]", "", str(text or "").lower())
    return {t[i:i + 2] for i in range(len(t) - 1)}


# Only common, explicit operations: these are conflict guards, not a semantic model.
_OPERATIONS = (
    ('upload', r'上传|上载'), ('download', r'下载'),
    ('remove', r'删除|移除|清除'), ('retain', r'保留|保存|存档'),
    ('enable', r'采用|启用|开启|启动'), ('disable', r'停用|禁用|关闭|停止'),
    ('add', r'增加|添加|新增|创建'), ('change', r'修改|更新|调整'),
)
_NEGATED = re.compile(
    r'(?:不(?:再|要|用|需|应|得|能)?|无需|取消|拒绝|放弃|暂缓|否决)(?:再|去|来)?(?:'
    + '|'.join(pattern for _, pattern in _OPERATIONS)
    + r'|做|开发|实现|完成|列|整理|梳理|核对|确认|修复|发送|提交|交付|采购|购买|预订|使用|支持|允许)')


def _wording(text):
    value = re.sub(r'[^\w]', '', str(text or '').lower())
    # Ignore common insertion/reordering in Chinese paraphrases, without deleting negation.
    value = re.sub(r'首先|先把|先将|把|将|进行|一下|出来', '', value)
    return re.sub(r'列出|列举|罗列', '列', value)


def _wording_conflicts(a, b):
    if bool(_NEGATED.search(a)) != bool(_NEGATED.search(b)):
        return True
    operations_a = {name for name, pattern in _OPERATIONS if re.search(pattern, a)}
    operations_b = {name for name, pattern in _OPERATIONS if re.search(pattern, b)}
    # A shared generic operation (such as updating) cannot hide uploading vs deleting.
    return bool(operations_a - operations_b and operations_b - operations_a)


def item_similarity(a, b, text_key):
    """Shared evidence supports a paraphrase; it never substitutes for matching its wording."""
    if text_key == 'title' and ('start' in a or 'start' in b):
        if schedule_key(a) != schedule_key(b):
            return 0.0
    left, right = _wording(a.get(text_key)), _wording(b.get(text_key))
    if not left or not right or _wording_conflicts(left, right):
        return 0.0
    if left == right:
        return 1.0
    x, y = _chars(left), _chars(right)
    if not x or not y:
        return 0.0
    overlap = len(x & y)
    jaccard = overlap / len(x | y)
    sequence = SequenceMatcher(None, left, right, autojunk=False).ratio()
    shared_source = bool(source_ids(a) & source_ids(b))
    # Character sequences tolerate Chinese insertions; bigrams still require a shared phrase,
    # so a common source or a few scattered characters alone cannot establish agreement.
    if jaccard >= 0.5 or shared_source and 2 * overlap / (len(x) + len(y)) >= 0.35 and sequence >= 0.5:
        return (jaccard + sequence) / 2
    return 0.0


def same_item(a, b, text_key):
    return item_similarity(a, b, text_key) > 0


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
            matches = []
            for g in groups:
                if any(r == gr for gr, _ in g):
                    continue
                scores = [item_similarity(item, gi, text_key) for _, gi in g]
                # Complete linkage prevents A~B~C from treating incompatible A/C as one item.
                if all(scores):
                    matches.append((min(scores), sum(scores) / len(scores), g))
            group = max(matches, key=lambda match: match[:2])[2] if matches else None
            if group is None:
                group = []
                groups.append(group)
            group.append((r, item))
    kept = []
    for g in groups:
        if len({r for r, _ in g}) < quorum:
            continue
        items = [it for _, it in g]
        best = max(items, key=lambda it: sum(item_similarity(it, other, text_key) for other in items))
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
