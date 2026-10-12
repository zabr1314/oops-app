#!/usr/bin/env python3
"""Read-only human-label audit. Never treats voiceprint/role prefill as a human answer."""
import argparse
import json
from collections import Counter

from team_label import Data, PEOPLE, merge, complete


def audit(data):
    meetings = []
    for mid in sorted(data.meetings):
        rows = data.rows_with_claims(mid)
        labels = {name: data.load(mid, name) for name in PEOPLE}
        truth = merge(rows, {name: ls for name, ls in labels.items() if ls})
        complete_ids = {u['id'] for u in rows if any(complete(ls.get(u['id'], {}),
            dict(u, voice=None)) for ls in labels.values())}
        unresolved = {d['utterance'] for d in truth['disputes']}
        meetings.append(dict(id=mid, total=len(rows), human_kind_labels=len(truth['kinds']),
            complete_human_rows=len(complete_ids - unresolved), disputed_rows=len(unresolved),
            missing_human_rows=len(rows) - len(complete_ids),
            kinds=dict(Counter(truth['kinds'].values())),
            unreviewed_voice_prefill=len(truth['voice_prefill_unreviewed']),
            unreviewed_role_prefill=len(truth['role_claim_unreviewed']),
            ready_for_calibration=bool(rows) and len(complete_ids) == len(rows) and not unresolved))
    claims = data.claims()
    roles = {role: dict(person=c.get('person'), by=c.get('by'),
        self_confirmed=c.get('person') in PEOPLE and c.get('person') == c.get('by')) for role, c in claims.items()}
    return dict(meetings=meetings, roles=roles,
        ready_for_calibration=bool(meetings) and all(m['ready_for_calibration'] for m in meetings),
        limits=['Role claims and voiceprint prefill are not per-sentence human ground truth.',
                'Readiness does not establish an unseen holdout or real-device meeting acceptance.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', required=True)
    args = parser.parse_args()
    print(json.dumps(audit(Data(args.data)), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
