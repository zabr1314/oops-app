#!/usr/bin/env python3
"""Approved DeepSeek chain on the 97-minute 10-05 discussion (labelling-site sentences, blind tests excluded).

User approval (2026-10-15): whole-meeting minutes with the production 3-run vote, production task wording
for every sentence Jev filed as a commitment, and production question detection, with a hard ceiling of
RMB 2.00. Runs only after the Jev reanalysis, whose tags it reads.

Production prompts and parsing are reused unchanged through their `complete_json(system, user)` interface;
the only deliberate difference is that the minutes see the whole transcript instead of production's
40,000-character middle cut. Each request reserves its worst case before sending, settles on reported
usage at a conservative RMB 2 / 8 per million input / output tokens, and an unknown outcome stops the run.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time
import types
import urllib.request
import uuid

import jev_label_reanalysis as jl
from jev_reanalysis import Stop, atomic, now, NoRedirect

TOTAL_CAP = 2_000_000_000            # nano-CNY, explicitly approved
INPUT_NANOS, OUTPUT_NANOS = 2_000, 8_000   # per token: RMB 2 / 8 per million
MAX_OUTPUT = 8192
STARTS = {'0235': '2026-10-05T22:18:24+08:00', '0236': '2026-10-05T23:01:43+08:00', '0238': '2026-10-05T23:26:47+08:00'}
TEAM = ['林春源', '洪玉麟', '江古月', '黄丽萍']
URL = 'https://api.deepseek.com/chat/completions'


class Ledger:
    def __init__(self, path, config, cap):
        self.path, self.cap, self.lock = Path(path), cap, threading.Lock()
        if self.path.exists():
            raise Stop('job_already_started_read_existing_checkpoint')
        self.value = dict(version=1, config=config, cap_nanos=cap, spent_nanos=0, reserved_nanos=0, requests=[])
        atomic(self.path, self.value)

    def reserve(self, chars, context):
        worst = (chars + 200) * INPUT_NANOS + MAX_OUTPUT * OUTPUT_NANOS
        with self.lock:
            if self.value['spent_nanos'] + self.value['reserved_nanos'] + worst > self.cap:
                raise Stop('budget_exposure_limit')
            record = dict(id=uuid.uuid4().hex, status='pending', reserved_nanos=worst, started_at=now(), **context)
            self.value['requests'].append(record)
            self.value['reserved_nanos'] += worst
            atomic(self.path, self.value)
            return record

    def settle(self, record, usage):
        prompt, completion = usage.get('prompt_tokens'), usage.get('completion_tokens')
        with self.lock:
            if not all(type(v) is int and 0 <= v <= 200_000 for v in (prompt, completion)):
                record['status'] = 'unknown'; atomic(self.path, self.value)
                raise Stop('provider_usage_unknown')
            cost = prompt * INPUT_NANOS + completion * OUTPUT_NANOS
            self.value['reserved_nanos'] -= record['reserved_nanos']
            self.value['spent_nanos'] += cost
            record.update(status='settled', prompt_tokens=prompt, completion_tokens=completion, cost_nanos=cost)
            atomic(self.path, self.value)

    def unknown(self, record):
        with self.lock:
            if record['status'] == 'pending':
                record['status'] = 'unknown'; atomic(self.path, self.value)

    def summary(self):
        with self.lock:
            requests = self.value['requests']
            return dict(approved_cny=self.cap / 1e9, spent_cny=self.value['spent_nanos'] / 1e9,
                reserved_cny=self.value['reserved_nanos'] / 1e9,
                exposure_cny=(self.value['spent_nanos'] + self.value['reserved_nanos']) / 1e9,
                request_count=len(requests), settled_requests=sum(r['status'] == 'settled' for r in requests),
                unknown_requests=sum(r['status'] != 'settled' for r in requests),
                prompt_tokens=sum(r.get('prompt_tokens', 0) for r in requests),
                completion_tokens=sum(r.get('completion_tokens', 0) for r in requests),
                accounting='RMB 2 / 8 per million input / output tokens, cache discounts ignored')


class GuardedDeepSeek:
    """Same interface as task_resolver.DeepSeek; every call is budgeted, recorded and never retried."""
    def __init__(self, key, ledger, report, save, source_check, model='deepseek-chat', sender=None):
        self.key, self.ledger, self.report, self.save, self.source_check = key, ledger, report, save, source_check
        self.model, self.step, self.lock = model, 'unknown', threading.Lock()
        self.sender = sender or urllib.request.build_opener(NoRedirect()).open

    def complete_json(self, system, user, timeout=20.0):
        self.source_check()
        body = {'model': self.model, 'temperature': 0, 'response_format': {'type': 'json_object'}, 'max_tokens': MAX_OUTPUT,
                'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}
        record = self.ledger.reserve(len(system) + len(user), dict(step=self.step))
        call = dict(step=self.step, request_id=record['id'], started_at=record['started_at'],
                    system_sha256=hashlib.sha256(system.encode()).hexdigest(), user=user)
        with self.lock:
            self.report['calls'].append(call)
        self.save()
        started = time.monotonic()
        try:
            request = urllib.request.Request(URL, data=json.dumps(body, ensure_ascii=False).encode(),
                headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
            with self.sender(request, timeout=max(timeout, 30)) as response:
                result = json.loads(response.read(4 * 1024 * 1024))
            call.update(latency_ms=int((time.monotonic() - started) * 1000), model=result.get('model'),
                        usage=result.get('usage'), content=result['choices'][0]['message']['content'], status='received')
            self.save()
            self.ledger.settle(record, result.get('usage') or {})
            self.save()
            return json.loads(call['content']), result.get('model', self.model)
        except BaseException as error:
            self.ledger.unknown(record)
            call.update(status=call.get('status', 'unknown'), error_type=type(error).__name__,
                        latency_ms=int((time.monotonic() - started) * 1000))
            self.save()
            if isinstance(error, Stop):
                raise
            raise Stop('provider_call_outcome_unknown_no_retry') from None


def merged_rows(label_dir):
    """All non-blind sentences on the evening's real clock, IDs prefixed by recording."""
    rows, _ = jl.load_rows(label_dir)
    base = dt.datetime.fromisoformat(STARTS['0235'])
    out = []
    for r in rows:
        offset = int((dt.datetime.fromisoformat(STARTS[r['meeting']]) - base).total_seconds() * 1000)
        out.append(dict(r, start_ms=r['start_ms'] + offset, end_ms=r['end_ms'] + offset))
    return sorted(out, key=lambda r: (r['start_ms'], r['id']))


def jev_tags(paths):
    tags = {}
    for path in paths:
        report = json.loads(Path(path).read_text())
        if not str(report.get('run_id', '')).startswith(jl.RUN_PREFIX):
            raise Stop('jev_report_from_another_run')
        for event in report.get('events') or []:
            if event.get('kind') == 'tag':
                tags[event['id']] = (event.get('result') or {}).get('tag')
    return tags


def load_key(path):
    for line in Path(path).read_text().splitlines():
        if line.startswith('DEEPSEEK_API_KEY='):
            return line.split('=', 1)[1].strip()
    raise Stop('deepseek_credentials_unavailable')


def run(args, sender=None):
    sys.path.insert(1, str(Path(args.app).resolve()))
    import feishu_actions
    import question_watch
    import task_resolver
    rows = merged_rows(args.label_dir)
    tags = jev_tags(args.jev_report)
    source = jl.fingerprint(args.label_dir)
    commitments = [r for r in rows if tags.get(r['id']) == 'commitment']
    questions = [r for r in rows if question_watch.looks_like_question(r['text'])]
    plan = dict(sentences=len(rows), jev_tagged=len(tags), commitments=len(commitments), question_like=len(questions),
                transcript_chars=sum(len(r['text']) + 30 for r in rows), source_hash=source, cap_cny=args.cap_cny,
                steps=args.steps)
    if len(tags) < len(rows):
        raise Stop('jev_reanalysis_incomplete')
    if not args.apply:
        return dict(status='preflight_only', network_calls=0, **plan)
    if args.expected_source_hash != source:
        raise Stop('approved_source_snapshot_changed')
    job = Path(args.work_dir) / args.run_id
    job.mkdir(parents=True, mode=0o700, exist_ok=False)
    lock_fd = os.open(job / 'run.lock', os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stamp = {str(p): (p.stat().st_mtime_ns, p.stat().st_size) for p in jl.source_files(args.label_dir)}
    report = dict(version=1, kind='deepseek_chain', run_id=args.run_id, source_hash=source, created_at=now(), plan=plan,
                  status='running', calls=[], minutes=None, tasks={}, questions=None,
                  note='Production prompts and parsing; minutes see the whole transcript (production cuts the middle past 40,000 characters).')
    ledger = Ledger(job / 'budget.json', dict(run_id=args.run_id, source_hash=source, steps=args.steps), round(args.cap_cny * 1e9))
    save_lock = threading.Lock()

    def save():
        with save_lock:
            report['budget'] = ledger.summary()
            atomic(job / 'progress.json', report)

    def source_check():
        for path in jl.source_files(args.label_dir):
            if (path.stat().st_mtime_ns, path.stat().st_size) != stamp[str(path)]:
                raise Stop('source_changed_during_run')

    model = GuardedDeepSeek(load_key(args.deepseek_env), ledger, report, save, source_check, sender=sender)
    utterances = [dict(id=r['id'], text=r['text'], start_ms=r['start_ms'], end_ms=r['end_ms'], speaker=r['speaker'],
                       tag=tags.get(r['id'])) for r in rows]
    row = dict(session_id='dji-1005-fine', started_at=STARTS['0235'], time_zone='Asia/Shanghai', utterances=utterances)
    try:
        if 'minutes' in args.steps:
            model.step = 'minutes'
            actions = feishu_actions.FeishuActions.__new__(feishu_actions.FeishuActions)
            # Team names come through the same people store production reads; no Feishu IDs are needed here.
            actions.backend = types.SimpleNamespace(resolver=model, people=types.SimpleNamespace(data={'people': {n: {} for n in TEAM}}))
            actions.asr_review, actions.log = None, lambda *a: None
            whole = lambda r, limit=None, tags=True, hints=None: feishu_actions.FeishuActions.transcript(
                actions, r, limit=10 ** 7, tags=tags, hints=hints)
            actions.transcript = whole
            report['minutes'] = actions.analyse(row)
            save()
        if 'tasks' in args.steps:
            model.step = 'tasks'
            transcript = [dict(id=u['id'], text=u['text'], speaker=u['speaker']) for u in utterances]
            for r in commitments:
                report['tasks'][r['id']] = task_resolver.resolve_all(model, transcript, r['id'])
                save()
        if 'questions' in args.steps:
            model.step = 'questions'
            report['questions'] = question_watch.plan_meeting(utterances, model, log=lambda *a: None)
            save()
        source_check()
        report['status'] = 'complete'
    except Stop as error:
        report.update(status='partial', stop_reason=str(error))
    except Exception as error:
        report.update(status='partial', stop_reason='local_processing_failed', error_type=type(error).__name__)
    finally:
        report['completed_at'] = now()
        save()
        destination = Path(args.output_dir)
        destination.mkdir(parents=True, mode=0o700, exist_ok=True)
        atomic(destination / (args.run_id + '.json'), report)
        os.close(lock_fd)
    return dict(run_id=args.run_id, status=report['status'], stop_reason=report.get('stop_reason'),
                tasks=len(report['tasks']), questions=len(report['questions'] or []),
                minutes_items=sum(len((report['minutes'] or {}).get(k) or []) for k in ('decisions', 'actions', 'undecided')),
                **ledger.summary())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--app', required=True)
    p.add_argument('--label-dir', required=True)
    p.add_argument('--jev-report', action='append', required=True)
    p.add_argument('--deepseek-env', required=True)
    p.add_argument('--run-id', required=True)
    p.add_argument('--work-dir', required=True)
    p.add_argument('--output-dir', required=True)
    p.add_argument('--cap-cny', type=float, default=2.00)
    p.add_argument('--steps', default='minutes,tasks,questions')
    p.add_argument('--expected-source-hash')
    p.add_argument('--apply', action='store_true')
    args = p.parse_args()
    args.steps = [s for s in args.steps.split(',') if s in ('minutes', 'tasks', 'questions')]
    if not args.run_id.startswith('dji-1005-deepseek') or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-_' for c in args.run_id):
        raise SystemExit('invalid_run_id')
    if not 0 < args.cap_cny <= TOTAL_CAP / 1e9:
        raise SystemExit('cap_outside_approval')
    try:
        print(json.dumps(run(args), ensure_ascii=False), flush=True)
    except Stop as error:
        print(json.dumps(dict(status='not_submitted', reason=str(error))), flush=True)


if __name__ == '__main__':
    main()
