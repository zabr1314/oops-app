#!/usr/bin/env python3
"""Approved Jev-only reanalysis of the 10-05 discussions at the labelling site's sentence granularity.

User approval (2026-10-15): re-run Jev on the finer sentences of 0235/0236/0238, excluding the fixed
blind-test sentences, with a total exposure ceiling of RMB 2.00 across every part of the run.

The labelling site's files are read-only inputs. Team-confirmed identities are passed as the speaker,
as the App passes a recognised speaker. The production tag / clause / conflict functions run in an
isolated object; only the Jev endpoint can be contacted, through jev_reanalysis.Transport, so each
request is reserved before sending, settled on reported usage, and an unknown outcome stops the run
without a retry. A stopped run can continue as a new part that skips finished sentences; the parts'
combined exposure never exceeds the ceiling.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import types
import urllib.request

import jev_reanalysis as base
from jev_reanalysis import Stop, atomic, now

MEETINGS = ('0235', '0236', '0238')
TOTAL_CAP = 2_000_000_000  # nano-CNY across all parts, explicitly approved by the user
RUN_PREFIX = 'dji-1005-fine'


def source_files(label_dir):
    root = Path(label_dir) / 'meetings'
    return [root / m / name for m in MEETINGS for name in ('meeting.json', 'suggestions.json')] + \
        [Path(label_dir) / 'identities' / 'shared.json']


def fingerprint(label_dir):
    digest = hashlib.sha256()
    for path in source_files(label_dir):
        digest.update(path.name.encode()); digest.update(path.read_bytes())
    return digest.hexdigest()


def confirmed_speakers(label_dir):
    shared = json.loads((Path(label_dir) / 'identities' / 'shared.json').read_text())
    who = {}
    for group in (shared.get('approvals') or {}).values():
        for member in group.get('members') or []:
            who[(member['meeting'], member['id'])] = group['speaker']
    return who


def load_rows(label_dir):
    """Fine sentences in meeting order, blind-test sentences removed, with any team-confirmed speaker."""
    who = confirmed_speakers(label_dir)
    rows, blind_total = [], 0
    for meeting in MEETINGS:
        folder = Path(label_dir) / 'meetings' / meeting
        utterances = json.loads((folder / 'meeting.json').read_text())['utterances']
        blind = json.loads((folder / 'suggestions.json').read_text()).get('blind') or {}
        blind_ids, blind_parents = set(blind.get('ids') or []), set(blind.get('parent_ids') or [])
        for u in sorted(utterances, key=lambda u: (u['start_ms'], u['id'])):
            if u['id'] in blind_ids or u.get('parent') in blind_parents:
                blind_total += 1
                continue
            rows.append(dict(meeting=meeting, id=meeting + '-' + u['id'], label_id=u['id'], parent=u.get('parent'),
                             text=u['text'], start_ms=u['start_ms'], end_ms=u['end_ms'],
                             speaker=who.get((meeting, u['id']))))
    return rows, blind_total


def previous_parts(paths):
    """Finished sentence IDs and the combined exposure of earlier parts of this run."""
    done, exposure, parts, tags, conflicts = set(), 0, [], {}, set()
    for path in paths or []:
        report = json.loads(Path(path).read_text())
        if not str(report.get('run_id', '')).startswith(RUN_PREFIX):
            raise Stop('previous_part_from_another_run')
        budget = report.get('budget') or {}
        spent, reserved = budget.get('spent_cny'), budget.get('reserved_cny')
        if not all(type(v) in (int, float) and v >= 0 for v in (spent, reserved)):
            raise Stop('previous_part_budget_unreadable')
        exposure += round((spent + reserved) * 1e9)
        for event in report.get('events') or []:
            if event.get('kind') == 'tag':
                done.add(event['id']); tags[event['id']] = event.get('result')
            elif event.get('kind') == 'conflict':
                conflicts.add(event['id'])
        parts.append(report['run_id'])
    return done, exposure, parts, tags, conflicts


def run(args):
    sys.path.insert(1, str(Path(args.app).resolve()))
    import local_backend as backend_module
    from meeting_features import judge_notice
    if backend_module.JEV_URL != base.URL:
        raise Stop('production_jev_endpoint_changed')
    rows, blind_total = load_rows(args.label_dir)
    source = fingerprint(args.label_dir)
    done, earlier, parts, prior_tags, prior_conflicts = previous_parts(args.previous)
    remaining = TOTAL_CAP - earlier
    cap = min(remaining, round(args.cap_cny * 1e9))
    todo = [r for r in rows if r['id'] not in done]
    plan = dict(sentences=len(rows), blind_excluded=blind_total, already_done=len(done), to_run=len(todo),
                confirmed_speakers=sum(1 for r in rows if r['speaker']), source_hash=source, model=base.MODEL,
                part_cap_cny=cap / 1e9, earlier_parts_exposure_cny=earlier / 1e9, total_cap_cny=TOTAL_CAP / 1e9)
    if cap <= base.RESERVATION:
        raise Stop('approved_total_budget_exhausted')
    if not args.apply:
        return dict(status='preflight_only', network_calls=0, **plan)
    if args.expected_source_hash != source:
        raise Stop('approved_source_snapshot_changed')
    job = Path(args.work_dir) / args.run_id
    job.mkdir(parents=True, mode=0o700, exist_ok=False)
    lock_fd = os.open(job / 'run.lock', os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    stamp = {str(p): (p.stat().st_mtime_ns, p.stat().st_size) for p in source_files(args.label_dir)}
    report = dict(version=1, kind='label_sentences', run_id=args.run_id, previous_parts=parts, source_hash=source,
        meetings=list(MEETINGS), created_at=now(), requested_model=base.MODEL, status='running', plan=plan,
        label='重新分析 · 团队讨论 10-05 细句', utterances=rows, events=[], raw_calls=[],
        scope='Jev-only whole tags, conditional clauses and conflicts on labelling-site sentences; blind-test sentences excluded',
        production_source_hashes={name: hashlib.sha256((Path(args.app) / name).read_bytes()).hexdigest()
                                  for name in ('local_backend.py', 'meeting_features.py')})
    ledger = base.Ledger(job / 'budget.json', dict(run_id=args.run_id, source_hash=source, model=base.MODEL,
        sentence_ids=[r['id'] for r in todo], allowed_steps=['whole_tag', 'task_clauses', 'conflict'],
        previous_parts=parts, earlier_exposure_nanos=earlier), cap=cap)

    def save():
        report['budget'] = ledger.summary()
        atomic(job / 'progress.json', report)

    def source_check():
        for path in source_files(args.label_dir):
            if (path.stat().st_mtime_ns, path.stat().st_size) != stamp[str(path)]:
                raise Stop('source_changed_during_reanalysis')

    save()
    transport = base.Transport(ledger, report, save, source_check)
    original_urlopen, original_opener = urllib.request.urlopen, urllib.request._opener
    collector = base.Collector()
    tags = backend_module.Backend.__new__(backend_module.Backend)
    tags.tags = backend_module.TagCache()
    tags.processing_trace = collector
    tags.jev = backend_module.load_jev(types.SimpleNamespace(jev_env=args.jev_env, jev_model=base.MODEL, no_jev=False))
    if tags.jev is None:
        raise Stop('jev_credentials_unavailable')
    tags.jev.model = base.MODEL
    finished = 0
    by_meeting = {m: [r for r in rows if r['meeting'] == m] for m in MEETINGS}
    try:
        urllib.request.urlopen = transport
        for r in todo:
            peers = by_meeting[r['meeting']]
            i = peers.index(r)
            context = [c['text'][-120:] for c in peers[max(0, i - 4):i]]
            transport.context = dict(utterance_id=r['id'], stage='tag')
            req = dict(session_id=RUN_PREFIX, utterance_id=r['id'], text=r['text'], start_ms=r['start_ms'],
                       end_ms=r['end_ms'], context=context)
            if r['speaker']:
                req['speaker'] = r['speaker']
            before = len(collector.events)
            result = tags.tag(req)
            event = (collector.events[-1] if len(collector.events) > before else
                     dict(kind='tag', id=r['id'], result=result, stages=[], recorded_at=now(), context=context))
            report['events'].append(event)
            finished += 1
            save()
            if finished % 25 == 0 or finished == len(todo):
                print(json.dumps(dict(phase='tag', completed=finished, total=len(todo), **ledger.summary())), flush=True)
        # Conflicts: each meeting's decisions and constraints against its own earlier ones, as in production.
        tagged = dict(prior_tags, **{e['id']: e['result'] for e in report['events'] if e.get('kind') == 'tag'})
        for meeting in MEETINGS:
            previous = []
            for r in by_meeting[meeting]:
                result = tagged.get(r['id'])
                if not result or result.get('tag') not in ('decision', 'constraint'):
                    continue
                current = {k: r[k] for k in ('id', 'text', 'start_ms', 'end_ms')}
                if previous and r['id'] not in prior_conflicts:
                    transport.context = dict(utterance_id=r['id'], stage='conflict')
                    started = time.monotonic()
                    value = judge_notice(dict(kind='conflict', session_id=RUN_PREFIX, utterance=current,
                                              previous=previous[-30:]), tags.jev, backend_module.overlap, [])
                    report['events'].append(dict(kind='conflict', id=r['id'], result=value,
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
        report['completed_tag_sentences'] = finished
        save()
        destination = Path(args.output_dir)
        destination.mkdir(parents=True, mode=0o700, exist_ok=True)
        atomic(destination / (args.run_id + '.json'), report)
        os.close(lock_fd)
    return dict(run_id=args.run_id, status=report['status'], completed_tag_sentences=finished,
                raw_calls=len(report['raw_calls']), stop_reason=report.get('stop_reason'), **ledger.summary())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--app', required=True)
    p.add_argument('--label-dir', required=True)
    p.add_argument('--jev-env', required=True)
    p.add_argument('--run-id', required=True)
    p.add_argument('--work-dir', required=True)
    p.add_argument('--output-dir', required=True)
    p.add_argument('--cap-cny', type=float, default=2.00)
    p.add_argument('--previous', action='append', help='Report of an earlier part of this run, to skip and count')
    p.add_argument('--expected-source-hash')
    p.add_argument('--apply', action='store_true')
    args = p.parse_args()
    if not args.run_id.startswith(RUN_PREFIX) or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-_' for c in args.run_id):
        raise SystemExit('invalid_run_id')
    if not 0 < args.cap_cny <= TOTAL_CAP / 1e9:
        raise SystemExit('cap_outside_approval')
    try:
        print(json.dumps(run(args), ensure_ascii=False), flush=True)
    except Stop as error:
        print(json.dumps(dict(status='not_submitted', reason=str(error))), flush=True)


if __name__ == '__main__':
    main()
