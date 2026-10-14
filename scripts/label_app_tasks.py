#!/usr/bin/env python3
"""Read the explicitly approved review-site tasks for the App, without writing answers.

The review site's existing items endpoint owns source-hash, blind-sample and item
fingerprint validation. This adapter only reads that endpoint on loopback, pins
the approved AI candidates, and keeps each person's review separate. It neither
creates Feishu tasks nor calls a model. Missing configuration disables the bridge.
"""
import hashlib
import ipaddress
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor


MEETINGS = ('0235', '0236', '0238')
MAX_RESPONSE_BYTES = 2_000_000
TIMEOUT_SECONDS = 4.0
SNAPSHOT_DEADLINE_SECONDS = 6.0
READ_SLOTS = threading.BoundedSemaphore(3)
FINGERPRINT = re.compile(r'[0-9a-f]{64}')


class ReadUnavailable(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ReadUnavailable('redirect_not_allowed')


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def _configuration(path):
    if not path or not os.path.isfile(path):
        return None
    with open(path, encoding='utf-8') as source:
        value = json.load(source)
    if not isinstance(value, dict) or value.get('version') != 1:
        raise ReadUnavailable('invalid_configuration')
    if value.get('enabled') is not True:
        return None
    mids = value.get('meeting_ids')
    if not isinstance(mids, list) or len(mids) != len(MEETINGS) or set(mids) != set(MEETINGS):
        raise ReadUnavailable('meeting_scope_not_authorized')
    base = urllib.parse.urlsplit(value.get('base_url', ''))
    try:
        host = ipaddress.ip_address(base.hostname or '')
        port = base.port
    except ValueError:
        raise ReadUnavailable('invalid_loopback_endpoint') from None
    if (base.scheme not in ('http', 'https') or not host.is_loopback or not port
            or base.username or base.password or base.query or base.fragment
            or '..' in base.path.split('/')):
        raise ReadUnavailable('invalid_loopback_endpoint')
    approved = value.get('authorized_tasks')
    if not isinstance(approved, dict) or set(approved) != set(MEETINGS):
        raise ReadUnavailable('candidate_scope_not_authorized')
    for mid in MEETINGS:
        items = approved[mid]
        if (not isinstance(items, dict) or not items or len(items) > 40
                or any(not isinstance(i, str) or not re.fullmatch(r'ai-[0-9a-f]{12}', i)
                       or not isinstance(fp, str) or not FINGERPRINT.fullmatch(fp)
                       for i, fp in items.items())):
            raise ReadUnavailable('candidate_scope_not_authorized')
    site = urllib.parse.urlsplit(value.get('site_url', ''))
    if (site.scheme != 'https' or not site.hostname or site.username or site.password
            or site.query or site.fragment):
        raise ReadUnavailable('invalid_review_link')
    value['base_url'] = urllib.parse.urlunsplit(base).rstrip('/')
    value['site_url'] = urllib.parse.urlunsplit(site).rstrip('/') + '/'
    return value


def _read(base_url, mid, name, deadline):
    request = urllib.request.Request(base_url + '/api/meeting/' + mid + '/items',
        headers={'X-Labeler': urllib.parse.quote(name, safe=''), 'Accept': 'application/json'})
    # Ignore proxy environment variables: this bridge is authorized only for the
    # configured local review server. Redirects cannot send these reads elsewhere.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not READ_SLOTS.acquire(timeout=max(0, remaining)):
        raise ReadUnavailable('review_read_deadline')
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ReadUnavailable('review_read_deadline')
        with opener.open(request, timeout=min(TIMEOUT_SECONDS, remaining)) as response:
            if response.getcode() != 200:
                raise ReadUnavailable('review_read_failed')
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ReadUnavailable('review_response_too_large')
        value = json.loads(raw)
    except (OSError, ValueError, TypeError):
        raise ReadUnavailable('review_read_failed') from None
    finally:
        READ_SLOTS.release()
    if not isinstance(value, dict) or value.get('meeting') != mid or not isinstance(value.get('items'), list):
        raise ReadUnavailable('invalid_review_response')
    return value


def _base(item):
    """Compare source content across personal reads; speaker corrections stay per person."""
    return {**{key: item.get(key) for key in ('id', 'kind', 'title', 'detail', 'due', 'fingerprint')},
            'evidence': [{key: row.get(key) for key in ('id', 'text', 'start_ms', 'end_ms')}
                         for span in item.get('evidence', []) for row in span.get('rows', [])]}


def _review(item, name, revision):
    saved = item.get('review')
    if item.get('stale_review'):
        return dict(by=name, verdict='source_changed', source='human_review',
                    updated_at=None, revision=revision, owner=None)
    if saved is None:
        return dict(by=name, verdict='unreviewed', source='human_review',
                    updated_at=None, revision=revision, owner=None)
    if (not isinstance(saved, dict) or saved.get('fingerprint') != item['fingerprint']
            or saved.get('status') not in ('confirmed', 'rejected', 'merged')
            or saved.get('by') != name):
        raise ReadUnavailable('invalid_personal_review')
    return dict(by=name, verdict=saved['status'], source='human_review',
                updated_at=saved.get('at'), revision=revision,
                **{key: saved.get(key) for key in ('kind', 'title', 'detail', 'due', 'owner', 'into')})


def _meeting(config, mid, people, deadline):
    # The review server has a small listen backlog. Keep the three meetings in
    # parallel but read their people sequentially; the shared slots also bound
    # concurrent reads from other App requests. One deadline covers the snapshot.
    values = [_read(config['base_url'], mid, name, deadline) for name in people]
    statuses = [value.get('status') for value in values]
    if any(status != 'ready' for status in statuses):
        status = 'stale' if any(s == 'stale' for s in statuses) else 'unavailable'
        return [], dict(id=mid, status=status, count=0, reason_code='review_source_' + status)
    maps = [{item['id']: item for item in value['items'] if item.get('source') == 'ai'} for value in values]
    if any(len(items) != sum(item.get('source') == 'ai' for item in value['items'])
           for items, value in zip(maps, values)):
        raise ReadUnavailable('duplicate_candidate_id')
    signatures = [_digest([_base(items[uid]) for uid in sorted(items)]) for items in maps]
    if len(set(signatures)) != 1:
        raise ReadUnavailable('source_changed_during_read')
    approved = config['authorized_tasks'][mid]
    tasks = {uid: item for uid, item in maps[0].items() if item.get('kind') == 'task'}
    if set(tasks) != set(approved) or any(tasks[uid].get('fingerprint') != fp for uid, fp in approved.items()):
        return [], dict(id=mid, status='stale', count=0, reason_code='authorized_candidates_changed')
    out = []
    for uid, item in tasks.items():
        base = _base(item)
        if (not isinstance(item.get('title'), str) or not item['title'].strip()
                or not base['evidence'] or any(not isinstance(row.get('text'), str)
                or not row['text'].strip() or not isinstance(row.get('id'), str) for row in base['evidence'])):
            raise ReadUnavailable('invalid_item_evidence')
        reviews = [_review(items[uid], name, value.get('revision'))
                   for items, name, value in zip(maps, people, values)]
        evidence = []
        personal_rows = [{row['id']: row for span in items[uid].get('evidence', [])
                          for row in span.get('rows', [])} for items in maps]
        for row in base['evidence']:
            speakers = [dict(by=name, speaker=rows[row['id']].get('speaker'),
                             speaker_source=rows[row['id']].get('speaker_source'))
                        for name, rows in zip(people, personal_rows)]
            names = {entry['speaker'] for entry in speakers}
            speaker = next(iter(names)) if len(names) == 1 and None not in names else None
            evidence.append(dict(row, speaker=speaker, speaker_reviews=speakers,
                                 speaker_status='consistent' if speaker else 'needs_review'))
        confirmed = [review for review in reviews if review['verdict'] == 'confirmed']
        owners = {review.get('owner') for review in confirmed if review.get('kind') == 'task'}
        owner_conflict = len(owners) > 1
        answered = [review for review in reviews if review['verdict'] in ('confirmed', 'rejected', 'merged')]
        review_conflict = len({_digest({key: review.get(key) for key in
            ('verdict', 'kind', 'title', 'detail', 'due', 'owner', 'into')}) for review in answered}) > 1
        out.append(dict(id='label:' + mid + ':' + uid, item_id=uid, source='label_review', kind='task',
            title=item['title'], what=item['title'], detail=item.get('detail') or '', due=item.get('due') or '',
            source_meeting=dict(id=mid, title=(config.get('titles') or {}).get(mid) or '会议 ' + mid),
            fingerprint=item['fingerprint'], evidence=evidence, reviews=reviews, owner=None,
            owner_conflict=owner_conflict, review_conflict=review_conflict, source_status='current', read_only=True,
            review_url=config['site_url'],
            provenance=dict(kind='approved_label_candidate', validation='label_items.items_payload')))
    return out, dict(id=mid, status='ready', count=len(out))


def read_parsed_tasks(config_path, people):
    """All approved candidates, independent of Feishu status/assignee filters.

    counts.total is an item count; review_counts counts each person's independent
    current review. No verdict is a business-completion or external-task receipt.
    """
    empty = dict(parsed_items=[], parsed_status=dict(state='disabled', meetings=[], counts=dict(total=0),
        review_counts={verdict: 0 for verdict in ('unreviewed', 'confirmed', 'rejected', 'merged', 'source_changed')}))
    try:
        config = _configuration(config_path)
    except (OSError, ValueError, TypeError, AttributeError, ReadUnavailable):
        empty['parsed_status'].update(state='unavailable', reason_code='invalid_configuration')
        return empty
    if config is None:
        return empty
    deadline = time.monotonic() + SNAPSHOT_DEADLINE_SECONDS
    items, meetings = [], []
    def read(mid):
        try:
            return _meeting(config, mid, people, deadline)
        except (ReadUnavailable, OSError, ValueError, TypeError, KeyError, AttributeError) as error:
            reason = str(error) if isinstance(error, ReadUnavailable) else 'invalid_review_response'
            return [], dict(id=mid, status='unavailable', count=0, reason_code=reason)
    with ThreadPoolExecutor(max_workers=len(MEETINGS)) as pool:
        for current, meeting in pool.map(read, MEETINGS):
            items.extend(current)
            meetings.append(meeting)
    status = empty['parsed_status']
    ready = sum(meeting['status'] == 'ready' for meeting in meetings)
    status.update(state='ready' if ready == len(MEETINGS) else 'partial' if ready else 'unavailable',
                  meetings=meetings, counts=dict(total=len(items)))
    for item in items:
        for review in item['reviews']:
            status['review_counts'][review['verdict']] += 1
    return dict(parsed_items=items, parsed_status=status)
