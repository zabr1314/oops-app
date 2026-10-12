#!/usr/bin/env python3
"""Compare existing replay tags with human labels, offline. Never calls or calibrates a model.

Sentence labels are folded onto their original ASR final; no final tag is copied onto child sentences.
Incomplete/disputed human answers or changed transcript text prevent scoring.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

from team_label import Data, PEOPLE, LIVE_TAG, complete, merge


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def ratio(n, d):
    return round(n / d, 4) if d else None


def evaluate(rows, labels, replay):
    expected = {}
    for row in rows:
        parent = row.get('parent')
        if not parent:
            raise ValueError('Sentence-to-final mapping is missing')
        expected.setdefault(parent, []).append(row)
    predictions = replay.get('utterances', [])
    by_id = {row['id']: row for row in predictions}
    if len(by_id) != len(predictions) or set(by_id) != set(expected):
        raise ValueError('Replay final IDs do not exactly match the labelled recording')
    compact = lambda value: ''.join(value.split())
    for parent, children in expected.items():
        children.sort(key=lambda u: (u['start_ms'], u['id']))
        if compact(''.join(u['text'] for u in children)) != compact(by_id[parent]['text']):
            raise ValueError('Replay text differs from the human-labelled source: ' + parent)
    truth = merge(rows, labels)
    complete_ids = {row['id'] for row in rows if any(
        complete(person.get(row['id'], {}), dict(row, voice=None)) for person in labels.values())}
    report = dict(status='waiting_for_human_labels', granularity='asr_final',
        sentence_count=len(rows), final_count=len(expected), complete_human_rows=len(complete_ids),
        disputed_rows=len(truth['disputes']), human_snapshot_sha256=digest(labels),
        replay_sha256=digest(replay), source_sha256=digest(rows),
        scope='cached_development_replay', calibration_complete=False, real_meeting_accepted=False,
        limitations=['Cached replay does not prove the currently deployed model version.',
                     'No threshold is fitted: class confidence is not an effective-content probability.',
                     'These previously replayed meetings cannot serve as unseen holdout acceptance.'])
    if not rows or len(complete_ids) != len(rows) or truth['disputes']:
        return report
    matrix = {actual: {predicted: 0 for predicted in ('effective', 'noise', 'abstain')}
              for actual in ('effective', 'noise')}
    binary = {kind: Counter(tp=0, fp=0, fn=0, tn=0, abstain=0) for kind in ('task', 'decision')}
    for parent, children in expected.items():
        kinds = {truth['kinds'][u['id']] for u in children}
        actual = 'effective' if kinds - {'noise'} else 'noise'
        predicted = LIVE_TAG.get(by_id[parent].get('tag'))
        matrix[actual]['abstain' if predicted is None else 'noise' if predicted == 'noise' else 'effective'] += 1
        for kind, counts in binary.items():
            positive = kind in kinds
            if predicted is None:
                counts['abstain'] += 1
                if positive: counts['fn'] += 1
            else:
                counts['tp' if positive and predicted == kind else 'fn' if positive else
                       'fp' if predicted == kind else 'tn'] += 1
    tp, fp = matrix['effective']['effective'], matrix['noise']['effective']
    positives = sum(matrix['effective'].values())
    decided = sum(count for actual in matrix.values() for pred, count in actual.items() if pred != 'abstain')
    report.update(status='scored_cached_replay', effective_confusion=matrix,
        decision_coverage=ratio(decided, len(expected)),
        effective_precision=ratio(tp, tp + fp), effective_recall=ratio(tp, positives),
        task_and_decision={kind: dict(counts, precision=ratio(counts['tp'], counts['tp']+counts['fp']),
            recall=ratio(counts['tp'], counts['tp']+counts['fn'])) for kind, counts in binary.items()})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', required=True)
    parser.add_argument('--meeting', required=True)
    parser.add_argument('--replay', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    data = Data(args.data)
    rows = data.rows_with_claims(args.meeting)
    labels = {name: data.load(args.meeting, name) for name in PEOPLE}
    report = evaluate(rows, labels, json.loads(Path(args.replay).read_text()))
    # Preserve every previous report and all original labels.
    with open(args.out, 'x', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps({k: report[k] for k in ('status','sentence_count','final_count','complete_human_rows','disputed_rows')}))


if __name__ == '__main__':
    main()
