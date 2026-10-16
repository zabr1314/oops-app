#!/usr/bin/env python3
"""Combine the approved fine-sentence Jev run and DeepSeek chain into one replay of the 97-minute 10-05 discussion.

Reads only saved results; makes no model call. Jev steps keep their actual requests and full option
probabilities (funnel_replay.build_reanalysis). DeepSeek question and task steps use the replay format's own
renderers; the minutes are the new whole-meeting 3-run vote when that step completed.
"""
import argparse
import json
from pathlib import Path

import funnel_replay as fr
import deepseek_label_chain as dc

TITLE = '团队讨论 10-05 · 97 分钟全链路'


def load(path):
    return json.loads(Path(path).read_text())


def build(label_dir, jev_reports, deepseek_report=None):
    rows = dc.merged_rows(label_dir)
    events, calls, parts = [], [], []
    for path in jev_reports:
        report = load(path)
        events += report.get('events') or []
        calls += report.get('raw_calls') or []
        parts.append(report['run_id'])
    tagged = {e['id'] for e in events if e.get('kind') == 'tag'}
    record = dict(run_id='+'.join(parts), source_session_id='dji-1005-all', events=events, raw_calls=calls,
                  status='complete' if tagged >= {r['id'] for r in rows} else 'partial', completed_tag_sentences=len(tagged),
                  created_at=load(jev_reports[0]).get('created_at'))
    row = dict(session_id='dji-1005-all', started_at=dc.STARTS['0235'], time_zone='Asia/Shanghai', title=TITLE,
               utterances=[dict(id=r['id'], text=r['text'], start_ms=r['start_ms'], end_ms=r['end_ms'], speaker=r['speaker'])
                           for r in rows])
    ds = load(deepseek_report) if deepseek_report else {}
    minutes = ds.get('minutes') if isinstance(ds.get('minutes'), dict) else None
    minutes_calls = [c for c in ds.get('calls') or [] if c.get('step') == 'minutes']
    view = (dict(status='ready', minutes=minutes, provenance='reanalysis',
                 generation=dict(evidence='reanalysis', mode='majority_vote', configured_runs=3, recorded_calls=len(minutes_calls),
                                 successful_runs=sum(c.get('status') == 'received' for c in minutes_calls)))
            if minutes else dict(status='unavailable', reason='not_run'))
    out = fr.build_reanalysis(record, row, view)
    questions = {q['id']: q for q in ds.get('questions') or []}
    tasks = ds.get('tasks') or {}
    speakers = {r['id']: r['speaker'] for r in rows}
    for s in out['sentences']:
        extra = []
        if s['id'] in questions:
            q = questions[s['id']]
            extra += fr.question_fork(dict(q, detect_kind=q.get('kind')))
        if s['id'] in tasks:
            extra += fr.task_forks(dict(tasks=tasks[s['id']]), s['text'])
        for f in extra:
            if f['layer'] == 'model':
                f['provenance'] = 'reanalysis'
        if extra:
            s['forks'] = s['forks'] + extra
            s['route'] = max((f['layer'] for f in s['forks']), key=lambda layer: fr.ORDER.get(layer, -1))
            s['outcome'] = fr.outcome(s['forks'], s.get('tag'))
        s['speaker_source'] = 'team_confirmed' if speakers.get(s['id']) else None
    end = max(r['end_ms'] for r in rows)
    out['session'] = [dict(at_ms=end, fork=fr.fork('model', '整理整场纪要（3 次独立生成后投票）', (minutes or {}).get('overview') or '纪要未生成',
                                                    settled=True, provenance='reanalysis'))] if minutes else []
    if out.get('post'):
        out['post']['generation'] = view['generation']
        out['post']['note'] = '本次重新运行 DeepSeek：整场 97 分钟全文、3 次独立生成后投票（生产流程会截掉 4 万字以后的中段，这次没有截）。'
        out['post']['handoffs'] = fr.post_handoffs(out['post'])
    source = out['source']
    source.update(kind='reanalysis', title=TITLE, label=TITLE, started_at=dc.STARTS['0235'], session_id='dji-1005-all',
                  deepseek_run=ds.get('run_id'), deepseek_status=ds.get('status'),
                  note='10-05 晚三段连续讨论录音（DJI 0235/0236/0238）按真实时间拼成一场，按标注站细句重新跑了 Jev（排除 81 句盲测）和 DeepSeek（整场纪要、待办措辞、待查问题）。'
                       '这是获准后的重新分析，不是会议当时的实时判断；说话人来自团队已确认的音色组，没确认的保持未认人；页面只读，不再调用模型。')
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--label-dir', required=True)
    p.add_argument('--jev-report', action='append', required=True)
    p.add_argument('--deepseek-report')
    p.add_argument('-o', '--output', required=True)
    args = p.parse_args()
    out = build(args.label_dir, args.jev_report, args.deepseek_report)
    Path(args.output).write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    layers = {k: sum(1 for s in out['sentences'] for f in s['forks'] if f['layer'] == k) for k in ('code', 'jev', 'model', 'you')}
    print(json.dumps(dict(sentences=len(out['sentences']), items=len((out.get('post') or {}).get('items') or []), **layers), ensure_ascii=False))


if __name__ == '__main__':
    main()
