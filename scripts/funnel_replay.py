#!/usr/bin/env python3
"""A replayed meeting as a funnel: every sentence asks a few typed questions, and each question is settled by
code, Jev, DeepSeek or a person. The result drives public/funnel.html.

    funnel_replay.py build/replay-0238.json                    # → build/funnel-0238.json (gitignored, real meeting)
    funnel_replay.py --example                                 # → public/funnel-sample.json (labelled example)

Code forks are recomputed now with the backend's own rules (TextClean filler list, rules_tag, looks_like_question,
assess_item); Jev and DeepSeek forks come from the replay's recorded events and are never invented here. A fork
whose probability the replay did not record keeps p = null.

The "rules first" lens is an offline comparison only: it shows what the keyword rules would have settled before Jev
and how often Jev agreed. Nothing here changes how the live backend decides.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import filler_report  # noqa: E402
import local_backend  # noqa: E402
import question_watch  # noqa: E402
import minutes_items  # noqa: E402
from item_quality import assess_item, bounded_context  # noqa: E402
from meeting_features import review_queue  # noqa: E402

EXAMPLE = os.path.join(HERE, "funnel_example_replay.json")
SAMPLE_OUT = os.path.join(ROOT, "public", "funnel-sample.json")
SETTLE = 0.95  # a Jev answer at or above this needs nobody else
TAG_FLOOR = 0.5  # below this the backend reports "uncertain" (local_backend.jev_tag)
RETAINED = {"commitment", "decision", "constraint"}  # SessionIndex.RETAINED_TAGS: checked for conflicts
CLAUSE_TAGS = {"idea", "uncertain", "chitchat", "decision"}  # local_backend.tag: these get a per-clause task check
TAG_NAMES = {"commitment": "待办", "decision": "决定", "idea": "想法", "constraint": "约束",
             "chitchat": "寒暄", "uncertain": "说不准"}
VETO = {"example_or_hypothesis": "举例或假设", "negated_or_cancelled": "否定或取消", "already_completed": "已经做完",
        "generic_principle": "空泛的态度", "conditional_commitment_unconfirmed": "条件句，待确认",
        "evidence_missing": "找不到原话", "quantity_ambiguity": "数字含糊", "quantity_unit_conflict": "数字单位对不上",
        "unsupported_quantity": "多出原话没有的数字"}
OWNER_ROLES = {"speaker": "说话人自己", "addressee": "对方", "named": "点名", "unknown": "负责人不明"}
FILLER = filler_report.patterns(filler_report.filler_chars())[0]


def fork(layer, question, answer, p=None, ms=None, settled=False, **detail):
    assert layer in ("code", "jev", "model", "you")
    return dict(layer=layer, q=question, a=answer, p=None if p is None else round(float(p), 3),
                ms=None if ms is None else int(ms), settled=settled, **detail)


def question_fork(event):
    """DeepSeek decided whether the room needs a looked-up answer (question_watch.detect + Plan)."""
    final = event.get("final") or event.get("status")
    asked = (event.get("question") or "").strip()
    if final == "skip":
        why = {"internal": "团队自己的决定", "rhetorical": "举例或反问"}.get(event.get("detect_kind"), "不需要外部答案")
        return [fork("model", "值得替大家去查吗？", f"不用：{why}", settled=True)]
    if final == "repeat":
        return [fork("model", "值得替大家去查吗？", f"和 {event.get('same_as')} 是同一个问题", settled=True)]
    forks = [fork("model", "值得替大家去查吗？", f"查：{asked}" if asked else "查", value=event.get("value"),
                  how=event.get("how"))]
    if final == "answered":
        forks.append(fork("model", "会上有人答了吗？", "已经答了，不打扰", settled=True))
    elif final in ("release", "research_late", "quick"):
        forks.append(fork("you", "要把答案给你看吗？", "会上没人答，答案推给你", settled=True))
    return forks


def task_forks(event, sentence_text):
    tasks = [t for t in event.get("tasks") or [] if t.get("is_task", True)]
    if not tasks:
        return [fork("model", "整理成能执行的待办", "没有可执行的待办", ms=event.get("latency_ms"), settled=True)]
    out = []
    for t in tasks:
        owner = t.get("owner_name") or OWNER_ROLES.get(t.get("owner_role"), "负责人不明")
        due = f" · {t['due_raw']}" if t.get("due_raw") else ""
        out.append(fork("model", "整理成能执行的待办", f"{t.get('what', '').strip()} · {owner}{due}",
                        ms=event.get("latency_ms"), quote=t.get("task_quote")))
        need = "选负责人后确认" if owner == "负责人不明" else "确认后才建任务"
        out.append(fork("you", "这件事要你点头吗？", f"{need}：{t.get('what', '').strip()}", settled=True))
    return out


def sentence_forks(u, events):
    text = u["text"]
    forks = []
    if FILLER.fullmatch(text):
        return [fork("code", "只是语气词？", "是，隐藏，不再往下问", settled=True)], None
    forks.append(fork("code", "只是语气词？", "否"))

    tag_event = events.get(("tag", u["id"]))
    tag = None
    if tag_event and not tag_event.get("error"):
        tag, prob, engine = tag_event.get("tag"), tag_event.get("prob"), tag_event.get("engine") or ""
        if engine.endswith("+clauses"):
            # The whole sentence was not a task; one clause was (local_backend.tag). The first answer's p is not kept.
            forks.append(fork("jev", "这句话是什么？", "整句不是待办，拆小句再问", ms=tag_event.get("latency_ms")))
            forks.append(fork("jev", "小句里有待办吗？", f"有：「{(tag_event.get('task_clause') or '').strip()}」",
                              p=prob, settled=prob is not None and prob >= SETTLE))
        else:
            label = TAG_NAMES.get(tag, tag)
            if prob is not None and prob < TAG_FLOOR:
                label = f"说不准（最高 {prob:.2f}）"
            forks.append(fork("jev", "这句话是什么？", label, p=prob, ms=tag_event.get("latency_ms"),
                              settled=prob is not None and prob >= SETTLE))
            if tag in CLAUSE_TAGS and len(text) >= 6:
                forks.append(fork("jev", "小句里有待办吗？", "没有"))
    elif tag_event:
        forks.append(fork("code", "Jev 没回，规则兜底", TAG_NAMES.get(local_backend.rules_tag(text)["tag"])))

    if tag == "commitment":
        title = (tag_event.get("task_clause") or text).strip()
        quality = assess_item(title, [dict(id=u["id"], text=text)], [dict(id=u["id"], text=text)])
        if quality["status"] == "accepted":
            forks.append(fork("code", "这个待办站得住吗？", "有出处、可执行"))
        else:
            forks.append(fork("code", "这个待办站得住吗？", f"否决：{VETO.get(quality['reason'], quality['reason'])}", settled=True))
            tag = "uncertain"

    if question_watch.looks_like_question(text):
        forks.append(fork("code", "像在提问吗？", "像，交给 DeepSeek 判断"))
        q_event = events.get(("question", u["id"]))
        if q_event:
            forks.extend(question_fork(q_event))

    c_event = events.get(("conflict", u["id"]))
    if c_event and not c_event.get("error"):
        result = c_event.get("result") or {}
        if result.get("conflict"):
            other = (result.get("with") or {}).get("id", "之前")
            forks.append(fork("jev", "和之前说的矛盾吗？", f"可能和 {other} 矛盾", p=result.get("prob"),
                              ms=c_event.get("latency_ms"), with_id=other))
            forks.append(fork("you", "要提醒你吗？", f"轻震提醒：可能和 {other} 矛盾", settled=True))
        else:
            forks.append(fork("jev", "和之前说的矛盾吗？", "不矛盾", p=result.get("prob"), ms=c_event.get("latency_ms"),
                              settled=(result.get("prob") or 0) >= SETTLE))

    t_event = events.get(("task", u["id"]))
    if t_event and not t_event.get("error") and tag == "commitment":
        forks.extend(task_forks(t_event, text))
    return forks, tag


ORDER = {"code": 0, "jev": 1, "model": 2, "you": 3}
KEPT = {"idea": "想法，记下", "chitchat": "寒暄，不处理", "uncertain": "说不准，先记下", "decision": "决定，记下",
        "constraint": "约束，记下", "commitment": "待办，记下"}
ASKS = {"这件事要你点头吗？": "待办，等你确认", "要提醒你吗？": "可能矛盾，提醒你", "要把答案给你看吗？": "查到答案，推给你"}


def outcome(forks, tag):
    """Where the sentence stops: the exit it takes at its deepest layer."""
    if len(forks) == 1 and forks[0]["settled"] and forks[0]["q"] == "只是语气词？":
        return "语气词，隐藏"
    asks = [f for f in forks if f["layer"] == "you"]
    if asks:
        return ASKS.get(asks[0]["q"], "交给你")
    model = [f["a"] for f in forks if f["layer"] == "model"]
    if model:
        last = model[-1]
        for prefix, label in (("不用", "不需要查"), ("和 ", "重复的问题"), ("已经答了", "会上已答"),
                              ("没有可执行", "没整理出待办")):
            if last.startswith(prefix):
                return label
        return "DeepSeek 已处理"
    if any(f["layer"] == "code" and f["a"].startswith("否决") for f in forks):
        return "待办被规则否决"
    return KEPT.get(tag, "规则兜底")



QUALITY = {"accepted": "通过", "needs_review": "待人核对", "rejected": "否决"}


def post_meeting(replay):
    """After the meeting: DeepSeek's minutes → items (minutes_items) → rules check (item_quality) → review order
    (review_queue). Only the minutes come from a model; the other three steps are the backend's own code."""
    event = next((e for e in replay.get("events", []) if e.get("kind") == "minutes" and not e.get("error")
                  and isinstance(e.get("minutes"), dict)), None)
    if not event:
        return None
    minutes = event["minutes"]
    rows = [dict(id=u["id"], text=u["text"]) for u in replay["utterances"]]
    by_id = {r["id"]: r for r in rows}
    items = []
    for item in minutes_items.build(minutes):
        ids = [i for i in item["ids"] if i in by_id]
        if not ids:
            continue
        evidence = [by_id[i] for i in ids]
        check = assess_item(item["title"], evidence, bounded_context(rows, ids), kind=item["kind"],
                            detail=item.get("detail", ""))
        items.append(dict(id=item["id"], kind=item["kind"], title=item["title"], ids=ids,
                          owner=item.get("owner_hint") or "", due=item.get("due") or "",
                          quality=dict(status=check["status"], label=QUALITY.get(check["status"], check["status"]),
                                       reason=VETO.get(check["reason"], "有原话依据" if check["status"] == "accepted"
                                                       else check["reason"]))))
    cited = dict(tasks=[i for it in items if it["kind"] == "task" for i in it["ids"]],
                 decisions=[i for it in items if it["kind"] == "decision" for i in it["ids"]])
    queue = review_queue(replay["utterances"], cited)
    return dict(latency_ms=event.get("latency_ms"), overview=minutes.get("overview") or "",
                topics=[t.get("topic") for t in minutes.get("topics") or [] if t.get("topic")],
                items=items, queue=queue)


def build(replay, label, kind, note=""):
    events = {}
    for e in replay.get("events", []):
        if e.get("id"):
            events[(e["kind"], e["id"])] = e
    sentences, lens = [], dict(rules_decided=0, agree=0, disagree=0, cases=[])
    for u in replay["utterances"]:
        forks, tag = sentence_forks(u, events)
        route = max((f["layer"] for f in forks), key=ORDER.get)
        sentences.append(dict(id=u["id"], start_ms=u["start_ms"], end_ms=u["end_ms"], speaker=u.get("speaker"),
                              text=u["text"], tag=tag, route=route, outcome=outcome(forks, tag), forks=forks))
        rules = local_backend.rules_tag(u["text"])["tag"]
        recorded = (events.get(("tag", u["id"])) or {}).get("tag")
        if rules != "uncertain" and recorded:
            lens["rules_decided"] += 1
            same = rules == recorded
            lens["agree" if same else "disagree"] += 1
            lens["cases"].append(dict(id=u["id"], rules=rules, jev=recorded, agree=same))
    shaped = [s for s in sentences if any(f["q"] == "像在提问吗？" for f in s["forks"])]
    lens["question_shape"] = len(shaped)
    lens["question_skipped"] = sum(1 for s in shaped if any(f["a"].startswith(("不用", "和 ")) for f in s["forks"]))
    session = []
    for e in replay.get("events", []):
        if e.get("kind") == "minutes" and not e.get("error"):
            session.append(dict(at_ms=e["at_ms"], fork=fork("model", "整理本场纪要", (e.get("minutes") or {}).get(
                "overview") or "纪要已生成", ms=e.get("latency_ms"), settled=True)))
    last = max((u["end_ms"] for u in replay["utterances"]), default=0)
    return dict(version=1, source=dict(kind=kind, label=label, note=note, sentences=len(sentences),
                                       duration_ms=last), post=post_meeting(replay),
                thresholds=dict(settle=SETTLE, tag_floor=TAG_FLOOR), sentences=sentences, session=session,
                lens=lens)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("replay", nargs="?", help="build/replay-*.json")
    parser.add_argument("--example", action="store_true", help="write the labelled example to public/funnel-sample.json")
    parser.add_argument("-o", "--output")
    args = parser.parse_args(argv)
    if args.example == bool(args.replay):
        parser.error("give one replay file, or --example")
    if args.example:
        with open(EXAMPLE, encoding="utf-8") as stream:
            replay = json.load(stream)
        data = build(replay, replay.get("label", "示例会议"), "example",
                     "示例数据：文字与 Jev / DeepSeek 结果为演示编写；规则岔口由当前后端代码实时算出。")
        out = args.output or SAMPLE_OUT
    else:
        with open(args.replay, encoding="utf-8") as stream:
            replay = json.load(stream)
        name = os.path.splitext(os.path.basename(args.replay))[0].replace("replay-", "")
        data = build(replay, f"回放 {name}", "replay",
                     "真实会议回放：Jev / DeepSeek 结果来自回放记录；规则岔口用当前代码重算。仅限本机查看，不要提交或发布。")
        out = args.output or os.path.join(ROOT, "build", f"funnel-{name}.json")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
    counts = {k: sum(1 for s in data["sentences"] for f in s["forks"] if f["layer"] == k) for k in ORDER}
    print(f"{out}: {len(data['sentences'])} 句 · 岔口 {sum(counts.values())} · " +
          " · ".join(f"{k} {v}" for k, v in counts.items()))


if __name__ == "__main__":
    main()
