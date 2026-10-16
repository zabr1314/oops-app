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
import datetime as dt
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import minutes_items  # noqa: E402
import minutes_vote  # noqa: E402
from item_quality import assess_item, bounded_context  # noqa: E402

EXAMPLE = os.path.join(HERE, "funnel_example_replay.json")
SAMPLE_OUT = os.path.join(ROOT, "public", "funnel-sample.json")
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
def offline_rules():
    # History reads need only deterministic minutes modules, not the backend or model clients.
    import filler_report
    import local_backend
    import question_watch
    return filler_report.patterns(filler_report.filler_chars())[0], local_backend, question_watch


def fork(layer, question, answer, p=None, ms=None, settled=False, provenance=None, **detail):
    assert layer in ("code", "jev", "model", "you", "unknown")
    p = p if type(p) in (int, float) and math.isfinite(p) and 0 <= p <= 1 else None
    ms = ms if type(ms) in (int, float) and math.isfinite(ms) and ms >= 0 else None
    return dict(layer=layer, q=question, a=answer, p=None if p is None else round(float(p), 3),
                ms=None if ms is None else int(ms), settled=settled,
                provenance=provenance or ("recomputed" if layer == "code" else "required" if layer == "you" else "recorded"),
                **detail)


def current_pipeline():
    """Current source configuration, never proof of what a past meeting ran."""
    return dict(scope="local_source", label="当前工作区源码；不代表生产或历史调用配置", tag_floor=TAG_FLOOR, tag_source="local_backend.jev_tag", auto_settle_threshold=None,
                in_meeting_research=False, research_source="feishu_actions.tick_meeting",
                minutes_mode="majority_vote", minutes_configured_runs=minutes_vote.RUNS,
                minutes_source="feishu_actions.analyse", review_mode="minutes_items.queue")


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
    """Recorded answers and explicitly labelled current rule comparisons stay separate."""
    filler_pattern, _, question_watch = offline_rules()
    text = u["text"]
    filler = bool(filler_pattern.fullmatch(text))
    forks = [fork("code", "当前规则：只是语气词？", "是，当前会隐藏" if filler else "否",
                  settled=filler)]
    tag_event = events.get(("tag", u["id"]))
    tag = None
    if tag_event and not tag_event.get("error"):
        tag, prob = tag_event.get("tag"), tag_event.get("prob")
        engine = tag_event.get("engine") or ""
        # Do not invent the first answer or a negative clause check from the final upgraded tag.
        layer = "code" if engine == "rules" else "jev" if engine.lower().startswith("jev") else "unknown"
        answer = TAG_NAMES.get(tag, tag) or "未记录分类"
        if tag_event.get("task_clause"):
            answer += f" · 待办小句：「{tag_event['task_clause'].strip()}」"
        forks.append(fork(layer, "这句话的分类记录", answer, p=prob, ms=tag_event.get("latency_ms"),
                          provenance="recorded", engine=engine, task_clause=tag_event.get("task_clause")))
        if tag == "commitment":
            quality = assess_item(tag_event.get("task_clause") or text,
                                  [dict(id=u["id"], text=text)], [dict(id=u["id"], text=text)])
            forks.append(fork("code", "当前规则：待办依据够吗？",
                              "有出处、待人核对" if quality["status"] == "accepted"
                              else f"当前规则提示：{VETO.get(quality['reason'], quality['reason'])}"))
    elif tag_event:
        forks.append(fork("jev", "分类调用记录", "调用失败；没有可用分类结果", provenance="recorded"))

    q_event = events.get(("question", u["id"]))
    if q_event and not q_event.get("error"):
        forks.extend(question_fork(q_event))
        for f in forks:
            if f["q"] in ("值得替大家去查吗？", "会上有人答了吗？", "要把答案给你看吗？"):
                f["historical_only"] = True
    elif question_watch.looks_like_question(text):
        forks.append(fork("code", "当前规则：像在提问吗？", "像；本地工作区已停用自动研究，生产配置另核对"))

    c_event = events.get(("conflict", u["id"]))
    if c_event and not c_event.get("error"):
        result = c_event.get("result") or {}
        other = (result.get("with") or {}).get("id", "之前")
        engine = result.get("engine") or ""
        forks.append(fork("code" if engine == "rules" else "jev" if engine.lower().startswith("jev") else "unknown", "矛盾检测记录",
                          f"可能和 {other} 矛盾" if result.get("conflict") else "未发现矛盾",
                          p=result.get("prob"), ms=c_event.get("latency_ms"), provenance="recorded",
                          engine=engine, with_id=other if result.get("conflict") else None))
    t_event = events.get(("task", u["id"]))
    if t_event and not t_event.get("error"):
        forks.extend(task_forks(t_event, text))
    return forks, tag


ORDER = {"unknown": -1, "code": 0, "jev": 1, "model": 2, "you": 3}
KEPT = {"idea": "想法，记下", "chitchat": "寒暄，不处理", "uncertain": "说不准，先记下", "decision": "决定，记下",
        "constraint": "约束，记下", "commitment": "待办，记下"}
ASKS = {"这件事要你点头吗？": "待办，等你确认", "要提醒你吗？": "可能矛盾，提醒你", "要把答案给你看吗？": "查到答案，推给你"}


def outcome(forks, tag):
    """Where the sentence stops: the exit it takes at its deepest layer."""
    if len(forks) == 1 and forks[0]["settled"] and forks[0]["q"] == "当前规则：只是语气词？":
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
    return KEPT.get(tag, "历史分类未记录")



QUALITY = {"accepted": "通过", "needs_review": "待人核对", "rejected": "否决"}


def recorded_timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        return value if dt.datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo else None
    except ValueError:
        return None


def post_handoffs(post):
    """Logical presentation order, never fabricated historical events or timing."""
    generation = post.get("generation") or {}
    example = generation.get("evidence") == "example"
    rerun = generation.get("evidence") == "reused_history"
    scope = "example" if example else "jev_only" if rerun else "historical"
    summary = post.get("record_summary") or {}
    review, delivery = summary.get("review") or {}, post.get("delivery_record") or {}
    items = post.get("items") or []
    count = lambda value: value if type(value) is int and value >= 0 else None
    kinds = {kind: sum(item.get("kind") == kind for item in items) for kind in ("task", "decision", "open")}
    def stage(key, role, label, provenance, status, counts, note, recorded_at=None, latency_ms=None):
        return dict(id=key, role=role, label=label, provenance=provenance, status=status, counts=counts,
                    note=note, recorded_at=recorded_timestamp(recorded_at), latency_ms=count(latency_ms),
                    evidence_scope="example" if example else "current_projection" if provenance == "recomputed" else "historical",
                    run_scope="example" if example else "recomputed" if provenance == "recomputed" else "not_run" if rerun else "historical")
    query_count = count(summary.get("query_records"))
    review_count = sum(count(review.get(key)) or 0 for key in ("confirmed", "rejected", "merged"))
    has_delivery = any(type(delivery.get(key)) is bool for key in ("document_created", "ledger_written", "done")) or count(delivery.get("sent_receipts")) is not None
    receipts = count(delivery.get("sent_receipts"))
    stages = [
        stage("minutes", "minutes", "已有纪要", "reused" if rerun else "recorded", "available",
              dict(items=len(items), tasks=kinds["task"], decisions=kinds["decision"], open_questions=kinds["open"],
                   successful_runs=count(generation.get("successful_runs")), recorded_calls=count(generation.get("recorded_calls"))),
              "复用原有纪要，本次 Jev 重新分析没有重新生成。" if rerun else "读取已存纪要；成功份数不等于实际尝试调用数。",
              generation.get("recorded_at"), generation.get("latency_ms", post.get("latency_ms"))),
        stage("evidence", "minutes", "对应原话依据", "recomputed", "projected", dict(items=len(items),
              cited_sentences=len({uid for item in items for uid in item.get("ids") or []})),
              "当前代码把已有纪要事项对应到仍有效的原话，不代表历史模型逐句阅读。"),
        stage("current_rules", "review", "规则复核", "recomputed", "projected",
              {key: sum((item.get("quality") or {}).get("status") == key for item in items)
               for key in ("accepted", "needs_review", "rejected")},
              "当前确定性规则复核；通过不等于人工确认，也不代表任务已完成。"),
        stage("research", "query", "资料查询", "recorded" if query_count else "missing",
              "recorded_summary" if query_count else "not_recorded", dict(records=query_count),
              "只有已存问题记录摘要，未据此推定查询成功、外部来源或事件时间。" if query_count else "未保存本场资料查询的执行过程或结果，不能推定已查或未查。"),
        stage("review", "review", "人工核对", "recorded" if review_count else "missing",
              "recorded_summary" if review_count else "not_recorded",
              {key: count(review.get(key)) for key in ("confirmed", "rejected", "merged", "pending", "stale")},
              "仅统计与当前事项及原话版本一致的人工核对；不自动确认。" if review_count else "没有与当前事项版本一致的人工核对记录；规则通过不能替代人工核对。"),
        stage("delivery", "delivery", "飞书投递", "recorded" if has_delivery else "missing",
              "historical_receipt" if receipts else "recorded_summary" if has_delivery else "not_recorded",
              dict(sent_receipts=receipts, document_created=delivery.get("document_created"),
                   ledger_written=delivery.get("ledger_written"), done=delivery.get("done")),
              ("仅有历史回执摘要，不含收件人或链接；不代表本次重新分析发送。" if has_delivery else
               "没有保存本场飞书投递回执；不能显示已发送。") + (" 本次 Jev 重新分析未创建文档或发送。" if rerun else "")),
    ]
    return dict(version=1, order="presentation", chronology="not_recorded", run_scope=scope, stages=stages,
                note="工位按阅读顺序展示；不是已证实的历史执行顺序。未记录的时间留空，播放不会查询、生成、核对或发送。")


def post_from_minutes(minutes, utterances, generation=None, row=None, latency_ms=None, delivery_record=None,
                      historical_records=None):
    """Read stored minutes, then show today's deterministic item checks, not past model internals."""
    rows = [dict(id=u["id"], text=u["text"]) for u in utterances]
    by_id = {r["id"]: r for r in rows}
    base = minutes_items.build(minutes)
    items = []
    for item in base:
        ids = [i for i in item["ids"] if i in by_id]
        if not ids:
            continue
        check = assess_item(item["title"], [by_id[i] for i in ids], bounded_context(rows, ids),
                            kind=item["kind"], detail=item.get("detail", ""))
        items.append(dict(id=item["id"], kind=item["kind"], title=item["title"], ids=ids,
                          owner=item.get("owner_hint") or "", due=item.get("due") or "",
                          quality=dict(status=check["status"], label=QUALITY.get(check["status"], check["status"]),
                                       provenance="recomputed", reason=VETO.get(check["reason"],
                                       "有原话依据" if check["status"] == "accepted" else check["reason"]))))
    meeting = dict(row or {}, utterances=utterances)
    presented = minutes_items.present(base, meeting)
    by_item = {i["id"]: i for i in items}
    queue = [dict(q, ids=by_item[q["id"]]["ids"]) for q in minutes_items.queue(presented) if q["id"] in by_item]
    delivery = None
    if isinstance(delivery_record, dict):
        delivery = {key: value if type(value) is bool else None for key in
                    ("document_created", "ledger_written", "done") for value in [delivery_record.get(key)]}
        sent = delivery_record.get("sent_receipts")
        delivery["sent_receipts"] = sent if type(sent) is int and sent >= 0 else None
    review_summary = {key: sum((item.get("review") or {}).get("status") == key for item in presented)
                      for key in ("confirmed", "rejected", "merged")}
    review_summary.update(pending=len(queue), stale=sum(bool(item.get("stale_review")) for item in presented))
    query_count = (historical_records or {}).get("query_records")
    query_count = query_count if type(query_count) is int and query_count >= 0 else None
    post = dict(latency_ms=latency_ms, overview=minutes.get("overview") or "",
                topics=[t.get("topic") for t in minutes.get("topics") or [] if t.get("topic")],
                generation=generation or dict(recorded_calls=None, configured_runs=minutes_vote.RUNS,
                                              mode="majority_vote", evidence="stored"),
                delivery_record=delivery, derivation="recomputed", items=items, queue=queue,
                record_summary=dict(query_records=query_count, review=review_summary))
    post["handoffs"] = post_handoffs(post)
    return post


def post_meeting(replay):
    event = next((e for e in replay.get("events", []) if e.get("kind") == "minutes" and not e.get("error")
                  and isinstance(e.get("minutes"), dict)), None)
    if not event:
        return None
    calls = event.get("model_calls")
    return post_from_minutes(event["minutes"], replay["utterances"],
                             generation=dict(recorded_calls=calls if type(calls) is int and calls >= 0 else None,
                                             configured_runs=minutes_vote.RUNS, mode="majority_vote", evidence="recorded"),
                             latency_ms=event.get("latency_ms"),
                             historical_records=dict(query_records=sum(e.get("kind") == "question" for e in replay.get("events", []))))


def build(replay, label, kind, note=""):
    _, local_backend, question_watch = offline_rules()
    events = {}
    for e in replay.get("events", []):
        if e.get("id"):
            events[(e["kind"], e["id"])] = e
    sentences, lens = [], dict(rules_decided=0, agree=0, disagree=0, cases=[])
    for u in replay["utterances"]:
        forks, tag = sentence_forks(u, events)
        route = max((f["layer"] for f in forks if f["provenance"] != "recomputed"), key=ORDER.get, default="unknown")
        if len(forks) == 1 and forks[0]["settled"]:
            route = "code"
        if kind == "example":
            for f in forks:
                if f["provenance"] == "recorded":
                    f["provenance"] = "example"
        sentences.append(dict(id=u["id"], start_ms=u["start_ms"], end_ms=u["end_ms"], speaker=u.get("speaker"),
                              text=u["text"], tag=tag, route=route, outcome=outcome(forks, tag), forks=forks))
        rules = local_backend.rules_tag(u["text"])["tag"]
        recorded = (events.get(("tag", u["id"])) or {}).get("tag")
        if rules != "uncertain" and recorded:
            lens["rules_decided"] += 1
            same = rules == recorded
            lens["agree" if same else "disagree"] += 1
            lens["cases"].append(dict(id=u["id"], rules=rules, jev=recorded, agree=same))
    shaped = [s for s in sentences if question_watch.looks_like_question(s["text"])]
    lens["question_shape"] = len(shaped)
    lens["question_skipped"] = sum(1 for s in shaped if any(f["a"].startswith(("不用", "和 ")) for f in s["forks"]))
    session = []
    for e in replay.get("events", []):
        if e.get("kind") == "minutes" and not e.get("error"):
            session.append(dict(at_ms=e.get("at_ms", 0), fork=fork("model", "整理本场纪要", (e.get("minutes") or {}).get(
                "overview") or "纪要已生成", ms=e.get("latency_ms"), settled=True,
                provenance="example" if kind == "example" else "recorded")))
    last = max((u["end_ms"] for u in replay["utterances"]), default=0)
    post = post_meeting(replay)
    if kind == "example" and post:
        post["generation"]["evidence"] = "example"
        post["handoffs"] = post_handoffs(post)
    return dict(version=2, pipeline=current_pipeline(), source=dict(kind=kind, label=label, note=note, sentences=len(sentences),
                                       duration_ms=last), post=post,
                thresholds=dict(tag_floor=TAG_FLOOR), sentences=sentences, session=session,
                lens=lens)


def stored_trace_forks(trace):
    """Render actual saved stages; a final tag never stands in for earlier model answers."""
    result = trace.get("result") or {}
    stages = trace.get("stages") or []
    out = []
    for stage in stages:
        kind = stage.get("kind")
        value = stage.get("result") or {}
        engine = value.get("engine") or ""
        layer = stage.get("layer") if stage.get("layer") in ("code", "jev") else "unknown"
        question = {"whole_tag": "整句分类记录", "rules_fallback": "规则回退记录", "rules_tag": "规则分类记录",
                    "task_clauses": "待办小句核对记录", "task_quality": "待办规则复核记录"}.get(kind)
        if not question:
            continue
        if stage.get("status") == "failed":
            answer = "该步失败" + (" · " + str(stage["error_type"]) if stage.get("error_type") else "")
            probability = None
        elif kind == "task_clauses":
            selected = stage.get("selected")
            match = next((c for c in stage.get("clauses") or [] if c.get("text") == selected), None)
            probability = match.get("yes_prob") if match else None
            answer = "选中：「" + selected + "」" if selected else "没有选中待办小句"
            if type(stage.get("threshold")) in (float, int):
                answer += " · 该步记录门槛 " + str(stage["threshold"])
        elif kind == "task_quality":
            probability = None
            answer = QUALITY.get(value.get("status"), value.get("status")) or "未记录规则结果"
            if value.get("reason"):
                answer += " · " + VETO.get(value["reason"], value["reason"])
            if stage.get("final_tag"):
                answer += " · 最终分类 " + TAG_NAMES.get(stage["final_tag"], stage["final_tag"])
        else:
            probability = value.get("prob")
            answer = TAG_NAMES.get(value.get("tag"), value.get("tag")) or "未记录分类结果"
        out.append(fork(layer, question, answer, p=probability, ms=stage.get("latency_ms"),
                        provenance="recorded", engine=engine, recorded_at=trace.get("recorded_at"),
                        task_clause=stage.get("selected") if kind == "task_clauses" else None))
    if out:
        return out
    engine = result.get("engine") or ""
    layer = "code" if engine == "rules" else "jev" if engine.lower().startswith("jev") else "unknown"
    timing = result.get("timing_ms") or {}
    out.append(fork(layer, "这句话的分类记录", TAG_NAMES.get(result.get("tag"), result.get("tag")) or "未记录分类",
                    p=result.get("prob"), ms=timing.get("jev_ms"), provenance="recorded", engine=engine,
                    task_clause=result.get("task_clause"), recorded_at=trace.get("recorded_at"),
                    context=trace.get("validated_context") or []))
    if result.get("task_quality"):
        q = result["task_quality"]
        out.append(fork("code", "当时的待办规则复核", VETO.get(q.get("reason"), q.get("reason")) or q.get("status"),
                        provenance="recorded"))
    return out


def build_stored(row, minutes_view, traces=()):
    """Read historical stored data only. Missing Jev probability/engine stays missing."""
    utterances = row.get("utterances") or []
    by_trace = {t["id"]: t for t in traces if t.get("kind") == "tag" and t.get("id")}
    sentences = []
    for u in utterances:
        trace = by_trace.get(u["id"])
        result = (trace or {}).get("result") or {}
        forks = []
        if trace and result:
            forks = stored_trace_forks(trace)
        tag = result.get("tag") if trace else u.get("tag")
        route = forks[-1]["layer"] if forks else "unknown"
        sentences.append(dict(id=u["id"], text=u["text"], start_ms=u["start_ms"], end_ms=u["end_ms"],
                              speaker=(u.get("review") or {}).get("speaker") or u.get("speaker"), tag=tag,
                              route=route, outcome=KEPT.get(tag, "历史分类未记录") if trace else
                              ("仅存最终标签 · " + TAG_NAMES.get(tag, tag) if tag else "历史判断未记录"),
                              tag_provenance="recorded" if trace else "stored" if tag else "missing", forks=forks))
    ready = minutes_view.get("status") == "ready" and isinstance(minutes_view.get("minutes"), dict)
    last = max((u["end_ms"] for u in utterances), default=0)
    return dict(version=2, pipeline=current_pipeline(), thresholds=dict(tag_floor=TAG_FLOOR),
                source=dict(kind="history", label=row.get("display_title") or row.get("title")
                            or (minutes_view.get("minutes") or {}).get("theme")
                            or (row.get("agenda") or {}).get("goal") or "历史会议",
                            session_id=row.get("session_id"), sentences=len(sentences), duration_ms=last,
                            note="只读历史库：仅展示已保存判断；缺少 Jev 概率、模型或中间步骤时留空，不补算历史。读取不触发模型或外部操作。",
                            trace_count=sum(bool(s["forks"]) for s in sentences),
                            stored_tag_count=sum(s["tag_provenance"] == "stored" for s in sentences)),
                sentences=sentences, session=[], lens=None,
                post=post_from_minutes(minutes_view["minutes"], utterances, generation=minutes_view.get("generation"),
                                       row=row, delivery_record=minutes_view.get("delivery_record"),
                                       historical_records=minutes_view.get("historical_records")) if ready else None,
                post_status=dict(status=minutes_view.get("status", "unavailable"), reason=minutes_view.get("reason"),
                                 message=minutes_view.get("message")))


def reanalysis_call_forks(call, call_index):
    """Only the actual request's questions and returned probabilities, never inferred alternatives."""
    request = call.get("request") or {}
    response = call.get("response") or {}
    questions = request.get("questions") or {}
    answers = response.get("answers") or {}
    state = request.get("state") or {}
    # Headers, URLs and account credentials are never part of the display contract.
    input_state = {k: state[k] for k in ("utterance", "speaker", "clauses", "context", "current", "previous") if k in state}
    out = []
    for index, (key, question) in enumerate(questions.items()):
        if not isinstance(question, dict):
            continue
        answer = answers.get(key) or {}
        probabilities = {k: p for k, p in (answer.get("probabilities") or {}).items()
                         if type(p) in (int, float) and math.isfinite(p) and 0 <= p <= 1}
        choice = answer.get("choice")
        selected = TAG_NAMES.get(choice, choice) if isinstance(choice, str) else None
        criteria = {k: v for k, v in (question.get("criteria") or {}).items() if isinstance(v, str)}
        stage_name = {"whole_tag": "整句分类", "task_clauses": "小句核对", "conflict": "矛盾检测"}.get(call.get("stage"), "Jev 判断")
        out.append(fork("jev", stage_name + " · " + key,
                        selected or "未返回可用答案", p=probabilities.get(choice),
                        ms=call.get("latency_ms") if index == 0 else 0, provenance="reanalysis",
                        engine=response.get("model"), requested_model=request.get("model"),
                        response_model=response.get("model"), call_latency_ms=call.get("latency_ms"),
                        call_index=call_index, attempt=call.get("attempt"), recorded_at=call.get("recorded_at") or call.get("started_at"),
                        request=dict(model=request.get("model"), state=input_state,
                                     questions={key: {k: question[k] for k in ("type", "instructions", "criteria") if k in question}}),
                        choice=choice, criteria=criteria, probabilities=probabilities,
                        instructions=question.get("instructions")))
    if not out:
        out.append(fork("jev", "Jev 实际请求", "未保存问题或没有可用返回", ms=call.get("latency_ms"),
                        provenance="reanalysis", engine=response.get("model"), requested_model=request.get("model"),
                        response_model=response.get("model"), call_latency_ms=call.get("latency_ms"),
                        attempt=call.get("attempt"), call_index=call_index,
                        request=dict(model=request.get("model"), state=input_state, questions={})))
    return out


def build_reanalysis(record, row, minutes_view):
    """A separately authorized Jev run; never updates original meeting labels or claims a new DeepSeek result."""
    traces = record.get("events") or []
    analysis_row = dict(row, utterances=[dict(u, tag=None) for u in row.get("utterances") or []])
    output = build_stored(analysis_row, minutes_view, traces)
    calls = record.get("raw_calls") or []
    by_id = {}
    for index, call in enumerate(calls):
        by_id.setdefault(call.get("utterance_id"), []).append((index, call))
    events_by_id = {event.get("id"): event for event in traces if event.get("kind") == "tag"}
    for sentence in output["sentences"]:
        sentence_calls = by_id.get(sentence["id"], [])
        actual, used = [], set()
        event = events_by_id.get(sentence["id"]) or {}
        for stage in event.get("stages") or []:
            matching = [(index, call) for index, call in sentence_calls
                        if index not in used and call.get("stage") == stage.get("kind")]
            if matching:
                for index, call in matching:
                    actual.extend(reanalysis_call_forks(call, index))
                    used.add(index)
            elif stage.get("layer") == "code":
                actual.extend(dict(f, provenance="reanalysis") for f in stored_trace_forks(dict(event, stages=[stage])))
        for index, call in sentence_calls:
            if index not in used:
                actual.extend(reanalysis_call_forks(call, index))
        if not event.get("stages"):
            actual.extend(dict(f, provenance="reanalysis") for f in sentence["forks"] if f["layer"] == "code")
        sentence["forks"] = actual
        sentence["route"] = actual[-1]["layer"] if actual else "unknown"
        sentence["tag_provenance"] = "reanalysis" if actual else "missing"
        if not actual:
            sentence["tag"] = None
            sentence["outcome"] = "本次没有调用记录"
    source = output["source"]
    source.update(kind="reanalysis", run_id=record.get("run_id"), source_session_id=record.get("source_session_id"),
                  label="重新分析 · " + source["label"], created_at=record.get("created_at"), request_count=len(calls),
                  analysis_status=record.get("status"), completed_tag_sentences=record.get("completed_tag_sentences"),
                  note="重新分析：这是获准后新运行的 Jev 判断，不是会议当时的历史判断。页面只读本次请求、上下文、完整选项与概率；不再调用模型、不修改原会议。")
    completed = record.get("completed_tag_sentences")
    if record.get("status") not in (None, "complete"):
        source["note"] += " 本次仅完成 " + (str(completed) if type(completed) is int else "未记录数量") + " / " + str(len(output["sentences"])) + " 句；未运行部分保持未记录。"
    if output.get("post"):
        output["post"]["generation"] = dict(output["post"]["generation"], evidence="reused_history")
        output["post"]["note"] = "复用原有纪要；本次重新分析仅调用 Jev，没有调用 DeepSeek 生成新纪要。"
        output["post"]["handoffs"] = post_handoffs(output["post"])
    output["lens"] = None
    return output


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
        data = build(replay, f"重新分析 {name}", "replay",
                     "重新运行的分析回放：Jev / DeepSeek 结果来自该次分析事件，不代表会议当时的判断；规则岔口用当前代码重算。仅限本机查看，不要提交或发布。")
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
