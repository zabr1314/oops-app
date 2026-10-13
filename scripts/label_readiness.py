#!/usr/bin/env python3
"""Read-only content-workflow audit, separate from independent speaker evidence and calibration."""
import argparse
import json
from collections import Counter

from team_label import Data, PEOPLE
from label_workflow import content_audit


def identity_audit(data):
    """Current personal group approvals, distinct from old shared role claims."""
    if not callable(getattr(data, 'identity_payload', None)):
        return dict(voice_group_audit_available=False, voice_groups=[],
            current_voice_group_confirmations=None, current_self_confirmed_voice_groups=None,
            disputed_voice_groups=None)
    groups = {}
    for name in PEOPLE:
        for group in data.identity_payload(name)['groups']:
            item = groups.setdefault(group['id'], dict(id=group['id'], title=group.get('title'),
                count=group.get('count'), confirmations=[], stale_approval_count=0))
            approval = group.get('approval')
            if not approval:
                continue
            if not group.get('current') or approval.get('by') != name:
                item['stale_approval_count'] += 1
                continue
            item['confirmations'].append(dict(by=name, speaker=approval['speaker'], at=approval.get('at'),
                scope='voice_group', self_confirmed=approval['speaker'] == name))
    for group in groups.values():
        speakers = {answer['speaker'] for answer in group['confirmations']}
        group['disputed'] = len(speakers) > 1
        group['consensus_speaker'] = next(iter(speakers)) if len(speakers) == 1 else None
        group['self_confirmed_people'] = sorted(answer['by'] for answer in group['confirmations']
            if answer['self_confirmed'])
    current = [groups[gid] for gid in sorted(groups)]
    return dict(voice_group_audit_available=True, voice_groups=current,
        current_voice_group_confirmations=sum(len(group['confirmations']) for group in current),
        current_self_confirmed_voice_groups=sum(bool(group['self_confirmed_people']) for group in current),
        disputed_voice_groups=sum(group['disputed'] for group in current))


def audit(data):
    meetings = []
    for mid in sorted(data.meetings):
        rows = data.rows_with_claims(mid)
        labels = {name: data.load(mid, name) for name in PEOPLE}
        truth = content_audit(rows, labels)
        complete_ids = set(truth['complete_ids'])
        unresolved = set(truth['content_disputed_ids'])
        parents = {}
        for row in rows:
            if row.get('parent'):
                parents.setdefault(row['parent'], set()).add(row['id'])
        complete_parents = [parent for parent, ids in parents.items() if ids <= complete_ids]
        speakers = truth['speakers']
        meetings.append(dict(id=mid, total=len(rows), human_kind_labels=len(truth['kinds']),
            complete_human_rows=len(complete_ids), disputed_rows=len(unresolved),
            missing_human_rows=len(rows) - len(complete_ids),
            kinds=dict(Counter(truth['kinds'].values())),
            expression_count=truth['expression_count'],
            required_expression_count=truth['required_expression_count'],
            complete_required_expressions=truth['complete_required_expressions'],
            context_expression_count=truth['context_expression_count'],
            ready_for_content=truth['ready_for_content'],
            final_count=len(parents), complete_content_finals=len(complete_parents),
            ready_for_cached_content_evaluation=bool(complete_parents),
            content_label_sources=truth['content_label_sources'],
            speaker_label_sources=truth['speaker_label_sources'],
            label_source_counter_unit='person_sentence_field',
            independent_speaker_rows=truth['independent_speaker_rows'],
            grouped_speaker_rows=truth['grouped_speaker_rows'],
            speaker_disputed_rows=len(truth['speaker_disputes']),
            stale_kind_labels=truth['stale_kind_labels'], stale_speaker_labels=truth['stale_speaker_labels'],
            unreviewed_voice_prefill=sum(bool(u.get('voice')) and not u.get('claimed') and u['id'] not in speakers for u in rows),
            unreviewed_role_prefill=sum(bool(u.get('claimed')) and u['id'] not in speakers for u in rows),
            # Full-content readiness is a preparation condition, never evidence of fitted calibration or holdout acceptance.
            ready_for_calibration=bool(rows) and len(complete_ids) == len(rows) and not unresolved))
    claims = data.claims()
    roles = {role: dict(person=c.get('person'), by=c.get('by'),
        source='legacy_claims', legacy_self_claim=c.get('person') in PEOPLE and c.get('person') == c.get('by'),
        self_confirmed=c.get('person') in PEOPLE and c.get('person') == c.get('by')) for role, c in claims.items()}
    return dict(meetings=meetings, roles=roles, **identity_audit(data),
        ready_for_content=bool(meetings) and all(m['ready_for_content'] for m in meetings),
        ready_for_cached_content_evaluation=any(m['ready_for_cached_content_evaluation'] for m in meetings),
        ready_for_calibration=bool(meetings) and all(m['ready_for_calibration'] for m in meetings),
        calibration_complete=False, real_meeting_accepted=False, model_calls=0, source_data_modified=False,
        limits=['Content completeness requires kind and task owner, independently of speaker identity.',
                'Unlabelled all-short context expressions do not block the content workflow and are not automatically noise.',
                'Cached content evaluation requires complete, undisputed child content for each scored ASR final.',
                'Voice-group confirmation, role claims and voiceprint prefill are not independent per-sentence speaker ground truth.',
                'roles/self_confirmed describes legacy claims.json; current personal approvals are reported under voice_groups.',
                'Source counters count person/sentence fields, not independent confirmation actions.',
                'Legacy labels without source fingerprints remain compatible; their historical source cannot be revalidated.',
                'Readiness does not establish an unseen holdout or real-device meeting acceptance.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', required=True)
    args = parser.parse_args()
    print(json.dumps(audit(Data(args.data)), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
