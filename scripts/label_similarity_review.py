#!/usr/bin/env python3
"""Explicit, recoverable confirmation of a viewed similarity group.

This module performs no inference and never chooses additional members. The
caller resolves the complete, freshly computed group while holding Data.lock;
the submitted subset is checked again against immutable source suggestions.
All label-file changes are described in one durable journal before the first
label file is replaced. Readers and writers must call ``recover(data)`` under
the same service RLock before accessing labels.
"""
import copy
import hashlib
import json
import os
import tempfile
import time

from label_workflow import expressions


SAFE_KINDS = ('fact', 'info', 'noise')
MEMBER_KEYS = ('meeting', 'expression', 'fingerprint', 'suggestion_fingerprint')


class SimilarityConflict(ValueError):
    """The reviewed group or an answer changed; reload before confirming."""


class SimilarityRecoveryError(RuntimeError):
    """A transaction cannot safely finish; do not serve partially saved labels."""


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':')).encode()).hexdigest()


def _journal_dir(data, name=None):
    path = os.path.join(data.folder, 'similarity_requests')
    return os.path.join(path, name) if name is not None else path


def _journal_path(data, name, request_id):
    # The authenticated name is server-owned; request IDs are never path parts.
    return os.path.join(_journal_dir(data, name), hashlib.sha256(request_id.encode()).hexdigest() + '.json')


def _read(path, default=None):
    if not os.path.isfile(path):
        return default
    with open(path, encoding='utf-8') as stream:
        return json.load(stream)


def _atomic_write(path, value):
    """Persist file contents and the rename before allowing a later phase."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.similarity-', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=1)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


def _journals(data, name=None):
    directory = _journal_dir(data, name)
    if not os.path.isdir(directory):
        return []
    paths = []
    if name is not None:
        paths = [os.path.join(directory, item) for item in sorted(os.listdir(directory)) if item.endswith('.json')]
    else:
        for owner in sorted(os.listdir(directory)):
            owner_path = os.path.join(directory, owner)
            if os.path.isdir(owner_path):
                paths.extend(os.path.join(owner_path, item) for item in sorted(os.listdir(owner_path))
                    if item.endswith('.json'))
    result = []
    for path in paths:
        try:
            journal = _read(path)
            if not isinstance(journal, dict) or journal.get('version') != 1 \
                    or journal.get('status') not in ('prepared', 'committed') \
                    or not isinstance(journal.get('targets'), list) \
                    or not isinstance(journal.get('labeler'), str) \
                    or not isinstance(journal.get('request_id'), str) \
                    or path != _journal_path(data, journal['labeler'], journal['request_id']):
                raise ValueError('invalid journal')
        except (ValueError, TypeError, KeyError, OSError) as error:
            raise SimilarityRecoveryError('Similarity transaction journal is unreadable') from error
        result.append((path, journal))
    return sorted(result, key=lambda item: (item[1].get('created_ns', 0), item[1]['request_id']))


def _finish(data, path, journal):
    # Validate every destination before resuming any of them. A non-cooperating
    # writer must never be overwritten by crash recovery.
    pending = []
    for target in journal['targets']:
        mid = target.get('meeting')
        if mid not in data.meetings or not isinstance(target.get('after'), dict) \
                or _digest(target['after']) != target.get('after_hash'):
            raise SimilarityRecoveryError('Similarity transaction target is invalid')
        label_path = data.labels_path(mid, journal['labeler'])
        current_hash = _digest(_read(label_path))
        if current_hash == target['after_hash']:
            continue
        if current_hash != target.get('before_hash'):
            raise SimilarityRecoveryError('Labels changed outside the pending similarity transaction')
        pending.append((label_path, target['after']))
    for label_path, after in pending:
        _atomic_write(label_path, after)
    journal = dict(journal, status='committed', committed_at=time.strftime('%Y-%m-%dT%H:%M:%S'))
    _atomic_write(path, journal)
    return journal['result']


def recover(data):
    """Finish prepared transactions before any label read or write.

    Forward recovery is intentional: once the durable journal exists, an HTTP
    failure is an unknown receipt, never an instruction to discard part of the
    group. Replaying the same request returns its committed receipt.
    """
    with data.lock:
        if getattr(data, '_similarity_recovering', False):
            return
        data._similarity_recovering = True
        try:
            for path, journal in _journals(data):
                if journal['status'] == 'prepared':
                    _finish(data, path, journal)
        finally:
            data._similarity_recovering = False


def _request(body):
    request_id = body.get('request_id')
    if not isinstance(request_id, str) or not 8 <= len(request_id) <= 100:
        raise ValueError('request_id required')
    return request_id, _digest(body)


def _known_request(data, name, request_id, fingerprint):
    journal = _read(_journal_path(data, name, request_id))
    if journal is None:
        return None
    if journal.get('fingerprint') != fingerprint:
        raise ValueError('request_id reused')
    if journal.get('status') != 'committed':
        raise SimilarityRecoveryError('Similarity transaction recovery is incomplete')
    return copy.deepcopy(journal['result'])


def _member(item):
    if not isinstance(item, dict) or any(not isinstance(item.get(key), str) for key in MEMBER_KEYS):
        raise ValueError('invalid similarity member')
    return tuple(item[key] for key in MEMBER_KEYS)


def _trim_history(history):
    # Keep a group entry until explicitly undone, including after many ordinary
    # corrections. Ordinary entries retain the workbench's existing 30 limit.
    normal = {index for index in range(len(history)) if not history[index].get('group_transaction')}
    recent = set(sorted(normal)[-30:])
    return [entry for index, entry in enumerate(history) if entry.get('group_transaction') or index in recent]


def _prepare_confirm(data, name, body, group, request_id, fingerprint):
    if not isinstance(group, dict) or not group.get('group_fingerprint') \
            or body.get('group_fingerprint') != group['group_fingerprint']:
        raise SimilarityConflict('Similarity group changed')
    anchor = group.get('anchor')
    if _member(body.get('anchor')) != _member(anchor):
        raise SimilarityConflict('Similarity anchor changed')
    kind = anchor.get('kind')
    if kind not in SAFE_KINDS:
        raise ValueError('this category requires individual review')
    supplied = body.get('items')
    if not isinstance(supplied, list) or not 1 <= len(supplied) <= 1500:
        raise ValueError('invalid confirmation range')
    selected = [_member(item) for item in supplied]
    if len(set(selected)) != len(selected):
        raise ValueError('duplicate similarity member')
    candidates = [anchor] + list(group.get('candidates', []))
    allowed = {_member(item): item for item in candidates}
    if any(item not in allowed for item in selected):
        raise SimilarityConflict('Confirmation includes a member outside the viewed group')
    anchor_key = _member(anchor)
    if anchor.get('readonly'):
        if anchor_key in selected:
            raise SimilarityConflict('Already reviewed anchor cannot be overwritten')
    elif anchor_key not in selected:
        raise ValueError('include the unreviewed anchor')
    meetings = sorted({item[0] for item in selected})
    if not 1 <= len(meetings) <= 3:
        raise ValueError('invalid meeting range')
    revisions = body.get('revisions')
    if not isinstance(revisions, dict) or not set(meetings) <= set(revisions):
        raise ValueError('meeting revisions required')
    documents = {}
    for mid, revision in revisions.items():
        if mid not in data.meetings or type(revision) is not int:
            raise ValueError('invalid meeting revision')
        documents[mid] = data._document(mid, name)
        if documents[mid]['revision'] != revision:
            raise SimilarityConflict('Answers changed; reload before confirming')
    # All source snapshots are loaded while the caller holds the service RLock.
    # Validate each meeting once, rather than re-reading and re-hashing its
    # whole sidecar for every member in a large group.
    meeting_state = {}
    for mid in meetings:
        ai, _ = data.annotation_state(mid)
        if not ai:
            raise SimilarityConflict('Suggestions unavailable')
        meeting_state[mid] = dict(
            ai=ai, units={item['id']: item for item in expressions(data.meetings[mid]['rows'], ai)},
            predictions={item['id']: item for item in ai.get('expressions', [])},
            reserved=set(ai.get('blind', {}).get('ids', [])))
    checked = []
    for mid, eid, source_fingerprint, suggestion_fingerprint in selected:
        state = meeting_state[mid]
        unit, prediction = state['units'].get(eid), state['predictions'].get(eid)
        if not unit or not prediction or unit['fingerprint'] != source_fingerprint \
                or prediction['suggestion_fingerprint'] != suggestion_fingerprint \
                or prediction['kind'] != kind or set(unit['ids']) & state['reserved']:
            raise SimilarityConflict('Suggestion changed or includes the independent sample')
        if any(documents[mid]['labels'].get(uid, {}).get('kind') for uid in unit['ids']):
            raise SimilarityConflict('Group includes an existing answer or single correction')
        checked.append((mid, unit, prediction, state['ai']['prompt_version']))
    targets = []
    for mid in meetings:
        doc = copy.deepcopy(documents[mid])
        if request_id in doc['seen']:
            raise ValueError('request_id reused')
        before_labels = copy.deepcopy(doc['labels'])
        for meeting, unit, prediction, prompt_version in checked:
            if meeting != mid:
                continue
            for uid in unit['ids']:
                label = doc['labels'].setdefault(uid, {})
                label.update(kind=kind, kind_source=dict(mode='expression', id=unit['id'],
                    fingerprint=unit['fingerprint'], review_mode='ai_assisted',
                    suggestion_fingerprint=prediction['suggestion_fingerprint'], model=prediction['model'],
                    prompt_version=prompt_version, group_transaction=request_id))
                label.pop('owner', None)
                label.pop('dup', None)
        changed = sorted(uid for uid in set(before_labels) | set(doc['labels'])
            if before_labels.get(uid) != doc['labels'].get(uid))
        doc['history'] = _trim_history(doc['history'] + [dict(_label_review=True, review_mode='assisted',
            group_transaction=request_id, snapshot=before_labels, changed_ids=changed)])
        doc['revision'] += 1
        doc['seen'][request_id] = fingerprint
        doc['seen'] = dict(list(doc['seen'].items())[-100:])
        doc.update(meeting=mid, labeler=name)
        before = _read(data.labels_path(mid, name))
        targets.append(dict(meeting=mid, before_hash=_digest(before), after_hash=_digest(doc), after=doc))
    for mid in meetings:
        data._mark_exposed(mid, name, [uid for meeting, unit, _, _ in checked if meeting == mid for uid in unit['ids']])
    return targets, len(checked), sum(len(unit['ids']) for _, unit, _, _ in checked)


def _prepare_undo(data, name, body, request_id, fingerprint):
    original_id = body.get('group_request_id')
    if not isinstance(original_id, str):
        raise ValueError('group_request_id required')
    original = _read(_journal_path(data, name, original_id))
    if not original or original.get('action') != 'confirm_group' or original.get('status') != 'committed':
        raise SimilarityConflict('Confirmed group not found')
    revisions = body.get('revisions')
    if revisions is not None and not isinstance(revisions, dict):
        raise ValueError('invalid meeting revisions')
    targets, expressions, sentences = [], 0, 0
    for target in original['targets']:
        mid = target['meeting']
        doc = data._document(mid, name)
        if revisions is not None and revisions.get(mid) != doc['revision']:
            raise SimilarityConflict('Answers changed; reload before undoing')
        if request_id in doc['seen']:
            raise ValueError('request_id reused')
        match = next((index for index, entry in enumerate(doc['history'])
            if entry.get('group_transaction') == original_id), None)
        if match is None:
            continue  # This meeting's ordinary undo already removed the operation.
        previous = doc['history'].pop(match)
        later = doc['history'][match:]
        for uid in previous['changed_ids']:
            successor = next((entry for entry in later if uid in entry['changed_ids']), None)
            destination = successor['snapshot'] if successor else doc['labels']
            if uid in previous['snapshot']:
                destination[uid] = copy.deepcopy(previous['snapshot'][uid])
            else:
                destination.pop(uid, None)
        doc['revision'] += 1
        doc['seen'][request_id] = fingerprint
        doc['seen'] = dict(list(doc['seen'].items())[-100:])
        doc.update(meeting=mid, labeler=name)
        before = _read(data.labels_path(mid, name))
        targets.append(dict(meeting=mid, before_hash=_digest(before), after_hash=_digest(doc), after=doc))
        sentences += len(previous['changed_ids'])
        expressions += sum(item.get('meeting') == mid for item in original.get('members', []))
    if not targets:
        raise SimilarityConflict('This group has already been undone')
    return targets, expressions, sentences


def review(data, name, body, resolve_group=None):
    """Commit an explicit group subset or undo the original group as one request.

    ``resolve_group`` is called inside the service lock, after pending recovery
    and idempotency lookup. It must recompute the authoritative GET group from
    the submitted anchor/threshold/scope, rather than trust browser candidates.
    """
    with data.lock:
        recover(data)
        request_id, fingerprint = _request(body)
        known = _known_request(data, name, request_id, fingerprint)
        if known is not None:
            return known
        action = body.get('action')
        if action == 'confirm_group':
            if not callable(resolve_group):
                raise ValueError('current group resolver required')
            group = resolve_group()
            targets, expressions, sentences = _prepare_confirm(data, name, body, group, request_id, fingerprint)
        elif action == 'undo_group':
            targets, expressions, sentences = _prepare_undo(data, name, body, request_id, fingerprint)
        else:
            raise ValueError('unknown similarity action')
        transaction = dict(id=request_id, request_id=request_id, action=action,
            group_request_id=body.get('group_request_id') if action == 'undo_group' else request_id,
            affected_meetings=[target['meeting'] for target in targets],
            affected_expressions=expressions, affected_sentences=sentences)
        result = dict(status='complete', transaction=transaction,
            meetings={target['meeting']: target['after']['revision'] for target in targets})
        journal = dict(version=1, status='prepared', action=action, labeler=name, request_id=request_id,
            fingerprint=fingerprint, created_ns=time.time_ns(), targets=targets, result=result,
            members=copy.deepcopy(body.get('items', [])))
        path = _journal_path(data, name, request_id)
        _atomic_write(path, journal)
        return _finish(data, path, journal)


def latest_undo(data, name):
    """The newest group with at least one still-applied per-meeting delta."""
    with data.lock:
        recover(data)
        for _, journal in reversed(_journals(data, name)):
            if journal.get('action') != 'confirm_group' or journal['status'] != 'committed':
                continue
            request_id = journal['request_id']
            remaining = [target['meeting'] for target in journal['targets'] if any(
                entry.get('group_transaction') == request_id
                for entry in data._document(target['meeting'], name)['history'])]
            if remaining:
                return dict(journal['result']['transaction'], remaining_meetings=remaining)
        return None
