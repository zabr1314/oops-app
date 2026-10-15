"""Read-only quality projection of stored/model minutes; never regenerates them.

Original ASR and cached responses remain intact. A quantity awaiting listening is
an open question, never an executable task or an automatically corrected quote.
"""
import copy

from item_quality import assess_item

QUALITY_VERSION = 1
REASONS = {
    'quantity_ambiguity': '原话数字或单位含混，请回听核对',
    'quantity_unit_conflict': '数字的单位没有相符原话，请回听核对',
    'unsupported_quantity': '候选增加了未核对的数字或单位，请回听核对',
    'conditional_commitment_unconfirmed': '条件下是否实际认领尚未确认',
    'evidence_missing': '缺少可核对的原话',
    'evidence_incomplete': '引用原话不完整，请重新核对依据',
}


def project(analysis, row):
    """Apply the same source checks to fresh and cached minutes without writes."""
    out = copy.deepcopy(analysis)
    rows = [u for u in row.get('utterances', []) if isinstance(u, dict)]
    by_id = {u.get('id'): u for u in rows}
    # Older minutes did not keep topic IDs. Keep those words as historical
    # summaries, but never infer citations from matching text or current ASR.
    topics = []
    for topic in out.get('topics') or []:
        if not isinstance(topic, dict):
            continue
        ids = list(dict.fromkeys(i for i in topic.get('ids', []) if isinstance(i, str)))
        status = ('unrecorded' if not ids else
                  'available' if all(i in by_id for i in ids) and row.get('transcript_status') != 'expired'
                  else 'unavailable')
        topics.append(dict(topic, ids=ids, source_status=status))
    out['topics'] = topics
    kept, review = [], list(out.get('undecided') or [])
    rejected = list(out.get('quality_rejected') or [])
    for action in out.get('actions') or []:
        if not isinstance(action, dict):
            continue
        ids = list(dict.fromkeys(i for i in action.get('ids', []) if isinstance(i, str)))
        evidence = [by_id[i] for i in ids if i in by_id]
        quality = assess_item(action.get('task'), evidence, context=rows,
                              kind='task', detail=action.get('due', ''))
        if any(i not in by_id for i in ids):
            quality = dict(status='needs_review', reason='evidence_incomplete', ids=ids)
        if quality['status'] == 'accepted':
            kept.append(dict(action, quality=quality))
        elif quality['status'] == 'rejected':
            candidate = dict(action, quality=quality)
            if candidate not in rejected:
                rejected.append(candidate)
        else:
            reason = REASONS.get(quality['reason'], '具体安排尚待核对')
            candidate = dict(topic=reason, views='未确认候选：' + str(action.get('task') or ''),
                             ids=ids, quality=quality, original_task=action.get('task'))
            if not any(u.get('ids') == ids and u.get('original_task') == action.get('task') for u in review):
                review.append(candidate)
    out.update(actions=kept, undecided=review, quality_rejected=rejected,
               item_quality_version=QUALITY_VERSION)
    return out
