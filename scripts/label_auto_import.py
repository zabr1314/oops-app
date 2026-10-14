#!/usr/bin/env python3
"""Reconcile newly ended cloud meetings into the review site using already stored minutes.

Reads the project backend's files only. No API credentials, model calls, Feishu
writes or generation retries. A separate explicit policy authorizes this review
destination; cloud archive consent alone never enables the bridge.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import wave

from label_items import atomic_write

SESSION = re.compile(r'[A-Za-z0-9-]{8,80}')


def instant(value):
    value = re.sub(r'\.(\d+)(?=[+-]\d{2}:\d{2}$)', lambda m: '.' + m[1][:6].ljust(6, '0'),
                   value[:-1] + '+00:00' if value.endswith('Z') else value)
    parsed = dt.datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError('timestamp_timezone_required')
    return parsed.astimezone(dt.timezone.utc)


def stamp(now):
    return now.astimezone(dt.timezone.utc).isoformat(timespec='seconds')


def read(path, default=None):
    if not path.is_file():
        return default
    with path.open(encoding='utf-8') as stream:
        return json.load(stream)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def file_hash(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            result.update(block)
    return result.hexdigest()


def minutes_fingerprint(row):
    """Same evidence contract as FeishuActions.minutes_fingerprint, without constructing the bot."""
    utterances = [dict(id=u['id'], text=u.get('text'), start_ms=u.get('start_ms'), end_ms=u.get('end_ms'),
        speaker=u.get('speaker'), tag=u.get('tag'),
        review={key: (u.get('review') or {}).get(key) for key in ('speaker', 'owner', 'verdict')
                if (u.get('review') or {}).get(key) is not None})
        for u in sorted(row['utterances'], key=lambda value: (value['start_ms'], value['id']))]
    return digest(dict(started_at=row.get('started_at'), time_zone=row.get('time_zone'), utterances=utterances))


def load_policy(path, backend, destination):
    policy = read(path)
    if (not isinstance(policy, dict) or policy.get('schema') != 1
            or policy.get('authorization') != 'new_project_cloud_meetings_to_review_site'
            or policy.get('reuse_existing_minutes_only') is not True
            or Path(policy.get('backend_dir', '')).resolve() != backend
            or Path(policy.get('label_dir', '')).resolve() != destination
            or not isinstance(policy.get('baseline_sessions'), list)):
        raise ValueError('review_destination_not_authorized')
    instant(policy['enabled_after'])
    return policy


@contextlib.contextmanager
def lock(folder):
    with (folder / '.auto-import.lock').open('a+b') as stream:
        os.chmod(stream.name, 0o600)
        fcntl.flock(stream, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def roster(folder):
    from team_label import PEOPLE
    shared = read(folder / 'identities/shared.json', {})
    return sorted({a.get('speaker') for a in shared.get('approvals', {}).values() if a.get('speaker') in PEOPLE})


def eligible(row, policy):
    archive = row.get('storage_policy') or {}
    return (policy.get('enabled') is True and row['session_id'] not in policy['baseline_sessions']
        and instant(row['started_at']) >= instant(policy['enabled_after'])
        and archive.get('version') == 1 and archive.get('recording_mode') == 'meeting'
        and archive.get('cloud_save_confirmed') is True
        and not row.get('private') and row.get('review_export_scope') not in ('private', 'none', 'revoked'))


def live_guard(backend, destination, sid, expected_fingerprint=None, *, expected_revision=None,
               expected_audio_sha256=None):
    """Read-only HTTP guard: source withdrawal or edits take effect before the next timer tick."""
    try:
        backend, destination = Path(backend).resolve(), Path(destination).resolve()
        policy = load_policy(destination/'auto-import-policy.json', backend, destination)
        if policy.get('enabled') is not True:
            return dict(stage='waiting_policy', reason_code='review_destination_not_authorized')
        if not SESSION.fullmatch(sid) or (backend/'meetings'/(sid+'.json.deleted')).exists():
            return dict(stage='stale', reason_code='source_withdrawn')
        row = read(backend/'meetings'/(sid+'.json'))
        if not row or not eligible(row, policy) or not row.get('ended_at'):
            return dict(stage='stale', reason_code='source_withdrawn')
        if expected_fingerprint:
            for u in row.get('utterances', []):
                if u['id'] in row.get('reviews', {}): u['review'] = row['reviews'][u['id']]
            cache = read(backend/'feishu/state.json', {}).get('meetings', {}).get(sid, {})
            if (minutes_fingerprint(row) != expected_fingerprint or cache.get('analysis_invalidated')
                    or cache.get('analysis_fingerprint') != expected_fingerprint or not isinstance(cache.get('analysis'),dict)):
                return dict(stage='stale', reason_code='summary_source_changed')
            if expected_revision:
                from label_minutes_import import build_bundle
                current_revision = build_bundle(row, cache['analysis'], expected_fingerprint, '0000', [])['meeting']['source_revision']
                if current_revision != expected_revision:
                    return dict(stage='stale', reason_code='summary_source_changed')
            raw = backend/'recordings'/sid
            complete, manifest = read(raw/'complete.json'), read(raw/'manifest.json')
            if (not complete or not manifest or complete.get('session_id') != sid
                    or complete.get('files') != manifest.get('files')
                    or manifest.get('storage_policy') != row.get('storage_policy')):
                return dict(stage='waiting_transcript', reason_code='recording_upload_pending')
            if expected_audio_sha256 and (complete.get('files') or {}).get('audio.pcm', {}).get('sha256') != expected_audio_sha256:
                return dict(stage='stale', reason_code='recording_source_changed')
        return None
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return dict(stage='stale', reason_code='source_or_policy_unavailable')


def stage(stage, revision, now, reason=None, retryable=True):
    return dict(stage=stage, revision=revision, updated_at=stamp(now), reason_code=reason, retryable=retryable)


def placeholder(row, mid, processing, names):
    return dict(id=mid, session=row['session_id'], source_session=row['session_id'], imported=True,
        title=row.get('title') or (row.get('agenda') or {}).get('goal') or '新会议（' + mid + '）',
        started_at=row['started_at'], ended_at=row.get('ended_at'), time_zone=row.get('time_zone', 'UTC'),
        storage_policy=row.get('storage_policy'), utterances=[], shared_roster=names,
        processing=processing, audio_available=False, source_kind='existing_summary')


def purge_assets(folder, keep=()):
    """Only bridge-owned imported artifacts. Legacy three-meeting bundles are never touched."""
    for path in folder.iterdir():
        if path.name not in keep and (re.fullmatch(r'audio-[a-f0-9]{64}\.wav', path.name)
                                     or re.fullmatch(r'items-[a-f0-9]{64}\.json', path.name)):
            path.unlink()


def publish(folder, meeting, items=None, pcm=None, audio_sha=None):
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    if items is not None:
        revision = meeting['source_revision']
        item_name = 'items-' + revision + '.json'
        audio_name = 'audio-' + audio_sha + '.wav' if pcm else None
        if pcm and not (folder / audio_name).is_file():
            fd, temporary = tempfile.mkstemp(prefix='.audio-', dir=folder)
            os.close(fd)
            try:
                with wave.open(temporary, 'wb') as target, pcm.open('rb') as source:
                    target.setnchannels(1); target.setsampwidth(2); target.setframerate(16000)
                    copied = hashlib.sha256()
                    for block in iter(lambda: source.read(1 << 20), b''):
                        target.writeframesraw(block)
                        copied.update(block)
                if copied.hexdigest() != audio_sha:
                    raise ValueError('audio_changed_during_copy')
                os.chmod(temporary, 0o600)
                os.replace(temporary, folder / audio_name)
            finally:
                if os.path.exists(temporary): os.unlink(temporary)
        if read(folder / item_name) != items:
            atomic_write(str(folder / item_name), items)
        meeting.update(items_file=item_name, audio_file=audio_name, audio_available=bool(pcm))
    current = read(folder / 'meeting.json')
    # Stable wait states and unchanged ready bundles do not churn revisions/HTTP catalogs.
    comparable = lambda value: {**value, 'processing': {k: v for k, v in value.get('processing', {}).items() if k != 'updated_at'}}
    if current is None or comparable(current) != comparable(meeting):
        atomic_write(str(folder / 'meeting.json'), meeting)  # commit marker, always last
    purge_assets(folder, (meeting.get('items_file'), meeting.get('audio_file')))


def withdraw(folder, processing):
    previous = read(folder/'meeting.json')
    if previous and previous.get('imported'):
        previous.update(utterances=[], audio_available=False, processing=processing)
        previous.pop('items_file',None); previous.pop('audio_file',None)
        publish(folder,previous)
        return True
    return False


def reconcile(backend, destination, policy_file, now=None):
    from label_minutes_import import build_bundle
    now = now or dt.datetime.now(dt.timezone.utc)
    backend, destination = Path(backend).resolve(), Path(destination).resolve()
    if backend == destination or not (backend / 'meetings').is_dir() or not (destination / 'meetings').is_dir():
        raise ValueError('source_or_destination_invalid')
    try:
        policy = load_policy(Path(policy_file), backend, destination)
    except (OSError, ValueError, KeyError, TypeError):
        with lock(destination):
            for folder in (destination/'meetings').iterdir():
                if folder.is_dir() and re.fullmatch(r'\d{4}',folder.name):
                    withdraw(folder,stage('waiting_policy','policy-unavailable',now,'review_destination_not_authorized',False))
        raise ValueError('review_destination_not_authorized') from None
    state_file = destination / 'auto-import-state.json'
    with lock(destination):
        state = read(state_file, {'schema': 1, 'sessions': {}})
        known = state['sessions']
        try:
            bot_state = read(backend / 'feishu/state.json', {})
            if not isinstance(bot_state,dict) or not isinstance(bot_state.get('meetings',{}),dict):
                bot_state={}
        except (OSError, ValueError):
            bot_state = {}  # retention/withdrawal still runs while the summary store is unavailable
        names = roster(destination)
        summary = dict(model_calls=0, new=0, ready=0, waiting=0, withdrawn=0, failed=0)
        paths = {path.stem: path for path in (backend / 'meetings').glob('*.json') if SESSION.fullmatch(path.stem)}
        for sid in sorted(set(paths) | set(known)):
            entry = known.get(sid)
            row = None
            try:
                row = read(paths[sid]) if sid in paths else None
                if row is not None and not isinstance(row,dict):
                    raise ValueError('source_document_invalid')
                removed = (backend / 'meetings' / (sid + '.json.deleted')).exists()
                if row is None or removed or not eligible(row, policy):
                    if entry:
                        folder = destination / 'meetings' / entry['id']
                        previous = read(folder / 'meeting.json')
                        if previous and previous.get('imported'):
                            previous.update(utterances=[], audio_available=False,
                                processing=stage('stale', digest({'withdrawn': True}), now, 'source_withdrawn', False))
                            previous.pop('items_file', None); previous.pop('audio_file', None)
                            publish(folder, previous)
                            entry['status'] = 'withdrawn'; summary['withdrawn'] += 1
                    continue
                if not row.get('ended_at'):
                    if entry:
                        publish(destination / 'meetings' / entry['id'], placeholder(row, entry['id'],
                            stage('stale', 'meeting-running', now, 'meeting_resumed', False), names))
                        entry['status'] = 'stale'
                    continue  # running meetings never enter the after-meeting review site
                if entry is None:
                    occupied = {int(p.name) for p in (destination / 'meetings').iterdir() if re.fullmatch(r'\d{4}', p.name)}
                    occupied.update(int(e['id']) for e in known.values())
                    number = max(occupied or {0}) + 1
                    if number > 9999: raise ValueError('meeting_catalog_full')
                    entry = known[sid] = dict(id=f'{number:04d}')
                    atomic_write(str(state_file), state)  # durable stable mapping before any artifacts
                    summary['new'] += 1
                mid, folder = entry['id'], destination / 'meetings' / entry['id']
                archive = row['storage_policy']
                if row.get('transcript_status') == 'expired' or instant(archive['transcript_expires_at']) <= now:
                    publish(folder, placeholder(row, mid, stage('expired', 'transcript-expired', now, 'source_expired', False), names))
                    entry['status'] = 'expired'; summary['withdrawn'] += 1
                    continue
                raw = backend / 'recordings' / sid
                complete = read(raw / 'complete.json')
                manifest = read(raw / 'manifest.json')
                if not row.get('utterances') or not complete or not manifest:
                    publish(folder, placeholder(row, mid, stage('waiting_transcript', 'upload-pending', now, 'recording_upload_pending'), names))
                    entry['status'] = 'waiting_transcript'; summary['waiting'] += 1
                    continue
                if (manifest.get('storage_policy') != archive or complete.get('session_id') != sid
                        or complete.get('files') != manifest.get('files')):
                    raise ValueError('archive_contract_mismatch')
                # Overlay exactly the persisted human reviews used by the minutes fingerprint.
                for utterance in row['utterances']:
                    if utterance['id'] in row.get('reviews', {}):
                        utterance['review'] = row['reviews'][utterance['id']]
                cached = bot_state.get('meetings', {}).get(sid, {})
                if not isinstance(cached,dict):
                    cached={}
                fingerprint = minutes_fingerprint(row)
                if cached.get('analysis_invalidated') or (cached.get('analysis') and cached.get('analysis_fingerprint') != fingerprint):
                    publish(folder, placeholder(row, mid, stage('stale', fingerprint, now, 'summary_source_changed', False), names))
                    entry['status'] = 'stale'; summary['waiting'] += 1
                    continue
                if not isinstance(cached.get('analysis'), dict):
                    failed = (cached.get('failures') or 0) >= 6
                    status = 'failed' if failed else 'waiting_summary'
                    publish(folder, placeholder(row, mid, stage(status, fingerprint, now, 'summary_failed' if failed else 'summary_pending', not failed), names))
                    entry['status'] = status; summary['waiting'] += 1
                    continue
                bundle = build_bundle(row, cached['analysis'], fingerprint, mid, names)
                meeting, items = bundle['meeting'], bundle['items']
                meeting['processing'] = stage('ready', meeting['source_revision'], now, None, False)
                pcm, audio_sha = raw / 'audio.pcm', None
                audio_live = instant(archive['audio_expires_at']) > now and not manifest.get('audio_expired_at')
                if audio_live:
                    declaration = (complete.get('files') or {}).get('audio.pcm')
                    if not declaration or not pcm.is_file() or pcm.stat().st_size != declaration.get('size'):
                        raise ValueError('audio_archive_incomplete')
                    audio_sha = declaration['sha256']
                    audio_stat = [pcm.stat().st_size,pcm.stat().st_mtime_ns,pcm.stat().st_ctime_ns,audio_sha]
                    if (entry.get('audio_verified_stat') != audio_stat
                            or not (folder / ('audio-' + audio_sha + '.wav')).exists()) and file_hash(pcm) != audio_sha:
                        raise ValueError('audio_archive_hash_mismatch')
                    if any(u['end_ms'] * 32 > pcm.stat().st_size for u in row['utterances']):
                        raise ValueError('audio_evidence_out_of_range')
                # A late source edit, deletion or withdrawal cannot publish the earlier snapshot.
                latest = read(paths[sid])
                if latest is None or not eligible(latest, policy) or not latest.get('ended_at') \
                        or (backend / 'meetings' / (sid + '.json.deleted')).exists():
                    publish(folder, placeholder(row, mid, stage('stale', 'source-withdrawn', now, 'source_withdrawn', False), names))
                    entry['status'] = 'withdrawn'; summary['withdrawn'] += 1
                    continue
                for utterance in latest.get('utterances', []):
                    if utterance['id'] in latest.get('reviews', {}):
                        utterance['review'] = latest['reviews'][utterance['id']]
                latest_cache = read(backend / 'feishu/state.json', {}).get('meetings', {}).get(sid, {})
                if (minutes_fingerprint(latest) != fingerprint or latest_cache.get('analysis_invalidated')
                        or latest_cache.get('analysis_fingerprint') != fingerprint
                        or latest_cache.get('analysis') != cached['analysis']):
                    publish(folder, placeholder(row, mid, stage('stale', fingerprint, now, 'summary_source_changed', False), names))
                    entry['status'] = 'stale'; summary['waiting'] += 1
                    continue
                meeting.update(source_managed=True, source_backend=str(backend), source_audio_sha256=audio_sha)
                publish(folder, meeting, items, pcm if audio_live else None, audio_sha)
                entry.update(status='ready', source_revision=meeting['source_revision'])
                if audio_live:entry['audio_verified_stat']=audio_stat
                entry.pop('error_code', None)
                summary['ready'] += 1
            except (ValueError, KeyError, TypeError, OSError, AttributeError, json.JSONDecodeError):
                summary['failed'] += 1
                if entry:
                    entry['status'], entry['error_code'] = 'failed', 'archive_or_summary_unavailable'
                    failed=stage('failed','source-unavailable',now,entry['error_code'])
                    folder=destination/'meetings'/entry['id']
                    if not withdraw(folder,failed) and isinstance(row,dict) and row.get('started_at') and row.get('session_id'):
                        publish(folder,placeholder(row,entry['id'],failed,names))
        if read(state_file) != state:
            atomic_write(str(state_file), state)
        return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', required=True)
    parser.add_argument('--data', required=True)
    parser.add_argument('--policy', required=True)
    args = parser.parse_args()
    print(json.dumps(reconcile(args.backend, args.data, args.policy), ensure_ascii=False))


if __name__ == '__main__':
    main()
