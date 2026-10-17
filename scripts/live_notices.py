"""Authenticated App projection of existing Sol observer checkpoints.

Only the owning meeting and explicitly configured read-only SQLite journal are
read here. A GET never creates a database, loads provider credentials or starts
an observer/model attempt.
"""
import json
import math
import os
import re
import sqlite3

from live_minutes import (LiveMinutesError, LiveMinutesStore, MODEL, digest,
                          in_scope, policy_status, read_config, snapshot_valid,
                          sources)


PROTOCOL = 'sol-observer-v1'
NOTICE_ID = re.compile(r'notice-[0-9a-f]{20}')
FINGERPRINT = re.compile(r'[0-9a-f]{64}')


class ProjectionUnavailable(ValueError):
    """Safe public reason only; never carry source text or filesystem paths."""


def _meeting(meetings, sid):
    """Read the raw owning row, preserving reviews and the original contract."""
    path = os.path.abspath(meetings.path(sid))
    if os.path.realpath(path) != path or os.path.exists(path + '.deleted'):
        raise ProjectionUnavailable('source_unavailable')
    try:
        with open(path, 'rb') as source:
            raw = source.read(64 * 1024 * 1024 + 1)
    except FileNotFoundError:
        raise ProjectionUnavailable('source_unavailable') from None
    if len(raw) > 64 * 1024 * 1024:
        raise ProjectionUnavailable('source_too_large')
    row = json.loads(raw)
    if (not isinstance(row, dict) or row.get('session_id') != sid
            or os.path.exists(path + '.deleted')):
        raise ProjectionUnavailable('source_unavailable')
    problem = policy_status(row)
    if problem:
        raise ProjectionUnavailable(problem)
    return row


def _config(path, row):
    if not path:
        raise ProjectionUnavailable('live_notice_config_unconfigured')
    config = read_config(path)
    if not in_scope(row, config):
        raise ProjectionUnavailable('scope_withdrawn')
    return config


def _evidence(ids, available, covered):
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 3
            or any(not isinstance(uid, str) or uid not in available or uid not in covered for uid in ids)
            or len(set(ids)) != len(ids)):
        raise ProjectionUnavailable('invalid_notice_evidence')
    return [{key: available[uid][key] for key in
             ('id', 'text', 'text_hash', 'start_ms', 'end_ms', 'speaker', 'binding')} for uid in ids]


def _notices(view, row):
    snapshot = view.get('snapshot')
    if (not snapshot_valid(snapshot, row) or not isinstance(snapshot.get('fingerprint'), str)
            or not FINGERPRINT.fullmatch(snapshot['fingerprint'])
            or snapshot['fingerprint'] != digest(dict(contract_hash=snapshot['contract_hash'],
                                                      sources=snapshot['source_hashes']))):
        raise ProjectionUnavailable('source_changed')
    values = (view.get('content') or {}).get('notices')
    if not isinstance(values, list) or len(values) > 30:
        raise ProjectionUnavailable('invalid_notice_checkpoint')
    current = sources(row)
    available = {value['id']: value for value in current}
    covered = {value['id'] for value in snapshot['source_hashes']}
    order = {value['id']: index for index, value in enumerate(current)}
    output, seen = [], set()
    for value in values:
        if not isinstance(value, dict):
            raise ProjectionUnavailable('invalid_notice_checkpoint')
        uid, text, question = value.get('id'), value.get('text'), value.get('question')
        if (not isinstance(uid, str) or not NOTICE_ID.fullmatch(uid) or uid in seen
                or value.get('kind') != 'conflict' or value.get('status') != 'open'
                or not isinstance(text, str) or not text.strip() or len(text) > 160
                or not isinstance(question, str) or not question.strip() or len(question) > 96):
            raise ProjectionUnavailable('invalid_notice_checkpoint')
        earlier = _evidence(value.get('earlier_ids'), available, covered)
        recent = _evidence(value.get('current_ids'), available, covered)
        if max(order[item['id']] for item in earlier) >= min(order[item['id']] for item in recent):
            raise ProjectionUnavailable('invalid_notice_evidence_order')
        seen.add(uid)
        output.append(dict(id=uid, kind='conflict', status='open', text=text, question=question,
                           earlier_ids=value['earlier_ids'], current_ids=value['current_ids'],
                           earlier=earlier, current=recent))
    return output


def _coverage(view):
    context = view.get('notice_context')
    coverage = context.get('coverage') if isinstance(context, dict) else None
    if (not isinstance(coverage, dict) or coverage.get('bounded') is not True
            or context.get('method') != 'bounded-current-source-evidence'):
        raise ProjectionUnavailable('invalid_notice_coverage')
    for key in ('start_ms', 'end_ms'):
        value = coverage.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ProjectionUnavailable('invalid_notice_coverage')
    counts = ('ignored_prefix_count', 'processed_count', 'earlier_source_count',
              'omitted_earlier_source_count', 'omitted_notice_count')
    if (any(type(coverage.get(key)) is not int or coverage[key] < 0 for key in counts)
            or coverage['processed_count'] < 1
            or coverage['start_ms'] != view['snapshot']['coverage_start_ms']
            or coverage['end_ms'] != view['snapshot']['covers_through_ms']):
        raise ProjectionUnavailable('invalid_notice_coverage')
    return {key: coverage[key] for key in ('start_ms', 'end_ms', *counts, 'bounded')}


def project(backend, sid, *, db_path=None, config_path=None):
    """Return candidates only from a valid, source-bound observer checkpoint."""
    result = dict(version=1, session_id=sid, source='live_agent', model=MODEL,
                  status='unavailable', reason='live_notice_db_unconfigured', notices=[],
                  notice_protocol=None, notice_evaluated=False, checkpoint_available=False,
                  is_previous=False, meeting_ended=False, attempt_id=None,
                  snapshot_fingerprint=None, transcript_expires_at=None, coverage=None)
    db_path = db_path if db_path is not None else os.environ.get('OOPS_LIVE_MINUTES_DB', '').strip()
    config_path = config_path if config_path is not None else os.environ.get('OOPS_LIVE_MINUTES_CONFIG', '').strip()
    if not db_path:
        return result
    try:
        row = _meeting(backend.meetings, sid)
        _config(config_path, row)
        store = LiveMinutesStore(db_path)
        view = store.view(row)
        result.update(status=view.get('status', 'unavailable'), reason=view.get('reason'),
                      meeting_ended=bool(row.get('ended_at')), is_previous=bool(view.get('is_previous')),
                      transcript_expires_at=row['storage_policy']['transcript_expires_at'])
        if view.get('status') not in ('ready', 'pending', 'ended'):
            return result
        if (view.get('model') != MODEL or view.get('checkpoint_available') is not True
                or view.get('notice_protocol') != PROTOCOL or view.get('notice_evaluated') is not True):
            return dict(result, status='unavailable', reason='observer_not_evaluated')
        attempt = view.get('checkpoint_attempt_id')
        if type(attempt) is not int or attempt < 1:
            raise ProjectionUnavailable('observer_attempt_unbound')
        notices = _notices(view, row)
        coverage = _coverage(view)
        capacity_omitted = (view.get('notice_context') or {}).get('capacity_omitted_count', 0)
        if type(capacity_omitted) is not int or not 0 <= capacity_omitted <= 2:
            raise ProjectionUnavailable('invalid_notice_capacity')
        # The model/store read is not authorization for a later source version.
        # Re-read the original row and switch before returning any private text.
        with backend.meetings.lock:
            fresh = _meeting(backend.meetings, sid)
            if not snapshot_valid(view['snapshot'], fresh):
                raise ProjectionUnavailable('source_changed')
            fresh_notices = _notices(view, fresh)
            if notices != fresh_notices:
                raise ProjectionUnavailable('source_changed')
            saved = store.session(sid)
            checkpoint = json.loads(saved['checkpoint_json']) if saved and saved.get('checkpoint_json') else None
            if (not checkpoint or checkpoint.get('attempt_id') != attempt
                    or checkpoint.get('session_id') != sid or checkpoint.get('model') != MODEL
                    or checkpoint.get('notice_protocol') != PROTOCOL or checkpoint.get('notice_evaluated') is not True
                    or checkpoint.get('content') != view.get('content')
                    or checkpoint.get('notice_context') != view.get('notice_context')
                    or (checkpoint.get('snapshot') or {}).get('fingerprint') != view['snapshot']['fingerprint']):
                raise ProjectionUnavailable('checkpoint_changed')
            if saved['status'] not in ('ready', 'pending', 'ended'):
                return dict(result, status=saved['status'], reason=saved.get('reason'))
            # Scope switches and natural expiry also apply during the read.
            _config(config_path, fresh)
            problem = policy_status(fresh)
            if problem:
                raise ProjectionUnavailable(problem)
            covered = {value['id'] for value in view['snapshot']['source_hashes']}
            begin = (view['snapshot']['coverage_start_ms'], view['snapshot']['coverage_start_id'])
            remaining = sum(value['id'] not in covered and (value['start_ms'], value['id']) >= begin
                            for value in sources(fresh))
        result.update(notices=fresh_notices, notice_protocol=PROTOCOL, notice_evaluated=True,
                      checkpoint_available=True, attempt_id=attempt,
                      snapshot_fingerprint=view['snapshot']['fingerprint'],
                      coverage=coverage,
                      capacity_omitted_count=capacity_omitted,
                      current=not remaining and saved['status'] == 'ready' and not fresh.get('ended_at'),
                      new_utterance_count=remaining, backlog=bool(remaining),
                      status=saved['status'], reason=saved.get('reason'),
                      meeting_ended=bool(fresh.get('ended_at')),
                      is_previous=saved['status'] != 'ready' or bool(fresh.get('ended_at')))
        if fresh.get('ended_at') and result['status'] == 'ready':
            result.update(status='ended', reason='meeting_ended')
        return result
    except ProjectionUnavailable as error:
        return dict(result, status='unavailable', reason=str(error), notices=[],
                    notice_evaluated=False, checkpoint_available=False)
    except (OSError, sqlite3.Error, LiveMinutesError, ValueError, KeyError, TypeError, AttributeError):
        return dict(result, status='unavailable', reason='live_notice_read_failed', notices=[],
                    notice_evaluated=False, checkpoint_available=False)
