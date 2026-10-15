"""Presentation-only cleanup: originals, Feishu records and user answers stay intact."""
import copy
import hashlib
import json
import re

FILLER = re.compile(r'[嗯呃额啊哦噢唉哎诶欸哈嘿唔，。！？、…,.!?;；:：\s]*')


def transcript_view(rows):
    folded = [u['id'] for u in rows if
              (FILLER.fullmatch(u.get('text', '')) or u.get('tag') == 'chitchat')
              and (u.get('review') or {}).get('verdict') != 'confirmed']
    return dict(mode='focus', folded_ids=folded, original_count=len(rows),
                visible_count=len(rows) - len(folded), original_preserved=True)


def operation_hash(op):
    canonical = op.get('request_canonical')
    if not isinstance(canonical, str):
        canonical = json.dumps(op.get('request'), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode()).hexdigest()


def split_tasks(items, ops, policy):
    """Only explicitly listed, unchanged test operations leave the business list."""
    if not isinstance(policy, dict) or policy.get('schema') != 1 or not isinstance(policy.get('entries'), dict):
        return copy.deepcopy(items), []
    originals = {o.get('op_id'): o for o in ops}
    active, archived = [], []
    for value in items:
        item = copy.deepcopy(value)
        entry = policy['entries'].get(item.get('op_id'))
        original = originals.get(item.get('op_id'))
        if (isinstance(entry, dict) and original and entry.get('action') == 'archive'
                and entry.get('request_hash') == operation_hash(original)
                and isinstance(entry.get('reason'), str) and 0 < len(entry['reason']) <= 300):
            item['curation'] = dict(archived=True, reason=entry['reason'], external_record_unchanged=True)
            archived.append(item)
        else:
            active.append(item)
    return active, archived
