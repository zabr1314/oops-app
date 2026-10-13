#!/usr/bin/env python3
"""Compare existing replay tags with human labels, offline. Never calls or calibrates a model.

Content labels are folded onto their original ASR final; no final tag is copied onto child sentences.
Only finals with complete, undisputed content answers are scored. Speaker confirmation is independent.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

from team_label import Data, PEOPLE, LIVE_TAG
from label_workflow import content_audit


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def ratio(n, d):
    return round(n / d, 4) if d else None


def evaluate(rows, labels, replay, semantic=None, evaluation_mode='development'):
    if evaluation_mode not in ('development', 'independent_blind'):
        raise ValueError('Unknown content evaluation mode')
    expected = {}
    sentence_ids = set()
    for row in rows:
        if row['id'] in sentence_ids:
            raise ValueError('Duplicate sentence ID: ' + row['id'])
        sentence_ids.add(row['id'])
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
    truth = content_audit(rows, labels, semantic)
    complete_ids = set(truth['complete_ids'])
    independent_ids = set(truth['independent_content_ids'])
    disputed_ids = set(truth['content_disputed_ids'])
    stale_ids = set(truth.get('stale_kind_ids', []))
    eligible = {}
    excluded = []
    for parent, children in expected.items():
        ids = {u['id'] for u in children}
        if ids <= complete_ids and (evaluation_mode == 'development' or ids <= independent_ids):
            eligible[parent] = children
            continue
        disputed = sorted(ids & disputed_ids)
        stale = sorted(ids & stale_ids)
        missing = sorted(ids - complete_ids - disputed_ids - stale_ids)
        not_blind = sorted(ids - independent_ids) if evaluation_mode == 'independent_blind' else []
        excluded.append(dict(id=parent,
            reasons=([ 'content_dispute' ] if disputed else []) +
                    ([ 'stale_content_source' ] if stale else []) +
                    ([ 'missing_content' ] if missing else []) +
                    ([ 'not_independent_blind' ] if ids <= complete_ids and not_blind else []),
            disputed_sentence_ids=disputed, stale_sentence_ids=stale, missing_sentence_ids=missing,
            non_blind_sentence_ids=not_blind))
    report = dict(status='waiting_for_human_labels', granularity='asr_final',
        sentence_count=len(rows), final_count=len(expected), complete_human_rows=len(complete_ids),
        disputed_rows=len(disputed_ids), speaker_disputed_rows=len(truth['speaker_disputes']),
        scored_final_count=len(eligible), scored_final_ids=sorted(eligible),
        excluded_final_count=len(excluded), excluded_finals=excluded,
        human_content_sentence_coverage=ratio(len(complete_ids), len(rows)),
        human_content_final_coverage=ratio(len(eligible), len(expected)),
        full_content_coverage=bool(rows) and len(eligible) == len(expected),
        ready_for_content=truth['ready_for_content'],
        content_label_sources=truth['content_label_sources'],
        content_review_sources=truth['content_review_sources'],
        independent_content_rows=truth['independent_content_rows'],
        ai_assisted_content_rows=truth['ai_assisted_content_rows'],
        legacy_content_rows=truth['legacy_content_rows'], mixed_content_rows=truth['mixed_content_rows'],
        independent_blind_final_ids=sorted(parent for parent, children in expected.items()
            if {u['id'] for u in children} <= independent_ids),
        speaker_label_sources=truth['speaker_label_sources'],
        label_source_counter_unit='person_sentence_field',
        independent_speaker_rows=truth['independent_speaker_rows'],
        grouped_speaker_rows=truth['grouped_speaker_rows'],
        stale_kind_labels=truth['stale_kind_labels'], stale_speaker_labels=truth['stale_speaker_labels'],
        human_snapshot_sha256=digest(labels),
        replay_sha256=digest(replay), source_sha256=digest(rows),
        scope='cached_development_replay', evaluation_mode=evaluation_mode,
        metrics_scope='independent_blind_cached_development' if evaluation_mode == 'independent_blind'
            else 'human_reviewed_cached_development',
        calibration_complete=False, real_meeting_accepted=False, blind_accuracy_established=False,
        model_calls=0, source_data_modified=False,
        limitations=['Cached replay does not prove the currently deployed model version.',
                     'Metrics cover only complete, undisputed human-content finals; exclusions remain unscored.',
                     'Unlabelled short context is not automatically noise.',
                     'Voice-group confirmation is not independent per-sentence speaker ground truth.',
                     'Source counters count person/sentence fields, not independent confirmation actions.',
                     'Legacy labels without source fingerprints remain compatible; their historical source cannot be revalidated.',
                     'No threshold is fitted: class confidence is not an effective-content probability.',
                     'AI-assisted labels and labels with unknown historical exposure are not independently blind answers.',
                     'Default metrics use reviewed development labels and must not be reported as blind accuracy.',
                     'These previously replayed meetings cannot serve as unseen holdout acceptance.'])
    if not eligible:
        return report
    matrix = {actual: {predicted: 0 for predicted in ('effective', 'noise', 'abstain')}
              for actual in ('effective', 'noise')}
    binary = {kind: Counter(tp=0, fp=0, fn=0, tn=0, abstain=0) for kind in ('task', 'decision')}
    for parent, children in eligible.items():
        kinds = {truth['kinds'][u['id']] for u in children}
        actual = 'effective' if kinds - {'noise'} else 'noise'
        predicted = dict(LIVE_TAG, fact='info', info='info').get(by_id[parent].get('tag'))
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
        decision_coverage=ratio(decided, len(eligible)),
        decision_coverage_denominator='scored_human_content_finals',
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
    parser.add_argument('--evaluation-mode', choices=('development', 'independent_blind'), default='development')
    args = parser.parse_args()
    data = Data(args.data)
    rows = data.rows_with_claims(args.meeting)
    labels = {name: data.load(args.meeting, name) for name in PEOPLE}
    content_units = getattr(data, 'content_units', None)
    report = evaluate(rows, labels, json.loads(Path(args.replay).read_text()),
        content_units(args.meeting) if callable(content_units) else None, args.evaluation_mode)
    # Preserve every previous report and all original labels.
    with open(args.out, 'x', encoding='utf-8') as output:
        json.dump(report, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(json.dumps({k: report[k] for k in ('status','sentence_count','final_count','complete_human_rows','disputed_rows')}))


if __name__ == '__main__':
    main()
