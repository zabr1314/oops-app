#!/usr/bin/env python3
"""Read-only meeting history gateway. Never loads provider credentials or calls models.

The source of truth is the existing meetings/*.json and feishu/state.json store.
Access uses single-use, time-limited invites scoped to explicit meeting IDs, then
an HttpOnly cookie. The access database is separate from the meeting store.
"""
import argparse
import ast
import datetime as dt
import hashlib
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import contextmanager
from urllib.parse import parse_qs, unquote, urlsplit


ID = re.compile(r'[A-Za-z0-9_-]{1,100}')
STATIC = {'funnel.html', 'funnel.css', 'funnel.js', 'funnel-after.js', 'funnel-sample.json',
          'funnel-web.js', 'funnel-crawler.js', 'funnel-studio.css', 'funnel-studio.js', 'funnel-after-studio.js', 'funnel-after-studio.css', 'brand/mascot.png'}
STATIC.update('icons/' + name + '.svg' for name in ('desk', 'desktop', 'file-text', 'microphone',
              'magnifying-glass', 'note-pencil', 'paper-plane-tilt', 'check-circle'))


class HistoryError(ValueError):
    def __init__(self, status, code):
        super().__init__(code)
        self.status, self.code = status, code


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise HistoryError(400, 'invalid_meeting_id')
    return value


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def source_hash(row):
    return digest(dict({k: row.get(k) for k in ('id', 'text', 'start_ms', 'end_ms', 'speaker')},
                       reviewed_speaker=(row.get('review') or {}).get('speaker')))


def reanalysis_source_hash(row):
    """Bind a new analysis to all original input and effective human identity.

    The paid runner must import this same function rather than approximate its
    serialization. Volatile sync timestamps and derived outputs are excluded.
    """
    utterances = []
    reviews = row.get('reviews') or {}
    for source in sorted(row.get('utterances') or [], key=lambda u: (u.get('start_ms', 0), u['id'])):
        review = reviews.get(source['id']) or source.get('review') or {}
        utterances.append(dict({key: source.get(key) for key in
            ('id', 'text', 'start_ms', 'end_ms', 'speaker', 'tag', 'segments')},
            review={key: review.get(key) for key in ('speaker', 'owner', 'verdict', 'source_changed_at')
                    if review.get(key) is not None}))
    return digest(dict(session_id=row.get('session_id'), started_at=row.get('started_at'),
                       time_zone=row.get('time_zone'), utterances=utterances))


def read_json(path, limit=64 * 1024 * 1024):
    # Bounded, fresh reads avoid keeping a second transcript copy after deletion.
    with open(path, 'rb') as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise HistoryError(503, 'source_too_large')
    return json.loads(raw)


def transcript_expired(row, now=None):
    if row.get('transcript_status') == 'expired':
        return True
    policy = row.get('storage_policy')
    if policy:
        from archive_policy import expired
        return expired(policy, 'transcript', now)
    return False


def minutes_fingerprint(row):
    # Same input contract as FeishuActions.minutes_fingerprint; no bot instance.
    utterances = [dict(id=u['id'], text=u.get('text'), start_ms=u.get('start_ms'), end_ms=u.get('end_ms'),
        speaker=u.get('speaker'), tag=u.get('tag'),
        review={k: (u.get('review') or {}).get(k) for k in ('speaker', 'owner', 'verdict')
                if (u.get('review') or {}).get(k) is not None})
        for u in sorted(row['utterances'], key=lambda u: (u['start_ms'], u['id']))]
    return digest(dict(started_at=row.get('started_at'), time_zone=row.get('time_zone'), utterances=utterances))


def deployed_pipeline(source_dir):
    """Current installed configuration, explicitly separate from historical execution."""
    if not source_dir:
        return None
    out = dict(scope='deployed_source', label='当前部署源码配置，不代表该场历史实际执行',
               verified_at=dt.datetime.now(dt.timezone.utc).isoformat(), source_hashes={})
    trees = {}
    for name in ('local_backend.py', 'feishu_actions.py', 'minutes_vote.py'):
        path = os.path.join(source_dir, name)
        try:
            with open(path, 'rb') as stream:
                raw = stream.read(2 * 1024 * 1024)
            out['source_hashes'][name] = hashlib.sha256(raw).hexdigest()
            trees[name] = ast.parse(raw)
        except (FileNotFoundError, SyntaxError):
            continue
    for node in ast.walk(trees.get('feishu_actions.py', ast.Module(body=[], type_ignores=[]))):
        if isinstance(node, ast.FunctionDef) and node.name == 'after_meeting':
            out['legacy_auto_delivery_supported'] = any(isinstance(part, ast.Call)
                and isinstance(part.func, ast.Attribute) and part.func.attr in ('doc', 'share', 'dm_card', 'ledger_safe')
                for part in ast.walk(node))
        if isinstance(node, ast.FunctionDef) and node.name == 'tick_meeting':
            out['in_meeting_research'] = any(isinstance(part, ast.Attribute) and part.attr == 'scan_questions'
                                             for part in ast.walk(node))
            out['asr_review_supported'] = any(isinstance(part, ast.Attribute) and part.attr == 'asr_review'
                                              for part in ast.walk(node))
            out['asr_review_configured'], out['asr_review_wait_min'] = None, None
    for node in ast.walk(trees.get('feishu_actions.py', ast.Module(body=[], type_ignores=[]))):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'get':
            if len(node.args) > 1 and isinstance(node.args[0], ast.Constant) and node.args[0].value == 'OOPS_ASR_REVIEW_WAIT_MIN':
                if isinstance(node.args[1], ast.Constant):
                    try: out['asr_review_default_wait_min'] = int(node.args[1].value)
                    except (TypeError, ValueError): pass
    for node in ast.walk(trees.get('minutes_vote.py', ast.Module(body=[], type_ignores=[]))):
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'RUNS' for t in node.targets):
            if isinstance(node.value, ast.Constant) and type(node.value.value) is int:
                out['minutes_configured_runs'] = node.value.value
    return out


class StoredHistory:
    """Read the current owning store directly; no resync, cleanup write or model replay."""
    def __init__(self, state_dir, builder=None, minutes_file=None, backend_source_dir=None, reanalyses_dir=None,
                 reanalysis_builder=None):
        self.state_dir = os.path.realpath(state_dir)
        self.directory = os.path.join(self.state_dir, 'meetings')
        self.builder = builder
        self.minutes_file = minutes_file or os.path.join(self.state_dir, 'feishu', 'state.json')
        self.backend_source_dir = backend_source_dir
        self.reanalyses_dir = os.path.realpath(reanalyses_dir) if reanalyses_dir else None
        self.reanalysis_builder = reanalysis_builder

    def row(self, sid):
        sid = identifier(sid)
        path = os.path.join(self.directory, sid + '.json')
        if os.path.realpath(path) != path or os.path.exists(path + '.deleted'):
            raise HistoryError(404, 'meeting_unavailable')
        try:
            row = read_json(path)
        except FileNotFoundError:
            raise HistoryError(404, 'meeting_unavailable') from None
        if row.get('session_id') != sid or not isinstance(row.get('utterances'), list):
            raise HistoryError(503, 'source_invalid')
        if transcript_expired(row):
            # Do not expose retained excerpts as a replacement transcript.
            raise HistoryError(410, 'transcript_expired')
        reviews = row.get('reviews') or {}
        for utterance in row['utterances']:
            saved = reviews.get(utterance.get('id'))
            if saved and not saved.get('source_changed_at'):
                utterance['review'] = saved
        return row

    @staticmethod
    def traces(row):
        sources = {u['id']: source_hash(u) for u in row['utterances']}
        result = []
        for event in row.get('processing_trace') or []:
            if not isinstance(event, dict) or sources.get(event.get('id')) != event.get('source_hash'):
                continue
            event = dict(event)
            references = event.get('context_sources')
            # A trace must not resurrect removed/revised context. Older unbound
            # context retains only its presence flag; no historical raw copy.
            if (not isinstance(references, list) or any(not isinstance(ref, dict)
                    or sources.get(ref.get('id')) != ref.get('source_hash') for ref in references)):
                event.pop('context', None)
                event['context_status'] = 'not_recorded' if references is None else 'source_changed'
            else:
                event['validated_context'] = event.get('context') or []
            result.append(event)
        return result

    def minutes(self, row):
        try:
            state = read_json(self.minutes_file)
        except FileNotFoundError:
            return dict(status='unavailable', reason='not_recorded')
        entry = (state.get('meetings') or {}).get(row['session_id']) or {}
        analysis = entry.get('analysis')
        if not isinstance(analysis, dict):
            return dict(status='pending' if row.get('ended_at') else 'unavailable', reason='not_recorded')
        fingerprint = entry.get('analysis_fingerprint')
        reviewed = any(any((u.get('review') or {}).get(k) is not None for k in ('speaker', 'owner', 'verdict'))
                       for u in row['utterances'])
        if (entry.get('analysis_invalidated') or entry.get('transcript_expired')
                or (fingerprint and fingerprint != minutes_fingerprint(row)) or (not fingerprint and reviewed)):
            return dict(status='unavailable', reason='source_changed')
        # Current backend projection is deterministic; label it as recomputed in
        # the visualization, while the original model output remains unchanged.
        import minutes_quality
        generation = dict(recorded_calls=None, successful_runs=analysis.get('runs') if type(analysis.get('runs')) is int else None,
                          configured_runs=None, mode='majority_vote', evidence='stored',
                          source_binding='verified' if fingerprint else 'legacy_unverified')
        trace = entry.get('analysis_trace')
        if isinstance(trace, dict):
            generation.update({key: trace[key] for key in ('recorded_calls', 'successful_runs', 'configured_runs',
                                'latency_ms', 'mode') if key in trace})
            stamp = trace.get('recorded_at')
            if isinstance(stamp, str) and len(stamp) <= 40:
                try:
                    if dt.datetime.fromisoformat(stamp.replace('Z', '+00:00')).tzinfo:
                        generation['recorded_at'] = stamp
                except ValueError:
                    pass
        queries = (state.get('questions') or {}).get(row['session_id']) or {}
        ids = {u['id'] for u in row['utterances']}
        query_records = sum(uid in ids and isinstance(value, dict) for uid, value in queries.items()) if isinstance(queries, dict) else None
        return dict(status='ready', minutes=minutes_quality.project(analysis, row),
                    generation=generation, provenance='stored',
                    historical_records=dict(query_records=query_records),
                    delivery_record=dict(document_created=bool(entry.get('doc_url')) if 'doc_url' in entry else None,
                        sent_receipts=len(entry['sent']) if isinstance(entry.get('sent'), dict) else None,
                        ledger_written=bool(entry.get('ledger')) if 'ledger' in entry else None,
                        done=bool(entry.get('done')) if 'done' in entry else None),
                    message=None if fingerprint else '旧纪要未记录来源指纹；仅作历史结果查看，不证明当时完整处理过程。')

    def listing(self, scope):
        rows = []
        for sid in scope:
            try:
                row = self.row(sid)
            except HistoryError as error:
                if error.status in (404, 410):
                    continue
                raise
            minutes = self.minutes(row)
            theme = (minutes.get('minutes') or {}).get('theme')
            rows.append(dict(session_id=sid, title=row.get('title') or theme or (row.get('agenda') or {}).get('goal') or '会议',
                started_at=row.get('started_at'), ended_at=row.get('ended_at'),
                utterance_count=len(row['utterances']), trace_count=len(self.traces(row)),
                transcript_status=row.get('transcript_status', 'available'), minutes_status=minutes['status']))
        rows.sort(key=lambda r: r.get('started_at') or '', reverse=True)
        return dict(version=1, meetings=rows)

    def detail(self, sid, scope):
        identifier(sid)
        if sid not in scope:
            raise HistoryError(403, 'meeting_outside_scope')
        row = self.row(sid)
        if self.builder is None:
            from funnel_replay import build_stored
            builder = build_stored
        else:
            builder = self.builder
        result = builder(row, self.minutes(row), traces=self.traces(row))
        pipeline = deployed_pipeline(self.backend_source_dir)
        if pipeline:
            result['pipeline'] = dict(result.get('pipeline') or {}, **pipeline)
            generation = (result.get('post') or {}).get('generation')
            if isinstance(generation, dict) and pipeline.get('minutes_configured_runs') is not None:
                generation['configured_runs'] = pipeline['minutes_configured_runs']
        result.setdefault('source', {})['snapshot_hash'] = digest({key: result.get(key)
            for key in ('sentences', 'post', 'post_status')})
        return result

    def reanalysis_record(self, run_id):
        run_id = identifier(run_id)
        if not self.reanalyses_dir:
            raise HistoryError(404, 'reanalysis_unavailable')
        path = os.path.join(self.reanalyses_dir, run_id + '.json')
        if os.path.realpath(path) != path:
            raise HistoryError(404, 'reanalysis_unavailable')
        try:
            record = read_json(path)
        except FileNotFoundError:
            raise HistoryError(404, 'reanalysis_unavailable') from None
        if (not isinstance(record, dict) or record.get('version') != 1 or record.get('run_id') != run_id
                or not isinstance(record.get('source_hash'), str) or len(record['source_hash']) != 64):
            raise HistoryError(503, 'reanalysis_record_invalid')
        identifier(record.get('source_session_id'))
        return record

    def reanalysis_source(self, record, scope):
        sid = record['source_session_id']
        if sid not in scope:
            raise HistoryError(403, 'meeting_outside_scope')
        row = self.row(sid)  # enforces current deletion, TTL and active identity
        if record['source_hash'] != reanalysis_source_hash(row):
            raise HistoryError(409, 'reanalysis_source_changed')
        if isinstance(record.get('source_snapshot'), dict):
            if reanalysis_source_hash(record['source_snapshot']) != record['source_hash']:
                raise HistoryError(503, 'reanalysis_snapshot_invalid')
        return row

    def reanalysis_listing(self, scope, source_session_id=None):
        if source_session_id is not None:
            identifier(source_session_id)
            if source_session_id not in scope:
                raise HistoryError(403, 'meeting_outside_scope')
        if not self.reanalyses_dir or not os.path.isdir(self.reanalyses_dir):
            return dict(version=1, reanalyses=[])
        runs = []
        for name in sorted(os.listdir(self.reanalyses_dir)):
            if not name.endswith('.json') or not ID.fullmatch(name[:-5]):
                continue
            try:
                record = self.reanalysis_record(name[:-5])
            except (HistoryError, OSError, ValueError, TypeError, KeyError):
                continue
            sid = record['source_session_id']
            if sid not in scope or source_session_id is not None and sid != source_session_id:
                continue
            title, count = '来源不可用', 0
            try:
                row = self.reanalysis_source(record, scope)
                title = (row.get('display_title') or row.get('title')
                         or (self.minutes(row).get('minutes') or {}).get('theme')
                         or (row.get('agenda') or {}).get('goal') or '会议重新分析')
                count, status = len(row['utterances']), 'ready'
            except HistoryError as error:
                status = 'source_changed' if error.status == 409 else 'source_unavailable'
                if status == 'source_changed':
                    title = '来源已变化'
            runs.append(dict(run_id=record['run_id'], source_session_id=sid, session_id=sid, title=title,
                created_at=record.get('created_at'), utterance_count=count, status=status))
        runs.sort(key=lambda r: r.get('created_at') or '', reverse=True)
        return dict(version=1, reanalyses=runs)

    @staticmethod
    def safe_reanalysis(record):
        """Expose model bodies and structured choices, never transport credentials."""
        clean = {key: record[key] for key in ('version', 'run_id', 'source_session_id', 'source_hash',
            'created_at', 'requested_model', 'request_model', 'utterances', 'events', 'budget', 'status',
            'stop_reason', 'error_type', 'completed_at', 'completed_tag_sentences', 'scope',
            'production_source_hashes', 'label') if key in record}
        calls = []
        for call in record.get('raw_calls') or []:
            if not isinstance(call, dict):
                continue
            request = call.get('request') if isinstance(call.get('request'), dict) else {}
            response = call.get('response') if isinstance(call.get('response'), dict) else {}
            answers = response.get('answers')
            safe_answers = {key: {name: value[name] for name in ('choice', 'probabilities') if name in value}
                            for key, value in answers.items() if isinstance(value, dict)} if isinstance(answers, dict) else None
            value = {key: call[key] for key in ('utterance_id', 'stage', 'latency_ms', 'attempt', 'request_id',
                                               'error_type', 'status', 'started_at')
                     if key in call}
            value['request'] = {key: request[key] for key in ('model', 'state', 'questions') if key in request}
            value['response'] = {key: response[key] for key in ('model', 'usage', 'id', 'created') if key in response}
            if safe_answers is not None:
                value['response']['answers'] = safe_answers
            calls.append(value)
        clean['raw_calls'] = calls
        return clean

    def reanalysis_detail(self, run_id, scope):
        record = self.reanalysis_record(run_id)
        row = self.reanalysis_source(record, scope)
        if self.reanalysis_builder is None:
            from funnel_replay import build_reanalysis
            builder = build_reanalysis
        else:
            builder = self.reanalysis_builder
        result = builder(self.safe_reanalysis(record), row, self.minutes(row))
        pipeline = deployed_pipeline(self.backend_source_dir)
        if pipeline:
            result['pipeline'] = dict(result.get('pipeline') or {}, **pipeline)
        result.setdefault('source', {})['snapshot_hash'] = digest({key: result.get(key)
            for key in ('sentences', 'post', 'post_status')})
        return result


def cleanup_reanalyses(state_dir, reanalyses_dir, jobs_dir, receipts_dir=None):
    """Explicit retention worker: only private rerun copies, never source storage.

    The reader APIs remain read-only. Source changes revoke stale reruns; this
    worker also removes their sensitive disk copies and keeps numeric receipts.
    A running paid job holds run.lock and is skipped until it stops/checkpoints.
    """
    import fcntl
    from pathlib import Path
    history = StoredHistory(state_dir, reanalyses_dir=reanalyses_dir)
    published, jobs = Path(reanalyses_dir).resolve(), Path(jobs_dir).resolve()
    receipts = Path(receipts_dir).resolve() if receipts_dir else published.parent / 'reanalysis-receipts'
    source = Path(state_dir).resolve()
    # Explicitly reject accidentally configuring this worker over the owning
    # meeting store or over another one of its own directories.
    targets = [published, jobs, receipts]
    for target in targets:
        if target == source or source in target.parents or target in source.parents:
            raise ValueError('cleanup_target_overlaps_source')
    if len(set(targets)) != len(targets) or any(a in b.parents for a in targets for b in targets if a != b):
        raise ValueError('cleanup_targets_overlap')
    result = dict(published_removed=0, jobs_anonymized=0, receipts_kept=0, temporary_removed=0,
                  active_skipped=0, invalid_skipped=0)
    run_ids = {name[:-5] for name in os.listdir(published) if name.endswith('.json') and ID.fullmatch(name[:-5])} if published.is_dir() else set()
    publication_temps = {}
    if published.is_dir():
        for path in published.glob('.reanalysis-*'):
            if not path.is_file() or path.is_symlink():
                continue
            try:
                value = read_json(path)
                run_id = value.get('run_id') if isinstance(value, dict) else None
                if isinstance(run_id, str) and ID.fullmatch(run_id) and value.get('version') == 1:
                    publication_temps.setdefault(run_id, []).append(path)
                    run_ids.add(run_id)
            except (OSError, ValueError, TypeError):
                result['invalid_skipped'] += 1
    if jobs.is_dir():
        run_ids.update(name for name in os.listdir(jobs) if ID.fullmatch(name) and (jobs / name).is_dir() and not (jobs / name).is_symlink())

    def atomic_receipt(path, value):
        import tempfile
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        if path.is_symlink() or path.parent.resolve() != path.parent:
            raise ValueError('cleanup_receipt_path_invalid')
        fd, temporary = tempfile.mkstemp(prefix='.receipt-', dir=path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as target:
                json.dump(value, target, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    for run_id in sorted(run_ids):
        job, record_path = jobs / run_id, published / (run_id + '.json')
        if job.is_symlink() or record_path.is_symlink():
            result['invalid_skipped'] += 1
            continue
        lock = None
        try:
            if job.is_dir():
                lock = os.open(job / 'run.lock', os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    result['active_skipped'] += 1
                    continue
            progress_path, budget_path = job / 'progress.json', job / 'budget.json'
            if any(path.is_symlink() for path in (progress_path, budget_path)):
                result['invalid_skipped'] += 1
                continue
            record = read_json(record_path) if record_path.is_file() else read_json(progress_path) if progress_path.is_file() else None
            if record is None and publication_temps.get(run_id):
                record = read_json(publication_temps[run_id][0])
            budget = read_json(budget_path) if budget_path.is_file() else {}
            if not isinstance(record, dict):
                config = budget.get('config') if isinstance(budget, dict) else None
                record = dict(config, version=1) if isinstance(config, dict) else None
            if (not isinstance(record, dict) or record.get('run_id') != run_id
                    or not isinstance(record.get('source_hash'), str) or not re.fullmatch(r'[0-9a-f]{64}', record['source_hash'])
                    or not isinstance(record.get('source_session_id'), str) or not ID.fullmatch(record['source_session_id'])):
                result['invalid_skipped'] += 1
                continue
            if (record.get('content_purged') is True and not record_path.is_file()
                    and (not budget_path.is_file() or budget.get('content_purged') is True)
                    and not any(job.glob('.reanalysis-*')) and not publication_temps.get(run_id)):
                continue
            try:
                current = history.row(record['source_session_id'])
                reason = 'source_changed' if reanalysis_source_hash(current) != record['source_hash'] else None
            except HistoryError as error:
                if error.status not in (404, 410):
                    raise
                reason = 'source_deleted' if error.status == 404 else 'source_expired'
            if reason is None:
                continue
            numeric_keys = ('approved_cny', 'spent_cny', 'actual_cny', 'reserved_cny', 'exposure_cny', 'request_count',
                            'settled_requests', 'unknown_requests', 'input_tokens', 'price_usd_per_million_input',
                            'accounting_cny_per_usd', 'cap_nanos', 'spent_nanos', 'reserved_nanos')
            summary = record.get('budget') if isinstance(record.get('budget'), dict) else {}
            financial = {}
            for candidate in (budget if isinstance(budget, dict) else {}, summary):
                for key in numeric_keys:
                    value = candidate.get(key)
                    if type(value) in (int, float) and value >= 0 and value < float('inf'):
                        financial[key] = value
            if isinstance(budget, dict) and isinstance(budget.get('requests'), list):
                requests = [r for r in budget['requests'] if isinstance(r, dict)]
                financial['request_count'] = len(requests)
                financial['settled_requests'] = sum(r.get('status') == 'settled' for r in requests)
                financial['unknown_requests'] = sum(r.get('status') != 'settled' for r in requests)
            for nanos, cny in (('cap_nanos', 'approved_cny'), ('spent_nanos', 'spent_cny'), ('reserved_nanos', 'reserved_cny')):
                if nanos in financial:
                    financial[cny] = financial[nanos] / 1e9
            if 'spent_nanos' in financial:
                financial['actual_cny'] = financial['spent_nanos'] / 1e9
            if 'spent_nanos' in financial and 'reserved_nanos' in financial:
                financial['exposure_cny'] = (financial['spent_nanos'] + financial['reserved_nanos']) / 1e9
            receipt = dict(version=1, run_id=run_id, source_session_id=record['source_session_id'],
                source_hash=record['source_hash'], content_purged=True, cleanup_reason=reason,
                purged_at=dt.datetime.now(dt.timezone.utc).isoformat(), budget=financial)
            atomic_receipt(receipts / (run_id + '.json'), receipt)
            result['receipts_kept'] += 1
            if record_path.is_file():
                record_path.unlink()
                result['published_removed'] += 1
            for path in publication_temps.get(run_id, []):
                if path.is_file() and not path.is_symlink():
                    temporary = read_json(path)
                    if temporary.get('run_id') == run_id and temporary.get('source_hash') == record['source_hash']:
                        path.unlink()
                        result['temporary_removed'] += 1
            changed_job = False
            if job.is_dir():
                for path in (progress_path, budget_path):
                    if path.is_file():
                        atomic_receipt(path, receipt)
                        changed_job = True
                # A previous interrupted atomic save may contain the same raw
                # body; only the runner's known temporary filename is eligible.
                for path in job.glob('.reanalysis-*'):
                    if path.is_file() and not path.is_symlink():
                        path.unlink()
                        result['temporary_removed'] += 1
                if changed_job:
                    result['jobs_anonymized'] += 1
        except (OSError, ValueError, KeyError, TypeError, HistoryError):
            result['invalid_skipped'] += 1
        finally:
            if lock is not None:
                os.close(lock)
    return result


class ReplayAccess:
    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(path)), mode=0o700, exist_ok=True)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS access (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, '
                       'scope TEXT NOT NULL, expires REAL NOT NULL)')
        os.chmod(path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def key(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def mint(self, scope, seconds=7200):
        if not scope or not 60 <= seconds <= 86400:
            raise ValueError('Specify meeting IDs and a lifetime from 60 to 86400 seconds')
        scope = sorted({identifier(sid) for sid in scope})
        token = secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute('DELETE FROM access WHERE expires<=?', (time.time(),))
            db.execute('INSERT INTO access VALUES (?,?,?,?)',
                       (self.key(token), 'invite', json.dumps(scope), time.time() + seconds))
        return token

    def exchange(self, token):
        if not isinstance(token, str) or not 20 <= len(token) <= 128:
            raise HistoryError(401, 'invite_expired_or_used')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT scope,expires FROM access WHERE hash=? AND kind=?', (self.key(token), 'invite')).fetchone()
            if not row or row[1] <= time.time():
                raise HistoryError(401, 'invite_expired_or_used')
            db.execute('DELETE FROM access WHERE hash=?', (self.key(token),))
            session = secrets.token_urlsafe(32)
            db.execute('INSERT INTO access VALUES (?,?,?,?)', (self.key(session), 'session', row[0], row[1]))
        return session, max(0, int(row[1] - time.time()))

    def scope(self, token):
        if not isinstance(token, str) or not 20 <= len(token) <= 128:
            raise HistoryError(401, 'history_login_required')
        with self.connect() as db:
            row = db.execute('SELECT scope,expires FROM access WHERE hash=? AND kind=?', (self.key(token), 'session')).fetchone()
        if not row or row[1] <= time.time():
            raise HistoryError(401, 'history_session_expired')
        return json.loads(row[0])

    def revoke(self, token):
        if isinstance(token, str) and 20 <= len(token) <= 128:
            with self.connect() as db:
                db.execute('DELETE FROM access WHERE hash=? AND kind=?', (self.key(token), 'session'))


def make_handler(history, access, public_dir, url_prefix='/oops-meeting/history/', secure_cookie=True):
    from http.cookies import SimpleCookie
    cookie_name = 'oops_history'
    prefix = '/' + url_prefix.strip('/') + '/' if url_prefix.strip('/') else '/'
    public_root = os.path.realpath(public_dir)

    class HistoryHandler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(15)

        def log_message(self, *_):
            pass  # Never log paths, invites, cookies or meeting text.

        def send(self, status, value, kind='application/json; charset=utf-8', cookie=None, public_metadata=False):
            body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            for key, item in [('Content-Type', kind), ('Content-Length', str(len(body))), ('Cache-Control', 'no-store'),
                    ('X-Content-Type-Options', 'nosniff'), ('Referrer-Policy', 'no-referrer'),
                    ('X-Robots-Tag', 'noindex, nofollow'), ('Cross-Origin-Resource-Policy', 'same-origin')]:
                self.send_header(key, item)
            if cookie:
                self.send_header('Set-Cookie', cookie)
            if public_metadata:
                self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)

        def request_path(self):
            path = urlsplit(self.path).path
            if path.startswith(prefix):
                path = '/' + path[len(prefix):]
            return path

        def session_token(self):
            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get('Cookie', ''))
                token = cookie[cookie_name].value if cookie_name in cookie else ''
            except Exception:
                token = ''
            return token

        def authenticated(self):
            return access.scope(self.session_token())

        def do_GET(self):
            try:
                path = self.request_path()
                if path == '/healthz':
                    return self.send(200, dict(status='ok', read_only=True, provider_calls=False))
                if path == '/api/pipeline':
                    return self.send(200, deployed_pipeline(getattr(history, 'backend_source_dir', None)) or
                                     dict(scope='unknown', label='部署源码尚未配置，当前流水线未知'), public_metadata=True)
                if path == '/api/meetings':
                    return self.send(200, history.listing(self.authenticated()))
                if path == '/api/reanalyses':
                    query = parse_qs(urlsplit(self.path).query)
                    return self.send(200, history.reanalysis_listing(self.authenticated(),
                        query.get('source_session_id', query.get('source', [None]))[0]))
                match = re.fullmatch(r'/api/reanalyses/([^/]+)', path)
                if match:
                    return self.send(200, history.reanalysis_detail(unquote(match[1]), self.authenticated()))
                match = re.fullmatch(r'/api/meetings/([^/]+)', path)
                if match:
                    return self.send(200, history.detail(unquote(match[1]), self.authenticated()))
                name = 'funnel.html' if path == '/' else path.lstrip('/')
                if name not in STATIC:
                    raise HistoryError(404, 'not_found')
                static_path = os.path.join(public_root, name)
                # Even allowlisted assets must be the files deployed at that
                # exact path, never a symlink into private storage.
                if os.path.realpath(static_path) != os.path.abspath(static_path):
                    raise HistoryError(404, 'not_found')
                with open(static_path, 'rb') as stream:
                    value = stream.read(4 * 1024 * 1024)
                kind = mimetypes.guess_type(name)[0] or 'application/octet-stream'
                return self.send(200, value, kind + ('; charset=utf-8' if kind.startswith(('text/', 'application/javascript')) else ''))
            except HistoryError as error:
                self.send(error.status, dict(error=dict(code=error.code)))
            except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
                self.send(503, dict(error=dict(code='history_storage_unavailable')))

        def do_POST(self):
            try:
                if self.request_path() != '/api/session':
                    raise HistoryError(405, 'read_only')
                size = int(self.headers.get('Content-Length') or 0)
                if not 0 < size <= 512:
                    raise HistoryError(400, 'invalid_request')
                body = json.loads(self.rfile.read(size))
                token, remaining = access.exchange(body.get('invite') if isinstance(body, dict) else None)
                cookie = f'{cookie_name}={token}; HttpOnly; SameSite=Strict; Path={prefix}; Max-Age={remaining}'
                if secure_cookie:
                    cookie += '; Secure'
                self.send(200, dict(status='ready', expires_in=remaining), cookie=cookie)
            except HistoryError as error:
                self.send(error.status, dict(error=dict(code=error.code)))
            except (ValueError, OSError, TypeError):
                self.send(400, dict(error=dict(code='invalid_request')))
            except sqlite3.Error:
                self.send(503, dict(error=dict(code='history_access_unavailable')))

        def do_PUT(self):
            self.send(405, dict(error=dict(code='read_only')))

        def do_DELETE(self):
            if self.request_path() != '/api/session':
                return self.send(405, dict(error=dict(code='read_only')))
            try:
                access.revoke(self.session_token())
            except sqlite3.Error:
                return self.send(503, dict(error=dict(code='history_access_unavailable')))
            cookie = f'{cookie_name}=; HttpOnly; SameSite=Strict; Path={prefix}; Max-Age=0'
            if secure_cookie:
                cookie += '; Secure'
            self.send(200, dict(status='signed_out'), cookie=cookie)

    return HistoryHandler


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    mint = sub.add_parser('mint', help='Write one scoped, single-use invite to a private file')
    mint.add_argument('--access-db', required=True)
    mint.add_argument('--session-id', action='append', required=True)
    mint.add_argument('--seconds', type=int, default=7200)
    mint.add_argument('--out', required=True)
    cleanup = sub.add_parser('cleanup-reanalyses', help='Purge revoked rerun text and keep only numeric cost receipts')
    cleanup.add_argument('--state-dir', required=True)
    cleanup.add_argument('--reanalyses-dir', required=True)
    cleanup.add_argument('--jobs-dir', required=True)
    cleanup.add_argument('--receipts-dir')
    serve = sub.add_parser('serve')
    serve.add_argument('--state-dir', required=True)
    serve.add_argument('--access-db', required=True)
    serve.add_argument('--minutes-file', help='Explicit deployed minutes state path, if different from feishu/state.json')
    serve.add_argument('--backend-source-dir', help='Installed scripts directory, for current pipeline provenance')
    serve.add_argument('--reanalyses-dir', help='Private source-bound reruns; defaults beside the access database')
    serve.add_argument('--public-dir', default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'public'))
    serve.add_argument('--port', type=int, default=8797)
    serve.add_argument('--url-prefix', default='/oops-meeting/history/')
    serve.add_argument('--insecure-local-cookie', action='store_true', help='Only for local HTTP preview')
    args = parser.parse_args(argv)
    if args.command == 'cleanup-reanalyses':
        text = cleanup_reanalyses(args.state_dir, args.reanalyses_dir, args.jobs_dir, args.receipts_dir)
        print(json.dumps(text, sort_keys=True))
        return
    access = ReplayAccess(args.access_db)
    if args.command == 'mint':
        token = access.mint(args.session_id, args.seconds)
        fd = os.open(args.out, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as target:
            json.dump(dict(invite=token, session_ids=args.session_id, expires_in=args.seconds), target)
        print('Scoped invite written to private file; no provider calls.')
        return
    handler = make_handler(StoredHistory(args.state_dir, minutes_file=args.minutes_file,
                           backend_source_dir=args.backend_source_dir,
                           reanalyses_dir=args.reanalyses_dir or os.path.join(os.path.dirname(os.path.abspath(args.access_db)), 'reanalyses')),
                           access, args.public_dir, args.url_prefix,
                           secure_cookie=not args.insecure_local_cookie)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    print(f'Read-only history gateway listening on 127.0.0.1:{args.port}')
    server.serve_forever()


if __name__ == '__main__':
    main()
