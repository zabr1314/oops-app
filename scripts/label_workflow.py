#!/usr/bin/env python3
"""Shared, offline rules for grouped human labelling.

Expressions are a display/selection unit, never a replacement for sentence IDs.
Content labels may be explicitly applied to all selected sentences; identity
confirmation may be linked to a versioned voice group. Neither operation turns
an automatic prefill into an independently heard sentence-level answer.

No dependency on team_label: the site and read-only evaluation tools use these
same rules without an import cycle.
"""
import hashlib
import json
import math
import re
from collections import Counter

KINDS = frozenset(("task", "decision", "info", "noise"))
SHORT_CHARS = 10
MAX_GAP_MS = 1000
MAX_EXPRESSION_MS = 25000
MAX_EXPRESSION_CHARS = 160


def chars(value):
    """The site's existing visible-content threshold, excluding punctuation."""
    text = value.get("text", "") if isinstance(value, dict) else value
    return len(re.sub(r"[^\w]", "", str(text)))


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def _evidence(row):
    return {key: row.get(key) for key in ("id", "text", "start_ms", "end_ms", "voice", "role")}


def row_fingerprint(row):
    """Version the original sentence independently of suggested voice/role data."""
    return digest({key: row.get(key) for key in ("id", "text", "start_ms", "end_ms", "parent")})


def _times(row):
    start, end = row.get("start_ms"), row.get("end_ms")
    if (isinstance(start, (int, float)) and not isinstance(start, bool)
            and isinstance(end, (int, float)) and not isinstance(end, bool)
            and math.isfinite(start) and math.isfinite(end) and 0 <= start <= end):
        return start, end
    return None


def expressions(rows):
    """Conservatively join adjacent pieces of the same ASR final.

    Input order is transcript order. Missing parent, missing/invalid time,
    overlap, a gap over one second, or a changed voice/role starts a new unit.
    Bounds are 25 seconds and 160 content characters. A missing voice matches
    only a missing voice; an explicit ambiguous/multi-speaker cue never joins.
    """
    rows = list(rows)
    ids = [row["id"] for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("Sentence IDs must be unique")
    groups = []
    for row in rows:
        previous = groups[-1][-1] if groups else None
        times = _times(row)
        before = _times(previous) if previous else None
        first = _times(groups[-1][0]) if groups else None
        same_voice = previous and all(row.get(k) == previous.get(k) for k in ("voice", "role"))
        ambiguous = any(row.get(k) in ("multi", "unclear") for k in ("voice", "role"))
        join = (previous is not None and row.get("parent")
                and row.get("parent") == previous.get("parent") and same_voice and not ambiguous
                and times is not None and before is not None and first is not None
                and 0 <= times[0] - before[1] <= MAX_GAP_MS
                and times[1] - first[0] <= MAX_EXPRESSION_MS
                and sum(chars(item) for item in groups[-1]) + chars(row) <= MAX_EXPRESSION_CHARS)
        if join:
            groups[-1].append(row)
        else:
            groups.append([row])
    return [dict(id="expr:" + str(group[0]["id"]), ids=[row["id"] for row in group],
                 text="".join(str(row.get("text", "")) for row in group),
                 start_ms=group[0].get("start_ms"), end_ms=group[-1].get("end_ms"),
                 fingerprint=digest([_evidence(row) for row in group]),
                 required=sum(chars(row) for row in group) >= SHORT_CHARS)
            for group in groups]


def _source_current(row, label, field, expression):
    key = field + "_source"
    if key not in label:
        return True  # Direct corrections and existing sentence labels remain human answers.
    source = label[key]
    if not isinstance(source, dict):
        return False
    if source.get("mode") == "single":
        return source.get("id") == row["id"] and source.get("fingerprint") == row_fingerprint(row)
    if field == "kind":
        return bool(expression and source.get("mode") == "expression"
                    and source.get("id") == expression["id"]
                    and source.get("fingerprint") == expression["fingerprint"])
    if field == "speaker":
        return bool(not label.get("speaker_excluded") and source.get("mode") == "voice_group"
                    and row.get("voice_group_id") and row.get("voice_group_fingerprint")
                    and source.get("id") == row["voice_group_id"]
                    and source.get("fingerprint") == row["voice_group_fingerprint"])
    return False


def current_label(row, label, expression=None):
    """Copy a label, withdrawing fields linked to changed expression/group data.

    kind_source versions the content operation (kind and its owner/duplicate
    fields). speaker_source is independent. New single-sentence corrections use
    mode ``single`` and a row fingerprint; existing labels without a source are
    kept as legacy human answers. Unknown/malformed source markers fail closed.
    """
    label = dict(label) if isinstance(label, dict) else {}
    if label.get("kind") not in KINDS or not _source_current(row, label, "kind", expression):
        for key in ("kind", "owner", "dup", "kind_source"):
            label.pop(key, None)
    elif label.get("kind") != "task":
        label.pop("owner", None)
    if (not isinstance(label.get("speaker"), str) or not label.get("speaker")
            or not _source_current(row, label, "speaker", expression)):
        label.pop("speaker", None)
        label.pop("speaker_source", None)
    return label


def content_audit(rows, labels_by_person):
    """Audit explicit human content and identity separately, without mutations.

    Complete content requires an agreed kind and, for tasks, an agreed owner.
    Speaker disagreements do not block content work. Unlabelled short context
    units do not block work readiness, but remain unlabelled for scoring; once
    an optional unit has been labelled, its incomplete/disputed content must
    also be resolved. No missing sentence is silently assigned ``noise``.

    ``complete_ids`` is the source for parent-level scoring coverage. Only
    parents whose every original sentence is complete may be scored.
    """
    rows = list(rows)
    units = expressions(rows)
    by_id = {uid: unit for unit in units for uid in unit["ids"]}
    kinds, owners, speakers = {}, {}, {}
    complete_ids, content_disputes, speaker_disputes = [], [], []
    stale_kind, stale_speaker = [], []
    stale_kind_count = stale_speaker_count = 0
    content_sources, speaker_sources = Counter(), Counter()
    independent_speakers, grouped_speakers = [], []
    active_ids = set()
    for row in rows:
        uid = row["id"]
        current = {}
        for person, labels in labels_by_person.items():
            raw = labels.get(uid, {})
            if not isinstance(raw, dict):
                continue
            if raw.get("kind") in KINDS:
                active_ids.add(uid)
                if not _source_current(row, raw, "kind", by_id[uid]):
                    stale_kind.append(uid)
                    stale_kind_count += 1
            if raw.get("speaker") and not _source_current(row, raw, "speaker", by_id[uid]):
                stale_speaker.append(uid)
                stale_speaker_count += 1
            item = current_label(row, raw, by_id[uid])
            current[person] = item
            if item.get("kind"):
                content_sources[item.get("kind_source", {}).get("mode", "legacy")] += 1
            if item.get("speaker"):
                speaker_sources[item.get("speaker_source", {}).get("mode", "legacy")] += 1

        dispute, values = {}, {}
        for field in ("kind", "owner", "speaker"):
            seen = {person: item[field] for person, item in current.items()
                    if isinstance(item.get(field), str) and item[field]}
            if len(set(seen.values())) > 1:
                dispute[field] = seen
            elif seen:
                values[field] = next(iter(seen.values()))
        if "kind" in dispute or "owner" in dispute:
            content_disputes.append(dict(utterance=uid, text=row.get("text", ""),
                **{field: dispute[field] for field in ("kind", "owner") if field in dispute}))
        if "speaker" in dispute:
            speaker_disputes.append(dict(utterance=uid, text=row.get("text", ""), speaker=dispute["speaker"]))
        if "kind" not in dispute and values.get("kind"):
            kinds[uid] = values["kind"]
            if values["kind"] == "task" and "owner" not in dispute and values.get("owner"):
                owners[uid] = values["owner"]
            if "owner" not in dispute and (values["kind"] != "task" or uid in owners):
                complete_ids.append(uid)
        if "speaker" not in dispute and values.get("speaker"):
            speakers[uid] = values["speaker"]
            # A real sentence-level check is kept distinct from linked group coverage.
            if any(item.get("speaker") and item.get("speaker_source", {}).get("mode") != "voice_group"
                   for item in current.values()):
                independent_speakers.append(uid)
            else:
                grouped_speakers.append(uid)

    complete, disputed = set(complete_ids), {item["utterance"] for item in content_disputes}
    audited_units = []
    for unit in units:
        required = unit["required"] or bool(set(unit["ids"]) & active_ids)
        audited_units.append(dict(unit, required_for_content=required,
                                  complete=all(uid in complete for uid in unit["ids"]),
                                  disputed=bool(set(unit["ids"]) & disputed),
                                  missing_ids=[uid for uid in unit["ids"] if uid not in complete]))
    required_units = [unit for unit in audited_units if unit["required_for_content"]]
    return dict(kinds=kinds, owners=owners, speakers=speakers, complete_ids=complete_ids,
        content_disputes=content_disputes, content_disputed_ids=[row["id"] for row in rows if row["id"] in disputed],
        speaker_disputes=speaker_disputes, expressions=audited_units,
        expression_count=len(units), required_expression_count=len(required_units),
        complete_required_expressions=sum(unit["complete"] and not unit["disputed"] for unit in required_units),
        context_expression_count=len(units) - len(required_units),
        ready_for_content=bool(rows) and all(unit["complete"] and not unit["disputed"] for unit in required_units),
        content_label_sources={key: content_sources[key] for key in ("single", "legacy", "expression")},
        speaker_label_sources={key: speaker_sources[key] for key in ("single", "legacy", "voice_group")},
        independent_speaker_rows=len(independent_speakers), grouped_speaker_rows=len(grouped_speakers),
        speaker_confirmed_rows=len(speakers), stale_kind_labels=stale_kind_count, stale_speaker_labels=stale_speaker_count,
        stale_kind_ids=list(dict.fromkeys(stale_kind)), stale_speaker_ids=list(dict.fromkeys(stale_speaker)))


def speaker_audit(rows, labels_by_person):
    """Identity-only view; group coverage is never independent sentence truth."""
    report = content_audit(rows, labels_by_person)
    return {key: report[key] for key in ("speakers", "speaker_disputes", "speaker_label_sources",
        "independent_speaker_rows", "grouped_speaker_rows", "speaker_confirmed_rows",
        "stale_speaker_labels", "stale_speaker_ids")}
