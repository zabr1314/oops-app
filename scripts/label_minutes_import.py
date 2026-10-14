#!/usr/bin/env python3
"""Pure conversion of a current, stored meeting summary to the review site's schema.

The caller checks completion, sharing consent, expiry and summary freshness.
This module does no I/O, does not construct a resolver, and never asks a model.
Importing a name only carries a source-bound manual speaker correction; it
never confirms an owner or extends an existing cross-meeting voice group.
"""
import copy
import datetime as dt
import hashlib
import math
import re

import label_items
from label_workflow import digest, row_fingerprint


PROMPT_VERSION = 'minutes-import-v1'
CLIP_ID = re.compile(r'[A-Za-z0-9_-]{1,40}')
MEETING_ID = re.compile(r'[A-Za-z0-9_-]{1,100}')


def _text(value, limit):
    return re.sub(r'\s+', ' ', value).strip()[:limit] if isinstance(value, str) else ''


def _roster(value):
    """Name allowlist for this configured team, optionally with stable person IDs."""
    if isinstance(value, dict):
        out = {}
        for name, identity in value.items():
            if not isinstance(name, str) or not name.strip() or len(name) > 60:
                raise ValueError('invalid_team_roster')
            if isinstance(identity, dict):
                identity = identity.get('person_id') or identity.get('id')
            if identity is not None and (not isinstance(identity, str) or not identity):
                raise ValueError('invalid_team_roster')
            out[name] = identity
        return out
    if isinstance(value, (list, tuple)) and all(isinstance(name, str) and name.strip() and len(name) <= 60 for name in value):
        if len(value) != len(set(value)):
            raise ValueError('ambiguous_team_roster')
        return dict.fromkeys(value)
    raise ValueError('invalid_team_roster')


def _utc(value):
    if not isinstance(value, str):
        raise ValueError('source_timestamp_missing')
    normalized = value[:-1] + '+00:00' if value.endswith('Z') else value
    normalized = re.sub(r'\.(\d+)(?=[+-]\d{2}:\d{2}$)',
                        lambda match: '.' + match[1][:6].ljust(6, '0'), normalized)
    stamp = dt.datetime.fromisoformat(normalized)
    if stamp.tzinfo is None:
        raise ValueError('source_timestamp_without_timezone')
    return stamp.astimezone(dt.timezone.utc).isoformat(timespec='seconds')


def _aliases(rows):
    ids = [row.get('id') for row in rows if isinstance(row, dict)]
    if len(ids) != len(rows) or any(not isinstance(uid, str) or not uid or len(uid) > 1000 for uid in ids) \
            or len(set(ids)) != len(ids):
        raise ValueError('source_ids_invalid')
    occupied = {uid for uid in ids if CLIP_ID.fullmatch(uid)}
    mapped = {}
    for uid in sorted(ids):
        if CLIP_ID.fullmatch(uid):
            mapped[uid] = uid
            continue
        hashed = hashlib.sha256(uid.encode()).hexdigest()
        alias = next(('u-' + hashed[:length] for length in (32, 36, 38)
                      if 'u-' + hashed[:length] not in occupied), None)
        if alias is None:
            raise ValueError('source_alias_collision')
        mapped[uid] = alias
        occupied.add(alias)
    return mapped


def _manual_speaker(row, original, review, roster, session):
    speaker = review.get('speaker')
    if speaker not in roster or review.get('source_changed_at'):
        return
    # A display-name collision with an explicit different person ID fails closed.
    person_id = review.get('speaker_person_id') or review.get('speaker_id') or review.get('person_id')
    if person_id is not None and (not roster.get(speaker) or person_id != roster[speaker]):
        return
    row['confirmed_speaker'] = speaker
    if roster.get(speaker):
        row['confirmed_person_id'] = roster[speaker]
    row['speaker_source'] = dict(mode='backend_manual', fingerprint=row_fingerprint(row),
        by=review.get('by'), at=review.get('at'), source_session_id=session,
        source_utterance_id=original['id'], text_sha256=hashlib.sha256(row['text'].encode()).hexdigest())


def _evidence(ids, aliases, rows, positions):
    # A cached item with any missing cited original is incomplete; do not turn
    # its surviving fragment into apparently sufficient evidence.
    if not isinstance(ids, list) or not ids or any(not isinstance(uid, str) or uid not in aliases for uid in ids):
        return None
    selected = sorted({aliases[uid] for uid in ids}, key=positions.__getitem__)
    spans = []
    by_id = {row['id']: row for row in rows}
    for uid in selected:
        row = by_id[uid]
        if row['end_ms'] - row['start_ms'] > label_items.MAX_SPAN_MS:
            return None
        if (spans and positions[uid] == positions[spans[-1][-1]] + 1
                and row['end_ms'] - by_id[spans[-1][0]]['start_ms'] <= label_items.MAX_SPAN_MS):
            spans[-1].append(uid)
        else:
            spans.append([uid])
    return spans


def build_bundle(row, analysis, minutes_fingerprint, short_id, shared_roster):
    """Return ``{meeting, items}`` without mutating inputs or writing any data.

    ``minutes_fingerprint`` must be the authoritative cached summary's current
    source fingerprint, already checked by the caller. ``shared_roster`` is the
    explicitly configured destination team's name list or name→person-ID map.
    No per-person labels, voice group approvals or task owners are created.
    """
    if not isinstance(row, dict) or not isinstance(analysis, dict):
        raise ValueError('source_document_invalid')
    # Same guard as the live minutes API; a cached model answer is not permission
    # to turn an example or an unresolved ASR quantity into a task.
    from minutes_quality import project
    analysis = project(analysis, row)
    session = row.get('session_id')
    if not isinstance(session, str) or not MEETING_ID.fullmatch(session):
        raise ValueError('source_session_invalid')
    if not isinstance(short_id, str) or not MEETING_ID.fullmatch(short_id):
        raise ValueError('destination_id_invalid')
    if not isinstance(minutes_fingerprint, str) or not re.fullmatch(r'[a-f0-9]{64}', minutes_fingerprint):
        raise ValueError('minutes_fingerprint_invalid')
    if row.get('transcript_status') == 'expired' or row.get('deleted') or row.get('analysis_invalidated'):
        raise ValueError('source_unavailable')
    policy = copy.deepcopy(row.get('storage_policy'))
    if (row.get('recording_mode') == 'daily' or policy is not None and
            (not isinstance(policy, dict) or policy.get('recording_mode') != 'meeting'
             or policy.get('cloud_save_confirmed') is not True)):
        raise ValueError('source_not_a_cloud_meeting')
    roster = _roster(shared_roster)
    originals = row.get('utterances')
    if not isinstance(originals, list) or not originals:
        raise ValueError('source_transcript_missing')
    aliases = _aliases(originals)
    imported = []
    for original in originals:
        start, end = original.get('start_ms'), original.get('end_ms')
        if (any(type(value) not in (int, float) or not math.isfinite(value) for value in (start, end))
                or not 0 <= start < end or not isinstance(original.get('text'), str) or not original['text'].strip()):
            raise ValueError('source_sentence_invalid')
        utterance = dict(id=aliases[original['id']], origin_id=original['id'], text=original['text'],
                         start_ms=start, end_ms=end)
        if isinstance(original.get('parent'), str):
            utterance['parent'] = original['parent']
        if isinstance(original.get('speaker'), str) and original['speaker']:
            utterance['speaker_hint'] = original['speaker']
        review = original.get('review')
        if not isinstance(review, dict):
            review = (row.get('reviews') or {}).get(original['id'], {})
        if isinstance(review, dict):
            _manual_speaker(utterance, original, review, roster, session)
        imported.append(utterance)
    imported.sort(key=lambda value: (value['start_ms'], value['origin_id']))
    by_id = {value['id']: value for value in imported}
    positions = {value['id']: index for index, value in enumerate(imported)}
    source_hash = label_items.source_hash(imported)
    revision = digest(dict(source_session=session, source_hash=source_hash,
                           minutes_fingerprint=minutes_fingerprint, analysis=analysis))
    # Retry/sync timestamps and name edits must not make a new import version.
    updated = _utc(row.get('ended_at') or row.get('started_at'))
    source = dict(source_session=session, source_revision=revision,
                  source_minutes_fingerprint=minutes_fingerprint, source_kind='existing_summary')
    meeting = dict(id=short_id, session=session, title=row.get('display_title') or row.get('title') or analysis.get('theme') or '会议',
        started_at=row.get('started_at'), ended_at=row.get('ended_at'), time_zone=row.get('time_zone') or 'UTC',
        storage_policy=policy, imported=True, audio_available=True, shared_roster=list(roster),
        processing=dict(stage='ready', revision=revision, updated_at=updated, reason_code=None, retryable=False),
        utterances=imported, origin_id_map={alias: uid for uid, alias in aliases.items()}, **source)

    proposals = []
    for action in analysis.get('actions') or []:
        if isinstance(action, dict):
            proposals.append(dict(kind='task', title=action.get('task'), detail=action.get('detail'),
                due=action.get('due'), ids=action.get('ids'), owner_hint=action.get('owner')))
    for decision in analysis.get('decisions') or []:
        if isinstance(decision, dict):
            proposals.append(dict(kind='decision', title=decision.get('text'), ids=decision.get('ids')))
    for undecided in analysis.get('undecided') or []:
        if isinstance(undecided, dict):
            proposals.append(dict(kind='open', title=undecided.get('topic'), detail=undecided.get('views'), ids=undecided.get('ids')))
    for question in analysis.get('open_questions') or []:
        if isinstance(question, dict):
            proposals.append(dict(kind='open', title=question.get('question'),
                detail='需要查资料或事实才能回答', ids=[question['id']] if question.get('id') else question.get('ids')))
    items, dropped = [], 0
    for proposal in proposals:
        title = _text(proposal['title'], label_items.MAX_TITLE)
        evidence = _evidence(proposal.get('ids'), aliases, imported, positions)
        if len(title) < 2 or not evidence or len(items) >= label_items.MAX_ITEMS:
            dropped += 1
            continue
        item = dict(kind=proposal['kind'], title=title, detail=_text(proposal.get('detail'), label_items.MAX_DETAIL),
                    due=_text(proposal.get('due'), 40), claimed=False, evidence=evidence)
        owner_hint = _text(proposal.get('owner_hint'), 60)
        if owner_hint in roster:
            item['owner_hint'] = owner_hint  # Never a selected or confirmed task owner.
        item['fingerprint'] = label_items.item_fingerprint(item, by_id)
        item['id'] = 'ai-' + item['fingerprint'][:12]
        if any(existing['id'] == item['id'] for existing in items):
            dropped += 1
            continue
        items.append(item)
    document = dict(schema=label_items.SCHEMA, meeting_id=short_id, prompt_version=PROMPT_VERSION,
        model='stored-minutes', summary_version=analysis.get('version'), source_hash=source_hash,
        status='ready', updated_at=updated, blind_ids=[], items=items, dropped=dropped, attempts=[],
        charged_upper_cny=0, **source)
    return dict(meeting=meeting, items=document)
