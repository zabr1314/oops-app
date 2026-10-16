#!/usr/bin/env python3
"""One approved Jev-only reanalysis, with a durable RMB 0.10 exposure ceiling.

Original meetings are read-only. The current production tag/conflict functions
run in an isolated object, and only the Jev HTTPS endpoint can be contacted.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import urllib.request
import uuid

CAP = 100_000_000  # nano-CNY, explicitly approved by the user
TOKEN_COST = 336  # $0.042/M input tokens, conservative CNY 8/USD
TOKEN_BOUND = 65536
RESERVATION = TOKEN_COST * TOKEN_BOUND
URL = 'https://api.typesafe.ai/v1/systemone'
MODEL = 'jev-1.13.0'
SOURCE_ID = 'b763d5e1-ad2b-4d40-ba7f-6ca0d3590d4b'


class Stop(BaseException):
    """Must bypass the backend's ordinary fallback/retry handlers."""


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def atomic(path, value):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix='.reanalysis-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if os.path.exists(name): os.unlink(name)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Stop('redirect_forbidden')


class Ledger:
    def __init__(self, path, config, cap=CAP):
        self.path = Path(path)
        if self.path.exists():
            raise Stop('job_already_started_read_existing_checkpoint')
        if type(cap) is not int or not 0 < cap:
            raise Stop('invalid_budget_cap')
        self.cap = cap
        self.value = dict(version=1, config=config, cap_nanos=cap, spent_nanos=0, reserved_nanos=0, requests=[])
        self.save()

    def save(self): atomic(self.path, self.value)

    def reserve(self, body, context):
        encoded = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
        fingerprint = hashlib.sha256(encoded).hexdigest()
        if any(r['fingerprint'] == fingerprint and r['status'] != 'settled' for r in self.value['requests']):
            raise Stop('duplicate_submission_forbidden')
        if self.value['spent_nanos'] + self.value['reserved_nanos'] + RESERVATION > self.cap:
            raise Stop('budget_exposure_limit')
        record = dict(id=uuid.uuid4().hex, fingerprint=fingerprint, status='pending',
            reserved_nanos=RESERVATION, started_at=now(), **context)
        self.value['requests'].append(record)
        self.value['reserved_nanos'] += RESERVATION
        self.save()
        return record

    def unknown(self, record):
        if record['status'] == 'pending':
            record['status'] = 'unknown'
            self.save()

    def settle(self, record, response):
        usage = response.get('usage') if isinstance(response, dict) else None
        tokens = usage.get('input_tokens') if isinstance(usage, dict) else None
        if type(tokens) is not int or not 0 <= tokens <= TOKEN_BOUND:
            self.unknown(record)
            raise Stop('provider_usage_unknown_or_over_bound')
        if record['status'] != 'pending':
            raise Stop('request_already_settled')
        cost = tokens * TOKEN_COST
        self.value['reserved_nanos'] -= RESERVATION
        self.value['spent_nanos'] += cost
        record.update(status='settled', input_tokens=tokens, cost_nanos=cost)
        self.save()

    def summary(self):
        return dict(approved_cny=self.cap / 1e9, spent_cny=self.value['spent_nanos'] / 1e9,
            actual_cny=self.value['spent_nanos'] / 1e9, reserved_cny=self.value['reserved_nanos'] / 1e9,
            exposure_cny=(self.value['spent_nanos'] + self.value['reserved_nanos']) / 1e9,
            request_count=len(self.value['requests']),
            settled_requests=sum(r['status'] == 'settled' for r in self.value['requests']),
            unknown_requests=sum(r['status'] != 'settled' for r in self.value['requests']),
            input_tokens=sum(r.get('input_tokens', 0) for r in self.value['requests']),
            price_usd_per_million_input=.042, accounting_cny_per_usd=8,
            accounting='usage-based estimate; unknown outcomes retain full context reservation')


class Transport:
    def __init__(self, ledger, report, save, source_check, sender=None):
        self.ledger, self.report, self.save, self.source_check = ledger, report, save, source_check
        self.context = None
        self.opener = urllib.request.build_opener(NoRedirect())
        self.sender = sender or self.opener.open

    def __call__(self, request, *args, **kwargs):
        if (not isinstance(request, urllib.request.Request) or request.full_url != URL
                or request.get_method() != 'POST' or not self.context
                or set(kwargs) - {'timeout'} or args
                or request.get_header('Typesafe-danger-zone-long-context') is not None):
            raise Stop('network_scope_forbidden')
        try:
            body = json.loads(request.data)
            if (body.get('model') != MODEL or set(body) != {'model', 'state', 'questions'}
                    or not isinstance(body['questions'], dict) or not body['questions']):
                raise ValueError()
            if len(request.data) > 32000:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise Stop('model_or_request_scope_forbidden') from None
        self.source_check()
        context = dict(self.context)
        if context['stage'] == 'tag':
            context['stage'] = 'task_clauses' if all(k.startswith('c') and k[1:].isdigit() for k in body['questions']) else 'whole_tag'
        record = self.ledger.reserve(body, context)
        call = dict(utterance_id=context['utterance_id'], stage=context['stage'], attempt=1,
                    request=body, request_id=record['id'], started_at=record['started_at'])
        self.report['raw_calls'].append(call)
        self.save()
        started = time.monotonic()
        try:
            with self.sender(request, timeout=kwargs.get('timeout', 7)) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
            if len(raw) > 2 * 1024 * 1024:
                raise Stop('provider_response_too_large')
            data = json.loads(raw)
            call.update(response=data, latency_ms=int((time.monotonic() - started) * 1000), status='received')
            # Persist the complete response before releasing its worst-case reservation.
            self.save()
            self.ledger.settle(record, data)
            self.save()
            return io.BytesIO(raw)
        except BaseException as error:
            self.ledger.unknown(record)
            call.update(status='unknown' if record['status'] != 'settled' else 'received',
                        error_type=type(error).__name__, latency_ms=int((time.monotonic() - started) * 1000))
            self.save()
            if isinstance(error, Stop): raise
            raise Stop('provider_call_outcome_unknown_no_retry') from None


class Collector:
    def __init__(self): self.events = []

    def record_tag(self, request, result, stages=()):
        self.events.append(dict(kind='tag', id=request['utterance_id'], result=result,
            stages=list(stages), recorded_at=now(), context=request.get('context') or []))


def run(args):
    # Keep this runner's reviewed gateway schema first, production algorithm second.
    sys.path.insert(1, str(Path(args.app).resolve()))
    import local_backend as backend_module
    from meeting_features import judge_notice
    from replay_history import StoredHistory, reanalysis_source_hash, source_hash
    if args.session_id != SOURCE_ID:
        raise Stop('only_explicitly_approved_meeting_allowed')
    history = StoredHistory(args.state_dir)
    row = history.row(args.session_id)
    rows = sorted(row['utterances'], key=lambda u: (u['start_ms'], u['id']))
    if len(rows) != 38:
        raise Stop('approved_source_sentence_count_changed')
    if backend_module.JEV_URL != URL:
        raise Stop('production_jev_endpoint_changed')
    original_hash = reanalysis_source_hash(row)
    if not args.apply:
        return dict(status='preflight_only', source_hash=original_hash, sentences=38, model=MODEL,
                    approved_cny=.10, network_calls=0)
    if not args.expected_source_hash or original_hash != args.expected_source_hash:
        raise Stop('approved_source_snapshot_changed')
    job = Path(args.work_dir) / args.run_id
    job.mkdir(parents=True, mode=0o700, exist_ok=False)
    lock_fd = os.open(job / 'run.lock', os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    report = dict(version=1, run_id=args.run_id, source_session_id=args.session_id, source_hash=original_hash,
        source_snapshot=row, created_at=now(), requested_model=MODEL, status='running',
        label='重新分析 · 录音豆 App 与自媒体内容流程推进', utterances=rows, events=[], raw_calls=[],
        scope='Jev-only whole tags, conditional clauses and conflicts; existing minutes reused',
        production_source_hashes={name: hashlib.sha256((Path(args.app) / name).read_bytes()).hexdigest()
                                  for name in ('local_backend.py', 'meeting_features.py')})
    ledger = Ledger(job / 'budget.json', dict(run_id=args.run_id, source_session_id=args.session_id,
        source_hash=original_hash, sentence_ids=[u['id'] for u in rows], model=MODEL,
        allowed_steps=['whole_tag', 'task_clauses', 'conflict']))

    def save():
        report['budget'] = ledger.summary()
        atomic(job / 'progress.json', report)

    def source_check():
        if reanalysis_source_hash(history.row(args.session_id)) != original_hash:
            raise Stop('source_changed_during_reanalysis')

    save()
    transport = Transport(ledger, report, save, source_check)
    original_urlopen, original_opener = urllib.request.urlopen, urllib.request._opener
    collector = Collector()
    tags = backend_module.Backend.__new__(backend_module.Backend)
    tags.tags = backend_module.TagCache()
    tags.processing_trace = collector
    tags.jev = backend_module.load_jev(types.SimpleNamespace(jev_env=args.jev_env, jev_model=MODEL, no_jev=False))
    if tags.jev is None: raise Stop('jev_credentials_unavailable')
    tags.jev.model = MODEL
    results = []
    try:
        urllib.request.urlopen = transport
        for i, u in enumerate(rows):
            source_check()
            transport.context = dict(utterance_id=u['id'], stage='tag')
            context_rows = rows[max(0, i - 4):i]
            req = dict(session_id=args.session_id, utterance_id=u['id'], text=u['text'],
                start_ms=u['start_ms'], end_ms=u['end_ms'], context=[c['text'][-120:] for c in context_rows])
            before = len(collector.events)
            result = tags.tag(req)
            event = (collector.events[-1] if len(collector.events) > before else
                dict(kind='tag', id=u['id'], result=result, stages=[], recorded_at=now(), context=req['context']))
            event.update(source_hash=source_hash(u),
                context_sources=[dict(id=c['id'], source_hash=source_hash(c)) for c in context_rows])
            report['events'].append(event)
            results.append((u, result))
            save()
            print(json.dumps(dict(phase='tag', completed=i + 1, total=38, **ledger.summary())), flush=True)
        previous = []
        for u, result in results:
            if result['tag'] not in ('decision', 'constraint'):
                continue
            current = {k: u[k] for k in ('id', 'text', 'start_ms', 'end_ms')}
            if previous:
                transport.context = dict(utterance_id=u['id'], stage='conflict')
                started = time.monotonic()
                value = judge_notice(dict(kind='conflict', session_id=args.session_id,
                    utterance=current, previous=previous[-30:]), tags.jev, backend_module.overlap, [])
                report['events'].append(dict(kind='conflict', id=u['id'], result=value,
                    latency_ms=int((time.monotonic() - started) * 1000), recorded_at=now()))
                save()
            previous.append(current)
        source_check()
        report['status'] = 'complete'
    except Stop as error:
        report.update(status='partial', stop_reason=str(error))
    except Exception as error:
        report.update(status='partial', stop_reason='local_processing_failed', error_type=type(error).__name__)
    finally:
        urllib.request.urlopen, urllib.request._opener = original_urlopen, original_opener
        report['completed_at'] = now()
        report['completed_tag_sentences'] = len(results)
        save()
        destination = Path(args.output_dir)
        destination.mkdir(parents=True, mode=0o700, exist_ok=True)
        atomic(destination / (args.run_id + '.json'), report)
        os.close(lock_fd)
    return dict(run_id=args.run_id, status=report['status'], completed_tag_sentences=len(results),
                raw_calls=len(report['raw_calls']), stop_reason=report.get('stop_reason'), **ledger.summary())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--app', required=True)
    p.add_argument('--state-dir', required=True)
    p.add_argument('--jev-env', required=True)
    p.add_argument('--session-id', default=SOURCE_ID)
    p.add_argument('--run-id', required=True)
    p.add_argument('--work-dir', required=True)
    p.add_argument('--output-dir', required=True)
    p.add_argument('--expected-source-hash')
    p.add_argument('--apply', action='store_true')
    args = p.parse_args()
    if not args.run_id or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-_' for c in args.run_id):
        raise SystemExit('invalid_run_id')
    try: print(json.dumps(run(args), ensure_ascii=False), flush=True)
    except Stop as error: print(json.dumps(dict(status='not_submitted', reason=str(error))), flush=True)


if __name__ == '__main__': main()
