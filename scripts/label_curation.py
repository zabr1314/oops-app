"""Source-bound editorial cleanup alongside label originals and personal answers.

Reading never changes ASR, items.json, identities or a person's review. A person
may reopen an archived original, which restores its merge group for that person.
"""
import copy
import json
import os
import re

import content_curation


def canonical(items):
    return [dict(item, evidence_ids=list(dict.fromkeys(i for span in item.get('evidence', []) for i in span)))
            for item in items]


def read_plan(folder, mid):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', mid):
        return None
    path = os.path.join(folder, 'curation', mid + '.json')
    try:
        with open(path, encoding='utf-8') as stream:
            return json.load(stream)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return {}  # show a stale plan instead of silently presenting it as ready


def project_items(data, mid, name, document, state, reserved):
    import label_items
    originals = (document or {}).get('items', [])
    plan = read_plan(data.folder, mid)
    if plan is None:
        return copy.deepcopy(originals), None
    rows = data.meetings[mid]['rows']
    by_id = {u['id']: u for u in rows}
    reviews = state['state']['reviews']
    restores = state['state'].get('curation_restores', {})
    protected = {i['id'] for i in originals if
        (reviews.get(i['id']) or {}).get('fingerprint') == i['fingerprint'] or
        restores.get(i['id']) == i['fingerprint']}
    # A person's merge answer protects the destination as well as the source.
    # Otherwise a separate editorial op could hide the unreviewed destination,
    # leaving the person's "merged into" answer with no active candidate.
    # Only current source answers create edges, and a destination must still be
    # an exact current original ID (the ID itself binds its full fingerprint).
    original_by_id = {i['id']: i for i in originals}
    merge_groups = {}
    for iid, review in reviews.items():
        source = original_by_id.get(iid)
        target = review.get('into') if isinstance(review, dict) else None
        if (source is None or not isinstance(review, dict)
                or review.get('fingerprint') != source['fingerprint']
                or review.get('status') != 'merged'
                or not isinstance(target, str) or target not in original_by_id):
            continue
        merge_groups.setdefault(iid, set()).add(target)
        merge_groups.setdefault(target, set()).add(iid)
    pending = list(protected)
    while pending:
        for linked in merge_groups.get(pending.pop(), ()):
            if linked not in protected:
                protected.add(linked)
                pending.append(linked)
    result = content_curation.project(plan, rows, canonical(originals), protected_ids=protected, meeting_id=mid)
    # Independent samples stay in the original blind-review path. Never expose
    # their words or suggestions via an editorial summary or merged item.
    reserved = set(reserved)
    if result['status'] == 'ready' and (any(set(s.get('evidence_ids', [])) & reserved for s in result.get('summary', []))
            or any(set(i.get('evidence_ids', [])) & reserved for i in result.get('active_items', []))):
        return copy.deepcopy(originals), dict(status='needs_review', errors=['reserved_source'])
    if result['status'] != 'ready':
        return copy.deepcopy(originals), {k: v for k, v in result.items() if k not in ('active_items', 'suppressed_items', 'utterances')}
    out = []
    for suppressed, values in ((False, result['active_items']), (True, result['suppressed_items'])):
        for value in values:
            item = copy.deepcopy(value)
            ids = item.pop('evidence_ids')
            item['evidence'] = (copy.deepcopy(original_by_id[item['id']]['evidence']) if item['id'] in original_by_id
                                else label_items._spans(ids, rows))
            if item['id'] not in original_by_id:
                item['fingerprint'] = label_items.item_fingerprint(item, by_id)
                item['claimed'] = False
            item['curation'] = dict(item.get('curation') or {}, suppressed=suppressed,
                                     plan_hash=result.get('plan_hash'))
            out.append(item)
    meta = {k: v for k, v in result.items() if k not in ('active_items', 'suppressed_items', 'utterances')}
    meta['folded_ids'] = [u['id'] for u in result.get('utterances', []) if u.get('curation', {}).get('mode') == 'fold' and u['id'] not in reserved]
    return out, meta


def transcript(data, mid):
    import label_items
    doc, _, reserved = label_items.items_state(data, mid)
    plan = read_plan(data.folder, mid)
    if plan is None:
        return None
    rows = data.meetings[mid]['rows']
    verdict = content_curation.validate_plan(plan, rows, canonical((doc or {}).get('items', [])), meeting_id=mid)
    if verdict['status'] != 'ready':
        return verdict
    reserved = set(reserved)
    summary = [s for s in plan.get('summary', []) if not set(s.get('evidence_ids', [])) & reserved]
    return dict(status='ready', summary=summary,
                folded_ids=[s['id'] for s in plan.get('sentences', []) if s.get('mode') == 'fold' and s['id'] not in reserved])
