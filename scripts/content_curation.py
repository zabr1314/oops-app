#!/usr/bin/env python3
"""Pure, source-bound presentation edits for an existing meeting.

No model, network, clock or file access lives here. Callers adapt their native
items to ``{id, kind, title, evidence_ids, ...}``, and store the plan beside the
originals. A plan never replaces transcripts, proposals or human answers.

Every sentence and candidate must have an explicit disposition. Any invalid or
stale plan fails closed: all original candidates and sentences are returned,
with ``needs_review``. ``protected_ids`` must contain only items with a current
human answer, as determined by the caller's own fingerprint rules. Protecting
one member of a merge preserves the entire original group. The caller still
applies the person's original confirmed/rejected/merged answer when rendering.

This validates provenance and editing boundaries, not the truth of a summary.
The editor remains responsible for faithful wording, and owners remain human
decisions. ``plan_hash`` is a revision for review/restore, not user acceptance.
"""
from copy import deepcopy
import hashlib
import json


SCHEMA = 1
KINDS = frozenset(("task", "decision", "open"))
MODES = frozenset(("focus", "context", "fold"))


class CurationInvalid(ValueError):
    """Malformed original data or plan; error messages are stable codes."""


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def _string(value, code, *, maximum=2000, empty=False):
    if not isinstance(value, str) or (not empty and not value.strip()) or len(value) > maximum:
        raise CurationInvalid(code)
    return value


def _ids(value, code, *, empty=False):
    if not isinstance(value, list) or (not empty and not value):
        raise CurationInvalid(code)
    if any(not isinstance(v, str) or not v or len(v) > 300 for v in value) or len(value) != len(set(value)):
        raise CurationInvalid(code)
    return value


def _sources(rows):
    if not isinstance(rows, list):
        raise CurationInvalid("sources_not_list")
    clean, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            raise CurationInvalid("source_invalid")
        uid = _string(row.get("id"), "source_id_invalid", maximum=300)
        if uid in seen:
            raise CurationInvalid("source_id_duplicate")
        seen.add(uid)
        text = row.get("text")
        if not isinstance(text, str):
            raise CurationInvalid("source_text_invalid")
        start, end = row.get("start_ms"), row.get("end_ms")
        if type(start) is not int or type(end) is not int or start < 0 or end < start:
            raise CurationInvalid("source_time_invalid")
        clean.append(dict(id=uid, text=text, start_ms=start, end_ms=end))
    return clean


def _origins(items):
    if not isinstance(items, list):
        raise CurationInvalid("items_not_list")
    clean, seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            raise CurationInvalid("item_invalid")
        iid = _string(item.get("id"), "item_id_invalid", maximum=300)
        if iid in seen:
            raise CurationInvalid("item_id_duplicate")
        seen.add(iid)
        if not isinstance(item.get("kind"), str) or item["kind"] not in KINDS:
            raise CurationInvalid("item_kind_invalid")
        title = _string(item.get("title"), "item_title_invalid", maximum=2000)
        evidence = list(_ids(item.get("evidence_ids"), "item_evidence_invalid"))
        origin = dict(id=iid, kind=item["kind"], title=title, evidence_ids=evidence)
        for field in ("detail", "due", "fingerprint"):
            if field in item:
                value = item[field]
                if value is not None and not isinstance(value, str):
                    raise CurationInvalid("origin_" + field + "_invalid")
                origin[field] = value
        clean.append(origin)
    return clean


def source_hash(rows):
    """Hash the complete ordered original sentences, including exact text/time."""
    return _digest(_sources(rows))


def origin_items_hash(items):
    """Bind original wording, conditions, dates, native fingerprints and citations."""
    return _digest(_origins(items))


def plan_hash(plan):
    """Stable review revision; it does not imply a person's confirmation."""
    try:
        return _digest(plan)
    except (TypeError, ValueError) as exc:
        raise CurationInvalid("plan_not_json") from exc


def _keys(value, allowed, code):
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise CurationInvalid(code)


def _validate(plan, rows, items, meeting_id):
    sources, origins = _sources(rows), _origins(items)
    _string(meeting_id, "meeting_id_required", maximum=300)
    _keys(plan, ("schema", "meeting_id", "source_hash", "origin_items_hash", "item_ops",
                 "sentences", "summary", "created_at", "note"), "plan_fields_invalid")
    if type(plan.get("schema")) is not int or plan["schema"] != SCHEMA:
        raise CurationInvalid("schema_unsupported")
    if plan.get("meeting_id") != meeting_id:
        raise CurationInvalid("meeting_changed")
    if plan.get("source_hash") != _digest(sources):
        raise CurationInvalid("source_changed")
    if plan.get("origin_items_hash") != _digest(origins):
        raise CurationInvalid("origin_items_changed")
    for key in ("created_at", "note"):
        if key in plan:
            _string(plan[key], "plan_metadata_invalid", empty=True)
    order = {s["id"]: n for n, s in enumerate(sources)}
    by_id = {i["id"]: i for i in items}
    for item in origins:
        if any(uid not in order for uid in item["evidence_ids"]):
            raise CurationInvalid("origin_evidence_out_of_bounds")

    def evidence_ids(value, code):
        ids = _ids(value, code)
        if any(uid not in order for uid in ids):
            raise CurationInvalid(code)
        if ids != sorted(ids, key=order.__getitem__):
            raise CurationInvalid("evidence_order_invalid")
        return ids

    sentence_edits = plan.get("sentences")
    if not isinstance(sentence_edits, list):
        raise CurationInvalid("sentences_missing")
    modes = {}
    for entry in sentence_edits:
        _keys(entry, ("id", "mode", "reason"), "sentence_fields_invalid")
        uid = entry.get("id")
        if not isinstance(uid, str) or uid not in order or uid in modes:
            raise CurationInvalid("sentence_coverage_invalid")
        if not isinstance(entry.get("mode"), str) or entry["mode"] not in MODES:
            raise CurationInvalid("sentence_mode_invalid")
        _string(entry.get("reason"), "sentence_reason_invalid", maximum=1000)
        modes[uid] = entry["mode"]
    if set(modes) != set(order):
        raise CurationInvalid("sentence_coverage_incomplete")

    ops, covered = plan.get("item_ops"), set()
    if not isinstance(ops, list):
        raise CurationInvalid("item_ops_missing")
    for op in ops:
        if not isinstance(op, dict):
            raise CurationInvalid("item_op_invalid")
        action = op.get("action")
        if action in ("keep", "suppress"):
            _keys(op, ("action", "item_id", "reason"), "item_op_fields_invalid")
            ids = [op.get("item_id")]
        elif action in ("merge", "rewrite"):
            _keys(op, ("action", "item_ids", "kind", "title", "detail", "due", "evidence_ids", "reason"),
                  "merge_fields_invalid")
            ids = _ids(op.get("item_ids"), "merge_items_invalid")
            if action == "merge" and len(ids) < 2:
                raise CurationInvalid("merge_needs_multiple_items")
            if action == "rewrite" and len(ids) != 1:
                raise CurationInvalid("rewrite_needs_one_item")
            if not isinstance(op.get("kind"), str) or op["kind"] not in KINDS:
                raise CurationInvalid("merge_kind_invalid")
            _string(op.get("title"), "merge_title_invalid", maximum=200)
            _string(op.get("detail", ""), "merge_detail_invalid", maximum=1000, empty=True)
            _string(op.get("due", ""), "merge_due_invalid", maximum=40, empty=True)
        else:
            raise CurationInvalid("item_action_invalid")
        _string(op.get("reason"), "item_reason_invalid", maximum=1000)
        if any(not isinstance(i, str) or i not in by_id or i in covered for i in ids):
            raise CurationInvalid("item_coverage_invalid")
        covered.update(ids)
        if action in ("merge", "rewrite"):
            union = sorted({uid for iid in ids for uid in by_id[iid]["evidence_ids"]}, key=order.__getitem__)
            if evidence_ids(op.get("evidence_ids"), "merge_evidence_invalid") != union:
                raise CurationInvalid("merge_evidence_not_exact_union")
            due = op.get("due", "")
            original_dues = []
            for iid in ids:
                original_due = by_id[iid].get("due") or ""
                if not isinstance(original_due, str):
                    raise CurationInvalid("origin_due_invalid")
                if original_due:
                    original_dues.append(original_due)
            original_dues = set(original_dues)
            if due and original_dues != {due}:
                raise CurationInvalid("merge_due_not_supported")
    if covered != set(by_id):
        raise CurationInvalid("item_coverage_incomplete")
    summary = plan.get("summary")
    if not isinstance(summary, list):
        raise CurationInvalid("summary_missing")
    for entry in summary:
        _keys(entry, ("text", "evidence_ids"), "summary_fields_invalid")
        _string(entry.get("text"), "summary_text_invalid", maximum=1000)
        evidence_ids(entry.get("evidence_ids"), "summary_evidence_invalid")
    return sources


def validate_plan(plan, rows, items, *, meeting_id=None):
    """Validate all edits atomically. A stale or malformed plan never applies."""
    revision = None
    try:
        revision = plan_hash(plan)
        _validate(plan, rows, items, meeting_id)
    except CurationInvalid as exc:
        return dict(status="needs_review", errors=[str(exc)], plan_hash=revision, revision=revision)
    return dict(status="ready", errors=[], plan_hash=revision, revision=revision)


def project(plan, rows, items, *, meeting_id=None, protected_ids=()):
    """Return a reversible display projection, without mutating any input.

    ``active_items`` includes kept originals and fresh merged candidates.
    ``suppressed_items`` contains excluded original fields plus display-only
    curation metadata. Exact originals remain in ``history_items`` too.
    A current human answer blocks automatic suppression, and blocks a whole
    merge group. Fresh merges have no owner, claim or human review inheritance.
    """
    validation = validate_plan(plan, rows, items, meeting_id=meeting_id)
    base = dict(validation, active_items=deepcopy(items), history_items=deepcopy(items),
                suppressed_items=[], audit=[], summary=[], utterances=deepcopy(rows))
    if validation["status"] != "ready":
        return base
    if not isinstance(protected_ids, (list, tuple, set, frozenset)) or any(not isinstance(i, str) for i in protected_ids):
        base.update(status="needs_review", errors=["protected_ids_invalid"])
        return base
    protected = set(protected_ids)
    by_id = {i["id"]: i for i in items}
    by_source = {r["id"]: r for r in rows}
    dispositions, merged_at, suppression_meta = {}, {}, {}
    for op in plan["item_ops"]:
        action = op["action"]
        ids = op["item_ids"] if action in ("merge", "rewrite") else [op["item_id"]]
        blocked = action != "keep" and bool(set(ids) & protected)
        record = dict(action=action, item_ids=list(ids), reason=op["reason"],
                      applied=not blocked, protected=blocked, plan_hash=validation["plan_hash"])
        base["audit"].append(record)
        if blocked or action == "keep":
            for iid in ids:
                dispositions[iid] = "keep"
            continue
        for iid in ids:
            dispositions[iid] = "suppress"
            suppression_meta[iid] = dict(action=action, reason=op["reason"], plan_hash=validation["plan_hash"])
        if action in ("merge", "rewrite"):
            evidence = list(op["evidence_ids"])
            content = dict(meeting_id=meeting_id, source_hash=plan["source_hash"],
                           origin_items_hash=plan["origin_items_hash"], kind=op["kind"],
                           title=op["title"], detail=op.get("detail", ""), due=op.get("due", ""),
                           evidence_ids=evidence, source_item_ids=list(ids))
            fp = _digest(dict(content, sources=[dict(id=uid, text=by_source[uid]["text"],
                                                    start_ms=by_source[uid]["start_ms"],
                                                    end_ms=by_source[uid]["end_ms"]) for uid in evidence]))
            item = dict(id="curated-" + fp[:20], fingerprint=fp, kind=op["kind"], title=op["title"],
                        detail=op.get("detail", ""), due=op.get("due", ""), evidence_ids=evidence,
                        source_item_ids=list(ids), claimed=False, review=None,
                        curation=dict(plan_hash=validation["plan_hash"], status="candidate", reason=op["reason"]))
            # The first original's reading position owns the replacement, no
            # matter how the editor ordered the merge group's member IDs.
            first = min(ids, key=lambda iid: next(n for n, i in enumerate(items) if i["id"] == iid))
            merged_at[first] = item
            record["replacement_id"] = item["id"]
            for iid in ids:
                suppression_meta[iid]["into"] = item["id"]
    active, suppressed = [], []
    for item in items:
        iid = item["id"]
        if iid in merged_at:
            active.append(merged_at[iid])
        if dispositions[iid] == "keep":
            active.append(deepcopy(item))
        else:
            suppressed.append(dict(deepcopy(item), curation=suppression_meta[iid]))
    edits = {e["id"]: e for e in plan["sentences"]}
    base.update(active_items=active, suppressed_items=suppressed, summary=deepcopy(plan["summary"]),
                utterances=[dict(deepcopy(row), curation=dict(mode=edits[row["id"]]["mode"],
                                reason=edits[row["id"]]["reason"], plan_hash=validation["plan_hash"]))
                            for row in rows])
    return base
