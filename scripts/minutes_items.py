#!/usr/bin/env python3
"""Minutes → the items a person checks after a meeting: what to do, what was decided, what is still open.

Items come from the bot's stored minutes (feishu_actions); nothing here calls a model. Each item keeps the sentence
ids it rests on. A person's check is stored with the meeting (row['item_reviews']) and never touches sentence
reviews, so checking items does not change the minutes' source or invalidate them.
"""
import datetime as dt
import hashlib
import json
import re

KINDS = ('task', 'decision', 'open')
COLLECTIVE = '大家'  # a task the whole team owns


class ItemChanged(Exception):
    """The item or a sentence it rests on changed since the person saw it."""


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()


def _clean(value, limit):
    return re.sub(r'\s+', ' ', str(value or '')).strip()[:limit]


def build(analysis):
    """Items in reading order: tasks (main line first), decisions, then what is still open."""
    items = []

    def add(kind, title, ids, **extra):
        ids = [i for i in (ids or []) if isinstance(i, str)]
        title = _clean(title, 200)
        if not title or not ids:
            return
        item = dict(kind=kind, title=title, ids=ids, **extra)
        item['id'] = 'mi-' + _digest(dict(kind=kind, title=title, ids=ids))[:12]
        if all(other['id'] != item['id'] for other in items):
            items.append(item)

    actions = analysis.get('actions') or []
    for a in sorted(actions, key=lambda a: a.get('priority', 'main') != 'main'):
        add('task', a.get('task'), a.get('ids'), due=_clean(a.get('due'), 40), owner_hint=_clean(a.get('owner'), 20),
            priority='main' if a.get('priority', 'main') == 'main' else 'other')
    for d in analysis.get('decisions') or []:
        add('decision', d.get('text'), d.get('ids'))
    for u in analysis.get('undecided') or []:
        add('open', u.get('topic'), u.get('ids'), detail=_clean(u.get('views'), 200))
    for q in analysis.get('open_questions') or []:
        add('open', q.get('question'), [q['id']] if q.get('id') else q.get('ids'), detail='需要查资料或事实才能回答')
    return items


def fingerprint(item, by_id):
    """An item's check stays valid while the item and the exact sentences it rests on are unchanged."""
    return _digest(dict(id=item['id'], kind=item['kind'], title=item['title'],
                        sentences=[[i, by_id[i]['text']] for i in item['ids'] if i in by_id]))


def present(items, row, tasks=(), stale=False):
    """Items with their quotes, this person's team review and any Feishu task created from the same sentences."""
    by_id = {u['id']: u for u in row['utterances']}
    reviews = row.get('item_reviews') or {}
    out = []
    for item in items:
        evidence = [dict(id=i, text=by_id[i]['text'], start_ms=by_id[i]['start_ms'], end_ms=by_id[i]['end_ms'],
                         speaker=(by_id[i].get('review') or {}).get('speaker') or by_id[i].get('speaker'))
                    for i in item['ids'] if i in by_id]
        if not evidence:  # every sentence it cited is gone: never invent a quote
            continue
        fp = fingerprint(item, by_id)
        saved = reviews.get(item['id'])
        missing = any(i not in by_id for i in item['ids'])
        versions = {i: (row.get('source_versions') or {}).get(i, 0) for i in item['ids']}
        if any(versions.values()):
            fp = _digest(dict(content_fingerprint=fp, source_versions=versions))
        saved_versions = (saved or {}).get('source_versions', {i: 0 for i in item['ids']})
        current = dict(saved) if not missing and saved and saved.get('fingerprint') == fp and saved_versions == versions else None
        task = next((t for t in tasks if set((t.get('evidence') or {}).get('utterance_ids') or ()) == set(item['ids'])), None)
        out.append(dict(item, evidence=evidence, fingerprint=fp, review=current, stale_review=bool(saved) and not current,
                        stale=bool(stale or missing), task_status=task['status'] if task else None,
                        task_url=((task or {}).get('feishu_task') or {}).get('url')))
    return out


def queue(items):
    """Still to check: no current review and minutes still current."""
    return [dict(kind='item', id=i['id'], item_kind=i['kind']) for i in items if not i['review'] and not i['stale']]


def reusable(row):
    """Object-level withdrawal also applies to cross-page/project reuse."""
    return not row.get('private') and row.get('review_export_scope') not in ('private', 'none', 'revoked')


def confirmed(row, kind=None):
    """Current human-checked items, or explicitly retained independent evidence.

    Confirmation does not retain a transcript or create a task. Source IDs and
    hashes saved with newer checks merely allow an independently retained quote
    to substantiate that check after natural full-text expiry.
    """
    if not reusable(row):
        return []
    out = []
    for item in row.get('items') or []:
        saved = item.get('review') or {}
        effective = saved.get('kind') or item.get('kind')
        if (item.get('stale') or item.get('stale_review') or saved.get('status') != 'confirmed'
                or effective not in KINDS or kind and effective != kind):
            continue
        out.append(dict(item, kind=effective, title=saved.get('title') or item['title'],
                        due=saved.get('due', item.get('due', '')), owner=saved.get('owner') if effective == 'task' else None,
                        source_status='current'))
    if row.get('transcript_status') != 'expired':
        return out
    retained = {line['id']: line for line in row.get('retained_evidence', [])
                if line.get('confirmed') is True and line.get('source_status') != 'changed'}
    present_ids = {item['id'] for item in out}
    for uid, saved in (row.get('item_reviews') or {}).items():
        effective, ids, hashes = saved.get('kind'), saved.get('source_ids'), saved.get('source_text_hashes')
        review_hashes = saved.get('source_review_hashes')
        if (uid in present_ids or saved.get('status') != 'confirmed' or effective not in KINDS or kind and effective != kind
                or not isinstance(ids, list) or not ids or not isinstance(hashes, dict) or not isinstance(review_hashes, dict)
                or any(i not in retained or hashes.get(i) != retained[i].get('original_text_hash')
                       or (row.get('reviews', {}).get(i) or {}).get('source_changed_at')
                       or (saved.get('source_versions') or {}).get(i, 0) != (row.get('source_versions') or {}).get(i, 0)
                       or review_hashes.get(i) != _digest({key: (row.get('reviews', {}).get(i) or {}).get(key)
                                                          for key in ('speaker', 'owner', 'verdict')}) for i in ids)):
            continue
        evidence = [dict(id=i, text=retained[i]['text'], start_ms=retained[i]['start_ms'], end_ms=retained[i]['end_ms'],
                         speaker=retained[i].get('speaker')) for i in ids]
        out.append(dict(id=uid, kind=effective, title=saved['title'], detail='', due=saved.get('due', ''),
                        owner=saved.get('owner') if effective == 'task' else None, ids=list(ids), evidence=evidence,
                        fingerprint=saved['fingerprint'], review=dict(saved), stale=False, stale_review=False,
                        source_status='retained', task_status=None, task_url=None))
    return out


def review(row, items, req, team):
    """confirm (optionally edited) / reject / merge / reopen one item. Raises ValueError, or ItemChanged."""
    item = next((i for i in items if i['id'] == req.get('item_id')), None)
    if item is None:
        raise ValueError('纪要里没有这件事')
    if req.get('fingerprint') != item['fingerprint']:
        raise ItemChanged('事项或依据原话已变化，请刷新后再核对')
    if item['stale']:
        raise ValueError('纪要依据已变化，旧事项只能查看')
    reviews = row.setdefault('item_reviews', {})
    stamp = dict(fingerprint=item['fingerprint'], by=_clean(req.get('by'), 60) or None,
                 at=dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'))
    action = req.get('action')
    if action == 'reopen':
        reviews.pop(item['id'], None)
    elif action == 'reject':
        reviews[item['id']] = dict(status='rejected', **stamp)
    elif action == 'merge':
        into = req.get('into')
        if into == item['id'] or not any(i['id'] == into for i in items):
            raise ValueError('要合并到的事项不存在')
        reviews[item['id']] = dict(status='merged', into=into, **stamp)
    elif action == 'confirm':
        kind = req.get('kind') or item['kind']
        if kind not in KINDS:
            raise ValueError('事项类别无效')
        title = _clean(req['title'] if 'title' in req else item['title'], 200)
        if len(title) < 2:
            raise ValueError('请用一句话写清这件事')
        due = _clean(req['due'] if 'due' in req else item.get('due', ''), 40)
        owner = req.get('owner') or None
        if owner is not None and owner not in (*team, COLLECTIVE):
            raise ValueError('负责人不在团队名单里')
        if kind == 'task' and not owner:
            raise ValueError('待办需要先选负责人')
        edited = kind != item['kind'] or title != item['title'] or due != item.get('due', '')
        reviews[item['id']] = dict(status='confirmed', kind=kind, title=title, due=due,
                                   owner=owner if kind == 'task' else None, edited=edited,
                                   source_ids=list(item['ids']), source_text_hashes={line['id']: hashlib.sha256(
                                       line['text'].encode('utf-8')).hexdigest() for line in item['evidence']},
                                   source_versions={i: (row.get('source_versions') or {}).get(i, 0) for i in item['ids']},
                                   source_review_hashes={i: _digest({key: (row.get('reviews', {}).get(i) or {}).get(key)
                                                                  for key in ('speaker', 'owner', 'verdict')}) for i in item['ids']}, **stamp)
    else:
        raise ValueError('不支持的核对操作')
