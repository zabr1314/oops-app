#!/usr/bin/env python3
"""Private review workbench for discussion recordings: AI suggestions are separate
from each person's answers, with a reserved independent, unassisted sample.

    team_label.py bundle 0235 0236 0238 --out build/label-data     # Mac: pack sentences + audio for the server
    team_label.py serve --data /var/lib/oops-label --port 8798     # server, behind nginx; LABEL_SECRET in the env
    team_label.py links --base https://giftedprofessor.xyz/oops-meeting/label/   # personal links (LABEL_SECRET)
    team_label.py merge --data <pulled data> 0236                   # → evidence/<session>/truth.json + disagreements

A person confirms voice groups, reviews continuous expressions, and corrects individual sentences.
Identity linkage and content labels keep separate provenance and undo histories; tasks also need an owner. Labels are stored per person (labels/<meeting>/<name>.json) and merged into one
truth file afterwards; sentences on which labellers disagree are listed instead of silently picking one.
Listens on 127.0.0.1 only. Audio is served in single-sentence clips, only with a valid personal key.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from label_meeting import clip_wav  # noqa: E402
from label_workflow import expressions, content_audit, current_label, row_fingerprint  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PEOPLE = ["林春源", "洪玉麟", "江古月", "黄丽萍"]
SPEAKER_OTHER = {"multi": "多人同时", "other": "其他人", "unclear": "听不清"}
OWNER_OTHER = {"collective": "大家", "unknown": "不确定"}
KINDS = ("task", "decision", "fact", "info", "noise")
# How the live tags (local_backend.TAGS) line up with the labels, for scoring the sentence triage itself.
LIVE_TAG = {"commitment": "task", "decision": "decision", "fact": "fact", "idea": "info", "constraint": "info", "chitchat": "noise"}
DUPS = "ABCDEFGHJK"
MEETING = re.compile(r"[0-9]{4}")
SHORT_MS = 1200  # rows this short ("对。") may be left without a speaker
SHORT_CHARS = 10  # shorter rows are context only on the page unless someone opens them


# ---------- keys ----------

def make_key(secret, name):
    tag = hmac.new(secret.encode(), ("label:" + name).encode(), hashlib.sha256).hexdigest()[:32]
    return base64.urlsafe_b64encode(name.encode()).decode().rstrip("=") + "." + tag


TEAM = "team"  # one shared link: the page asks who you are and sends it as X-Labeler


def check_key(secret, key):
    """The labeller's name, TEAM for the shared link, or None."""
    try:
        head, _ = key.split(".", 1)
        name = base64.urlsafe_b64decode(head + "=" * (-len(head) % 4)).decode()
    except (ValueError, UnicodeDecodeError, AttributeError):
        return None
    return name if (name in PEOPLE or name == TEAM) and hmac.compare_digest(make_key(secret, name), key) else None


# ---------- labels ----------

def clean(raw, rows):
    """Only known sentence ids and known values survive."""
    known = {u["id"] for u in rows}
    out = {}
    for uid, label in (raw or {}).items():
        if uid not in known or not isinstance(label, dict):
            continue
        item = {}
        if label.get("speaker") in PEOPLE or label.get("speaker") in SPEAKER_OTHER:
            item["speaker"] = label["speaker"]
        if label.get("speaker_excluded") is True:
            item["speaker_excluded"] = True
        if label.get("kind") in KINDS:
            item["kind"] = label["kind"]
        if item.get("kind") == "task" and (label.get("owner") in PEOPLE or label.get("owner") in OWNER_OTHER):
            item["owner"] = label["owner"]
        if item.get("kind") in ("task", "decision") and isinstance(label.get("dup"), str) and len(label["dup"]) == 1 \
                and label["dup"] in DUPS:
            item["dup"] = label["dup"]
        if item:
            for field, mode in (("kind", "expression"), ("speaker", "voice_group")):
                source = label.get(field + "_source")
                if field in item and isinstance(source, dict) and source.get("mode") in (mode, 'single') \
                        and isinstance(source.get("id"), str) and isinstance(source.get("fingerprint"), str):
                    item[field + "_source"] = {k: source[k] for k in ("mode", "id", "fingerprint")}
                    if field == 'kind':
                        if source.get('review_mode') in ('blind', 'ai_assisted'):
                            item['kind_source']['review_mode'] = source['review_mode']
                            for key in ('suggestion_fingerprint', 'model', 'prompt_version'):
                                if isinstance(source.get(key), str):
                                    item['kind_source'][key] = source[key][:200]
                        elif 'review_mode' in source:
                            item.pop('kind', None)
                            item.pop('owner', None)
                            item.pop('dup', None)
                elif field + '_source' in label:
                    item.pop(field, None)  # Malformed provenance must never turn into a legacy human answer.
                    if field == 'kind':
                        item.pop('owner', None)
                        item.pop('dup', None)
            if item:
                out[uid] = item
    return out


def chars(row):
    return len(re.sub(r"[^\w]", "", row["text"]))


def long_rows(rows):
    return sum(1 for u in rows if chars(u) >= SHORT_CHARS)


def complete(label, row):
    return bool(label.get("kind")) and (bool(label.get("speaker") or row.get("voice")) or row["end_ms"] - row["start_ms"] < SHORT_MS) \
        and (label.get("kind") != "task" or bool(label.get("owner")))


def merge(rows, by_person, semantic=None):
    """One truth from several labellers. A field counts when everyone who set it agrees; otherwise it is a dispute."""
    units = {uid: unit for unit in expressions(rows, semantic) for uid in unit['ids']}
    legacy = {uid: unit for unit in expressions(rows) for uid in unit['ids']}
    linked = {}
    reviewed = {}
    for person, labels in by_person.items():
        reviewed[person] = {}
        for row in rows:
            label = current_label(row, labels.get(row['id'], {}), units[row['id']], legacy.get(row['id']))
            if label.get('speaker_source', {}).get('mode') == 'voice_group':
                linked.setdefault(row['id'], {})[person] = label.pop('speaker')
                label.pop('speaker_source')
            if label:
                reviewed[person][row['id']] = label
    by_person = reviewed
    tasks, decisions, non_tasks, speakers, disputes, groups = [], [], [], {}, [], {}
    kinds = {}
    for u in rows:
        labels = {p: ls[u["id"]] for p, ls in by_person.items() if u["id"] in ls}
        if not labels:
            continue
        row_disputes = {}
        values = {}
        for field in ("kind", "speaker", "owner"):
            seen = {p: l[field] for p, l in labels.items() if l.get(field)}
            if len(set(seen.values())) > 1:
                row_disputes[field] = seen
            elif seen:
                values[field] = next(iter(seen.values()))
        if row_disputes:
            disputes.append({"utterance": u["id"], "text": u["text"], **row_disputes})
        kind = values.get("kind")
        if "kind" not in row_disputes and kind:
            kinds[u["id"]] = kind
        if "kind" not in row_disputes and kind == "task":
            owner = values.get("owner")
            tasks.append({"utterance": u["id"], "phrase": u["text"][:40], "owner": owner if owner in PEOPLE else None,
                          **({"note": OWNER_OTHER[owner]} if owner in OWNER_OTHER else {})})
        elif "kind" not in row_disputes and kind == "decision":
            decisions.append({"utterance": u["id"], "phrase": u["text"][:40]})
        elif "kind" not in row_disputes and kind in ("fact", "info", "noise"):  # hard negatives for task finding
            non_tasks.append({"utterance": u["id"], "phrase": u["text"][:40], "kind": kind})
        if "speaker" not in row_disputes and values.get("speaker"):
            speakers[u["id"]] = values["speaker"]
        for p, l in labels.items():  # duplicate groups are per person: letters mean nothing across people
            if l.get("dup"):
                groups.setdefault((p, l["dup"]), []).append(u["id"])
    dup_sets = sorted({tuple(ids) for ids in groups.values() if len(ids) >= 2})
    # Pre-filled voiceprint names nobody overwrote; kept apart so they never pass as human speaker labels.
    voice_only = {u["id"]: u["voice"] for u in rows if u.get("voice") and not u.get("claimed") and u["id"] not in speakers
                  and not any(ls.get(u["id"], {}).get("speaker") for ls in by_person.values())}
    role_only = {u["id"]: u["voice"] for u in rows if u.get("claimed") and u["id"] not in speakers
                 and not any(ls.get(u["id"], {}).get("speaker") for ls in by_person.values())}
    voice_overruled = {u["id"]: {"voice": u["voice"], "human": speakers[u["id"]]} for u in rows
                       if u.get("voice") and speakers.get(u["id"]) and speakers[u["id"]] != u["voice"]}
    review = content_audit(rows, by_person, semantic)
    return {"tasks": tasks, "decisions": decisions, "non_tasks": non_tasks, "kinds": kinds, "speakers": speakers,
            "voice_prefill_unreviewed": voice_only, "role_claim_unreviewed": role_only, "voice_prefill_overruled": voice_overruled,
            "voice_group_linked": linked,
            "duplicates": [list(g) for g in dup_sets], "disputes": disputes, "labelers": sorted(by_person),
            "scope": "human_reviewed_development", "blind": False, "blind_accuracy_established": False,
            "content_review_granularity": "sentence",
            **{key: review[key] for key in ('content_review_modes', 'content_review_sources',
                'independent_content_ids', 'ai_assisted_content_ids', 'legacy_content_ids', 'mixed_content_ids')}}


# ---------- storage ----------

class RevisionConflict(ValueError):
    pass


class Data:
    def __init__(self, folder):
        self.folder = folder
        self.meetings = {}
        self.roles = {}
        for mid in sorted(os.listdir(os.path.join(folder, "meetings"))):
            path = os.path.join(folder, "meetings", mid)
            if not MEETING.fullmatch(mid) or not os.path.isfile(os.path.join(path, "audio.wav")):
                continue
            with open(os.path.join(path, "meeting.json"), encoding="utf-8") as f:
                meeting = json.load(f)
            voice = {}
            if os.path.isfile(os.path.join(path, "voice.json")):  # voice_prefill.py: speakers the voiceprints are sure of
                with open(os.path.join(path, "voice.json"), encoding="utf-8") as f:
                    voice = json.load(f)["rows"]
            roles = {}
            if os.path.isfile(os.path.join(path, "roles.json")):  # voice_roles.py: unknown voices grouped for claiming
                with open(os.path.join(path, "roles.json"), encoding="utf-8") as f:
                    found = json.load(f)
                roles = found["rows"]
                self.roles = found["roles"]
            for u in meeting["utterances"]:
                if voice.get(u["id"], {}).get("name") in PEOPLE:
                    u["voice"] = voice[u["id"]]["name"]
                elif u["id"] in roles:
                    u["role"] = roles[u["id"]]["role"]
            self.meetings[mid] = {"id": mid, "title": meeting.get("title", mid), "rows": meeting["utterances"],
                                  "wav": os.path.join(path, "audio.wav")}
        self.lock = threading.RLock()
        self.groups = self._voice_groups()

    def _voice_groups(self):
        groups = {}
        for mid, meeting in self.meetings.items():
            for row in meeting['rows']:
                gid = 'voice:' + row['voice'] if row.get('voice') else 'role:' + row['role'] if row.get('role') else None
                if not gid:
                    continue
                group = groups.setdefault(gid, dict(id=gid, title=gid.split(':', 1)[1], members=[], clips=[]))
                group['members'].append(dict(meeting=mid, id=row['id'], text=row['text'],
                    start_ms=row['start_ms'], end_ms=row['end_ms']))
        for gid, group in groups.items():
            group['fingerprint'] = hashlib.sha256(json.dumps(group['members'], ensure_ascii=False,
                sort_keys=True).encode()).hexdigest()
            role = self.roles.get(group['title'], {})
            if role.get('clips'):
                group['clips'] = role['clips']
            else:
                candidates = sorted(group['members'], key=lambda r: (-min(r['end_ms'] - r['start_ms'], 6000), r['id']))
                for mid in self.meetings:
                    clip = next((r for r in candidates if r['meeting'] == mid), None)
                    if clip:
                        group['clips'].append(clip)
                group['clips'] = group['clips'][:3]
        return groups

    @staticmethod
    def _read(path, default):
        if not os.path.isfile(path):
            return default
        with open(path, encoding='utf-8') as f:
            return json.load(f)

    @staticmethod
    def _write(path, body):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path + '.tmp', 'w', encoding='utf-8') as f:
            json.dump(body, f, ensure_ascii=False, indent=1)
        os.replace(path + '.tmp', path)

    def _document(self, mid, name):
        doc = self._read(self.labels_path(mid, name), {})
        doc['labels'] = clean(doc.get('labels', {}), self.meetings[mid]['rows'])
        # Group approval lives separately. Never persist its materialized speaker as single-row truth.
        for label in doc['labels'].values():
            if label.get('speaker_source', {}).get('mode') == 'voice_group':
                label.pop('speaker', None)
                label.pop('speaker_source', None)
        history = doc.get('history', [])
        # Upgrade old full snapshots into deltas without changing the saved answers.
        normalized = []
        for index, entry in enumerate(history):
            if entry.get('_label_review') is True:
                normalized.append(entry)
                continue
            later = history[index + 1] if index + 1 < len(history) else doc['labels']
            after = later.get('snapshot', {}) if later.get('_label_review') is True else later
            normalized.append(dict(_label_review=True, review_mode='assisted', snapshot=entry,
                changed_ids=sorted(uid for uid in set(entry) | set(after) if entry.get(uid) != after.get(uid))))
        doc['history'] = normalized
        return {'revision': 0, 'history': [], 'seen': {}, **doc}

    def _identity_path(self, name):
        return os.path.join(self.folder, 'identities', name + '.json')

    def _identities(self, name):
        doc = self._read(self._identity_path(name), {})
        return {'revision': 0, 'history': [], 'seen': {}, 'approvals': {}, **doc}

    def identity_payload(self, name):
        doc = self._identities(name)
        claims = self.claims()
        groups = []
        for gid, group in self.groups.items():
            approval = doc['approvals'].get(gid)
            valid = bool(approval and approval.get('fingerprint') == group['fingerprint'])
            suggestion = gid.split(':', 1)[1] if gid.startswith('voice:') else claims.get(group['title'], {}).get('person')
            groups.append(dict(group, suggested_person=suggestion, approval=approval, current=valid,
                count=len(group['members'])))
        return dict(groups=groups, revision=doc['revision'], can_undo=bool(doc['history']))

    @staticmethod
    def _begin(doc, body, field):
        request = body.get('request_id')
        if not isinstance(request, str) or not 8 <= len(request) <= 100:
            raise ValueError('request_id required')
        fingerprint = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
        if request in doc['seen']:
            if doc['seen'][request] != fingerprint:
                raise ValueError('request_id reused')
            return False
        if body.get('revision') != doc['revision']:
            raise RevisionConflict('State changed; reload before editing')
        if body.get('action') == 'undo':
            if not doc['history']:
                raise ValueError('nothing to undo')
            if field == 'labels':
                mode = body.get('review_mode', 'assisted')
                match = next((i for i in range(len(doc['history']) - 1, -1, -1)
                    if doc['history'][i].get('review_mode') == mode), None)
                if match is None:
                    raise ValueError('nothing to undo in this mode')
                # A stale blind plan may make its rows manually editable in assisted
                # mode. Undo the earlier operation without deleting newer corrections.
                later = doc['history'][match + 1:]
                previous = doc['history'].pop(match)
                for uid in previous['changed_ids']:
                    successor = next((entry for entry in later if uid in entry['changed_ids']), None)
                    # Rebase the next undo too, so it cannot resurrect this removed
                    # operation after the newer correction is undone.
                    target = successor['snapshot'] if successor else doc[field]
                    if uid in previous['snapshot']:
                        target[uid] = previous['snapshot'][uid]
                    else:
                        target.pop(uid, None)
            else:
                doc[field] = doc['history'].pop()
        else:
            snapshot = json.loads(json.dumps(doc[field]))
            entry = dict(_label_review=True, review_mode=body.get('review_mode', 'assisted'),
                snapshot=snapshot, changed_ids=[]) if field == 'labels' else snapshot
            doc['history'] = (doc['history'] + [entry])[-30:]
        doc['revision'] += 1
        doc['seen'][request] = fingerprint
        doc['seen'] = dict(list(doc['seen'].items())[-100:])
        return True

    @staticmethod
    def _finish_review(doc, body):
        if body.get('action') != 'undo':
            entry = doc['history'][-1]
            before, after = entry['snapshot'], doc['labels']
            entry['changed_ids'] = sorted(uid for uid in set(before) | set(after)
                if before.get(uid) != after.get(uid))

    def review_identity(self, name, body):
        with self.lock:
            doc = self._identities(name)
            if not self._begin(doc, body, 'approvals'):
                return self.identity_payload(name)
            if body.get('action') != 'undo':
                group = self.groups.get(body.get('group'))
                if not group or body.get('fingerprint') != group['fingerprint']:
                    raise RevisionConflict('Voice group changed')
                if body.get('action') == 'revoke':
                    doc['approvals'].pop(group['id'], None)
                elif body.get('action') == 'confirm' and body.get('speaker') in PEOPLE + list(SPEAKER_OTHER):
                    doc['approvals'][group['id']] = dict(speaker=body['speaker'], fingerprint=group['fingerprint'],
                        by=name, at=time.strftime('%Y-%m-%dT%H:%M:%S'), scope='voice_group',
                        members=[dict(meeting=r['meeting'], id=r['id']) for r in group['members']])
                else:
                    raise ValueError('unknown identity action')
            self._write(self._identity_path(name), doc)
            return self.identity_payload(name)

    def annotation_state(self, mid):
        """Only validated, source-bound sidecars can supply suggestions. GET never calls a model."""
        from label_ai import load_sidecar
        path = os.path.join(self.folder, 'meetings', mid, 'suggestions.json')
        try:
            doc = load_sidecar(path, self.meetings[mid]['rows'], mid)
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            return None, 'stale'
        if doc is None:
            return None, 'unavailable'
        return doc, 'pending' if doc.get('status') == 'planned' else doc.get('status', 'pending')

    def content_units(self, mid):
        doc, _ = self.annotation_state(mid)
        # Grouping uses immutable machine hints, never another person's role claim.
        return expressions(self.meetings[mid]['rows'], doc)

    def _exposure_path(self, mid, name):
        return os.path.join(self.folder, 'exposures', mid, name + '.json')

    def _exposed(self, mid, name):
        return set(self._read(self._exposure_path(mid, name), {}).get('ids', []))

    def _mark_exposed(self, mid, name, ids):
        with self.lock:
            old = self._exposed(mid, name)
            current = old | set(ids)
            if old != current:
                self._write(self._exposure_path(mid, name), dict(ids=sorted(current),
                    at=time.strftime('%Y-%m-%dT%H:%M:%S'), source='suggestions_delivered'))

    def meeting_payload(self, mid, name, review_mode='assisted'):
        if review_mode not in ('assisted', 'blind'):
            raise ValueError('unknown review mode')
        all_rows = self.rows_with_claims(mid)
        ai, status = self.annotation_state(mid)
        reserved = set((ai or {}).get('blind', {}).get('ids', []))
        units = self.content_units(mid)
        selected = [e for e in units if (set(e['ids']) <= reserved) == (review_mode == 'blind')]
        ids = {uid for e in selected for uid in e['ids']}
        rows = [r for r in all_rows if r['id'] in ids]
        doc = self._document(mid, name)
        labels = self.load(mid, name)
        audit = content_audit(rows, {name: labels}, selected)
        by_id = {uid: e for e in selected for uid in e['ids']}
        legacy = {uid: e for e in expressions(all_rows) for uid in e['ids']}
        current = {u['id']: current_label(u, labels.get(u['id'], {}), by_id[u['id']], legacy.get(u['id'])) for u in rows}
        current = {uid: label for uid, label in current.items() if label}
        predictions = {e['id']: e for e in (ai or {}).get('expressions', [])}
        for e in audit['expressions']:
            prediction = predictions.get(e['id']) if review_mode == 'assisted' else None
            e['suggestion'] = dict(kind=prediction['kind'], reason=prediction['reason'], source=dict(
                fingerprint=prediction['suggestion_fingerprint'], model=prediction['model'],
                prompt_version=ai['prompt_version'])) if prediction else None
        if review_mode == 'assisted':
            self._mark_exposed(mid, name, [uid for e in audit['expressions'] if e['suggestion'] for uid in e['ids']])
        blind_units = [e for e in units if set(e['ids']) <= reserved]
        exposed = self._exposed(mid, name)
        row_by_id = {row['id']: row for row in all_rows}
        blind_labels = {uid: current_label(row_by_id[uid], labels.get(uid, {}), e, legacy.get(uid))
            for e in blind_units for uid in e['ids']}
        complete_blind = sum(all(uid not in exposed and blind_labels.get(uid, {}).get('kind')
            and blind_labels[uid].get('kind_source', {}).get('review_mode') == 'blind'
            and (blind_labels[uid]['kind'] != 'task' or blind_labels[uid].get('owner')) for uid in e['ids']) for e in blind_units)
        return dict(id=mid, rows=[dict(u, chars=chars(u), fingerprint=row_fingerprint(u)) for u in rows], labels=current,
            stale_ids=list(set(audit['stale_kind_ids'] + audit['stale_speaker_ids'])),
            expressions=audit['expressions'], revision=doc['revision'],
            can_undo=any(entry.get('review_mode') == review_mode for entry in doc['history']),
            review_mode=review_mode,
            blind=dict(total=len(blind_units), completed=complete_blind, remaining=len(blind_units)-complete_blind),
            assistance=dict(status=status, model=(ai or {}).get('model'), generated_at=(ai or {}).get('updated_at')) if review_mode == 'assisted' else None,
            content_progress={k: audit[k] for k in ('required_expression_count', 'complete_required_expressions',
                'context_expression_count', 'ready_for_content')})

    def review(self, mid, name, body):
        with self.lock:
            review_mode = body.get('review_mode', 'assisted')
            if review_mode not in ('assisted', 'blind'):
                raise ValueError('unknown review mode')
            doc = self._document(mid, name)
            if not self._begin(doc, body, 'labels'):
                return self.meeting_payload(mid, name, review_mode)
            if body.get('action') in ('confirm_suggestion', 'confirm_suggestions'):
                self._confirm_suggestions(mid, name, body, doc)
                self._finish_review(doc, body)
                doc.update(meeting=mid, labeler=name)
                self._write(self.labels_path(mid, name), doc)
                return self.meeting_payload(mid, name, review_mode)
            if body.get('action') != 'undo':
                if body.get('action') != 'set':
                    raise ValueError('unknown action')
                rows = self.rows_with_claims(mid)
                legacy = {uid: e for e in expressions(rows) for uid in e['ids']}
                field, value = body.get('field'), body.get('value')
                if field not in ('kind', 'speaker', 'owner', 'dup'):
                    raise ValueError('unknown field')
                expression = None
                if body.get('scope') == 'expression':
                    if field == 'speaker':
                        raise ValueError('expression cannot establish speaker identity')
                    expression = next((e for e in self.content_units(mid) if e['id'] == body.get('expression')), None)
                    if not expression or expression['fingerprint'] != body.get('fingerprint'):
                        raise RevisionConflict('Expression changed')
                    ids = expression['ids']
                elif body.get('scope') == 'row' and body.get('id') in {u['id'] for u in rows}:
                    ids = [body['id']]
                    row = next(u for u in rows if u['id'] == body['id'])
                    if body.get('fingerprint') != row_fingerprint(row):
                        raise RevisionConflict('Sentence changed')
                else:
                    raise ValueError('unknown scope')
                ai, _ = self.annotation_state(mid)
                reserved = set((ai or {}).get('blind', {}).get('ids', []))
                if (review_mode == 'blind' and (not set(ids) <= reserved or set(ids) & self._exposed(mid, name))) \
                        or (review_mode == 'assisted' and set(ids) & reserved):
                    raise RevisionConflict('Review scope changed')
                allowed = {'kind': KINDS, 'speaker': PEOPLE + list(SPEAKER_OTHER),
                    'owner': PEOPLE + list(OWNER_OTHER), 'dup': list(DUPS)}
                if value is not None and value not in allowed[field]:
                    raise ValueError('unknown value')
                for uid in ids:
                    label = doc['labels'].setdefault(uid, {})
                    # Whole-expression changes preserve deliberate single-row exceptions.
                    row = next(u for u in rows if u['id'] == uid)
                    if expression and current_label(row, label, expression, legacy.get(uid)).get('kind') \
                            and label.get('kind_source', {}).get('mode') != 'expression':
                        continue
                    if value is None:
                        label.pop(field, None)
                    else:
                        label[field] = value
                    if field == 'kind':
                        label.pop('kind_source', None)
                        if expression and value:
                            label['kind_source'] = dict(mode='expression', id=expression['id'], fingerprint=expression['fingerprint'])
                        elif value:
                            label['kind_source'] = dict(mode='single', id=uid, fingerprint=row_fingerprint(row))
                        if value and ('review_mode' in body or ai):
                            label['kind_source']['review_mode'] = 'blind' if review_mode == 'blind' else 'ai_assisted'
                            prediction = next((p for p in (ai or {}).get('expressions', []) if uid in p['ids']), None)
                            if review_mode == 'assisted' and prediction:
                                label['kind_source'].update(suggestion_fingerprint=prediction['suggestion_fingerprint'],
                                    model=prediction['model'], prompt_version=ai['prompt_version'])
                        if value != 'task':
                            label.pop('owner', None)
                        if value not in ('task', 'decision'):
                            label.pop('dup', None)
                    if field == 'speaker':
                        label.pop('speaker_source', None)
                        label['speaker_excluded'] = value is None
                        if value:
                            label['speaker_source'] = dict(mode='single', id=uid, fingerprint=row_fingerprint(row))
                    if not expression and field in ('owner', 'dup') and label.get('kind'):
                        # Correcting a dependent content field makes this row an explicit exception too.
                        provenance = {k: v for k, v in label.get('kind_source', {}).items()
                            if k in ('review_mode', 'suggestion_fingerprint', 'model', 'prompt_version')}
                        label['kind_source'] = dict(mode='single', id=uid, fingerprint=row_fingerprint(row), **provenance)
                doc['labels'] = clean(doc['labels'], rows)
            self._finish_review(doc, body)
            doc.update(meeting=mid, labeler=name)
            self._write(self.labels_path(mid, name), doc)
            return self.meeting_payload(mid, name, review_mode)

    def _confirm_suggestions(self, mid, name, body, doc):
        if body.get('review_mode') != 'assisted':
            raise ValueError('suggestions are unavailable in blind review')
        ai, _ = self.annotation_state(mid)
        if not ai:
            raise RevisionConflict('Suggestions unavailable')
        batch = body['action'] == 'confirm_suggestions'
        items = body.get('items') if batch else [body]
        if not isinstance(items, list) or not 1 <= len(items) <= 100 or any(not isinstance(i, dict) for i in items):
            raise ValueError('invalid confirmation range')
        units = {e['id']: e for e in self.content_units(mid)}
        predictions = {e['id']: e for e in ai.get('expressions', [])}
        rows = self.rows_with_claims(mid)
        legacy = {uid: e for e in expressions(rows) for uid in e['ids']}
        checked, seen = [], set()
        for item in items:
            eid = item.get('expression')
            unit, prediction = units.get(eid), predictions.get(eid)
            if eid in seen or not unit or not prediction or unit['fingerprint'] != item.get('fingerprint') \
                    or prediction['suggestion_fingerprint'] != item.get('suggestion_fingerprint'):
                raise RevisionConflict('Suggestion changed')
            seen.add(eid)
            if prediction['kind'] not in KINDS or batch and prediction['kind'] in ('task', 'decision'):
                raise ValueError('this suggestion requires individual review')
            if batch:
                for uid in unit['ids']:
                    row = next(r for r in rows if r['id'] == uid)
                    label = current_label(row, doc['labels'].get(uid, {}), unit, legacy.get(uid))
                    if label.get('kind'):
                        raise RevisionConflict('Batch includes an existing answer or single correction')
            checked.append((unit, prediction))
        for unit, prediction in checked:
            for uid in unit['ids']:
                row = next(r for r in rows if r['id'] == uid)
                label = doc['labels'].setdefault(uid, {})
                current = current_label(row, label, unit, legacy.get(uid))
                if current.get('kind') and label.get('kind_source', {}).get('mode') != 'expression':
                    continue
                label.update(kind=prediction['kind'], kind_source=dict(mode='expression', id=unit['id'],
                    fingerprint=unit['fingerprint'], review_mode='ai_assisted',
                    suggestion_fingerprint=prediction['suggestion_fingerprint'], model=prediction['model'],
                    prompt_version=ai['prompt_version']))
                if prediction['kind'] != 'task':
                    label.pop('owner', None)
                if prediction['kind'] not in ('task', 'decision'):
                    label.pop('dup', None)
        self._mark_exposed(mid, name, [uid for unit, _ in checked for uid in unit['ids']])
        doc['labels'] = clean(doc['labels'], rows)

    def labels_path(self, mid, name):
        return os.path.join(self.folder, "labels", mid, name + ".json")

    def load(self, mid, name):
        labels = self._document(mid, name)['labels']
        exposed = self._exposed(mid, name)
        for uid in exposed:
            if labels.get(uid, {}).get('kind_source', {}).get('review_mode') == 'blind':
                labels[uid]['kind_source']['review_mode'] = 'ai_assisted'
        approvals = self._identities(name)['approvals']
        for row in self.rows_with_claims(mid):
            gid = row.get('voice_group_id')
            approval = approvals.get(gid)
            label = labels.get(row['id'], {})
            if approval and approval.get('fingerprint') == row.get('voice_group_fingerprint') \
                    and not label.get('speaker') and not label.get('speaker_excluded'):
                labels[row['id']] = dict(label, speaker=approval['speaker'], speaker_source=dict(
                    mode='voice_group', id=gid, fingerprint=approval['fingerprint']))
        return labels

    def save(self, mid, name, raw, revision=None):
        labels = clean(raw, self.meetings[mid]["rows"])
        # Legacy whole-document clients cannot assert a server-controlled blind/AI origin.
        for label in labels.values():
            for key in ('review_mode', 'suggestion_fingerprint', 'model', 'prompt_version'):
                label.get('kind_source', {}).pop(key, None)
        path = self.labels_path(mid, name)
        with self.lock:
            doc = self._document(mid, name)
            if revision is not None and revision != doc['revision']:
                raise RevisionConflict('State changed')
            doc['history'] = (doc['history'] + [doc['labels']])[-30:]
            doc.update(meeting=mid, labeler=name, labels=labels, revision=doc['revision'] + 1)
            self._write(path, doc)
        return labels

    def claims(self):
        path = os.path.join(self.folder, "claims.json")
        if not os.path.isfile(path):
            return {}
        with open(path, encoding="utf-8") as f:
            return {r: c for r, c in json.load(f).items() if r in self.roles}

    def claim(self, role, person, by):
        """Team-wide: whoever recognises the voice says whose it is; the last answer counts and names who gave it."""
        if role not in self.roles or person not in PEOPLE + ["other", None]:
            raise ValueError("unknown role or person")
        with self.lock:
            claims = self.claims()
            if person is None:
                claims.pop(role, None)
            else:
                claims[role] = {"person": person, "by": by, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
            path = os.path.join(self.folder, "claims.json")
            with open(path + ".tmp", "w", encoding="utf-8") as f:
                json.dump(claims, f, ensure_ascii=False, indent=1)
            os.replace(path + ".tmp", path)
        return claims

    def rows_with_claims(self, mid):
        """Rows with `voice` also set from claimed roles (a claimed role counts like a voiceprint pre-fill)."""
        claims = self.claims()
        out = []
        for u in self.meetings[mid]["rows"]:
            person = (claims.get(u.get("role")) or {}).get("person")
            gid = 'voice:' + u['voice'] if u.get('voice') else 'role:' + u['role'] if u.get('role') else None
            row = dict(u, **dict(voice=person, claimed=True)) if not u.get('voice') and person in PEOPLE else dict(u)
            # Strip any archived predictions before returning a blind annotation page.
            row = {k: row[k] for k in ('id', 'parent', 'text', 'start_ms', 'end_ms', 'voice', 'role', 'claimed') if k in row}
            row.update(machine_voice=u.get('voice'), machine_role=u.get('role'))
            if gid:
                row.update(voice_group_id=gid, voice_group_fingerprint=self.groups[gid]['fingerprint'])
            out.append(row)
        return out

    def progress(self, mid):
        rows = {u["id"]: u for u in self.rows_with_claims(mid)}
        out = {}
        for name in PEOPLE:
            labels = self.load(mid, name)
            if labels:
                out[name] = sum(1 for uid, l in labels.items() if chars(rows[uid]) >= SHORT_CHARS and complete(l, rows[uid]))
        return out


# ---------- http ----------

def make_handler(data, secret):
    page = (PAGE.replace("__PEOPLE__", json.dumps(PEOPLE, ensure_ascii=False))
            .replace("__SPOTHER__", json.dumps(SPEAKER_OTHER, ensure_ascii=False))
            .replace("__OWOTHER__", json.dumps(OWNER_OTHER, ensure_ascii=False))
            .replace("__SHORT__", str(SHORT_MS)).replace("__DUPS__", DUPS)).encode()
    index = {mid: {u["id"]: u for u in m["rows"]} for mid, m in data.meetings.items()}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, status, body, kind="application/json; charset=utf-8"):
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "private, max-age=86400" if kind == "audio/wav" else "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

        def who(self, query):
            auth = self.headers.get("Authorization", "")
            key = auth[7:] if auth.startswith("Bearer ") else (query.get("k") or [""])[0]
            name = check_key(secret, key)
            if name == TEAM:
                picked = urllib.parse.unquote(self.headers.get("X-Labeler", ""))
                return picked if picked in PEOPLE else TEAM
            return name

        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(url.query)
            if url.path in ("/", "/index.html"):
                return self.send(200, page, "text/html; charset=utf-8")
            name = self.who(query)
            if not name:
                return self.send(401, b'{"error":"link"}')
            if url.path == "/api/me":
                if name == TEAM:
                    return self.send(200, json.dumps({"name": None, "people": PEOPLE}, ensure_ascii=False).encode())
                meetings = [{"id": mid, "title": m["title"], "count": long_rows(m["rows"]),
                             "minutes": round(m["rows"][-1]["end_ms"] / 60000) if m["rows"] else 0,
                             "progress": data.progress(mid)} for mid, m in data.meetings.items()]
                return self.send(200, json.dumps({"name": name, "meetings": meetings}, ensure_ascii=False).encode())
            if url.path == "/api/roles":
                return self.send(200, json.dumps({"roles": data.roles, "claims": data.claims()}, ensure_ascii=False).encode())
            if url.path == '/api/identity' and name != TEAM:
                return self.send(200, json.dumps(data.identity_payload(name), ensure_ascii=False).encode())
            m = re.fullmatch(r"/api/meeting/([0-9]{4})", url.path)
            if m and name == TEAM:
                return self.send(400, b'{"error":"who"}')
            if m and m.group(1) in data.meetings:
                mid = m.group(1)
                mode = (query.get('mode') or ['assisted'])[0]
                if mode not in ('assisted', 'blind'):
                    return self.send(400, b'{}')
                return self.send(200, json.dumps(data.meeting_payload(mid, name, mode), ensure_ascii=False).encode())
            m = re.fullmatch(r"/clip/([0-9]{4})/([A-Za-z0-9_-]{1,40})\.wav", url.path)
            if m and m.group(2) in index.get(m.group(1), {}):
                u = index[m.group(1)][m.group(2)]
                pad = 0 if (query.get("pad") or [""])[0] == "0" else 300
                end_ms = u['end_ms']
                through = (query.get('through') or [''])[0]
                if through:
                    expr = next((e for e in data.content_units(m.group(1))
                        if e['ids'][0] == u['id'] and e['ids'][-1] == through), None)
                    if not expr:
                        return self.send(400, b'{}')
                    end_ms = expr['end_ms']
                return self.send(200, clip_wav(data.meetings[m.group(1)]["wav"], u["start_ms"], end_ms, pad), "audio/wav")
            self.send(404, b"{}")

        def do_POST(self):
            url = urllib.parse.urlsplit(self.path)
            name = self.who({})
            if not name or name == TEAM:
                return self.send(401, b'{"error":"link"}')
            size = int(self.headers.get("Content-Length") or 0)
            review = re.fullmatch(r'/api/meeting/([0-9]{4})/review', url.path)
            if url.path == '/api/identity' or review and review.group(1) in data.meetings:
                if not 0 < size <= 65536:
                    return self.send(400, b'{}')
                try:
                    body = json.loads(self.rfile.read(size))
                    if not isinstance(body, dict):
                        raise ValueError('object required')
                    result = data.review_identity(name, body) if url.path == '/api/identity' else data.review(review.group(1), name, body)
                except RevisionConflict:
                    return self.send(409, b'{"error":"changed"}')
                except (json.JSONDecodeError, ValueError, TypeError, AttributeError):
                    return self.send(400, b'{}')
                return self.send(200, json.dumps(result, ensure_ascii=False).encode())
            if url.path == "/api/roles":
                try:
                    body = json.loads(self.rfile.read(size)) if 0 < size <= 10_000 else {}
                    claims = data.claim(body.get("role"), body.get("person"), name)
                except (json.JSONDecodeError, ValueError, AttributeError):
                    return self.send(400, b"{}")
                return self.send(200, json.dumps({"claims": claims}, ensure_ascii=False).encode())
            m = re.fullmatch(r"/api/meeting/([0-9]{4})/labels", url.path)
            if not m or m.group(1) not in data.meetings:
                return self.send(404, b"{}")
            if not 0 < size <= 1_500_000:
                return self.send(400, b"{}")
            if self.headers.get('X-Label-Revision') is None:
                return self.send(409, b'{"error":"upgrade_required"}')
            if os.path.exists(os.path.join(data.folder, 'meetings', m.group(1), 'suggestions.json')):
                return self.send(409, b'{"error":"upgrade_required"}')
            try:
                labels = data.save(m.group(1), name, json.loads(self.rfile.read(size)), int(self.headers['X-Label-Revision']))
            except RevisionConflict:
                return self.send(409, b'{"error":"changed"}')
            except (json.JSONDecodeError, ValueError):
                return self.send(400, b"{}")
            self.send(200, json.dumps({"saved": len(labels)}).encode())

    return Handler


# ---------- commands ----------

def bundle(args):
    import dji_to_eval
    for short in args.meetings:
        stem = dji_to_eval.recording(short)
        sid = dji_to_eval.session_id(stem)
        with open(os.path.join(ROOT, "evidence", sid, "meeting.json"), encoding="utf-8") as f:
            meeting = json.load(f)
        if meeting.get("purpose") != "meeting-development":
            sys.exit(f"{short} 不是开发集，不放进团队标注")
        dest = os.path.join(args.out, "meetings", short)
        os.makedirs(dest, exist_ok=True)
        day = stem.split("_")[1]
        title = f"{int(day[4:6])}月{int(day[6:8])}日 {day[8:10]}:{day[10:12]} 讨论（{short}）"
        rows = [{k: u[k] for k in ("id", "parent", "text", "start_ms", "end_ms")} for u in meeting["utterances"]]
        with open(os.path.join(dest, "meeting.json"), "w", encoding="utf-8") as f:
            json.dump({"id": short, "session": sid, "title": title, "utterances": rows}, f, ensure_ascii=False)
        shutil.copyfile(os.path.join(ROOT, "test-media", stem + ".wav"), os.path.join(dest, "audio.wav"))
        print(f"{short}: {len(rows)} 句 → {dest}")


def secret_from_env():
    secret = os.environ.get("LABEL_SECRET", "")
    if len(secret) < 32:
        sys.exit("LABEL_SECRET 未设置或太短")
    return secret


def links(args):
    secret = secret_from_env()
    print(f"全队\t{args.base}#k={make_key(secret, TEAM)}")
    for name in PEOPLE:
        print(f"{name}\t{args.base}#k={make_key(secret, name)}")


def merge_cmd(args):
    import dji_to_eval
    data = Data(args.data)
    for short in args.meetings:
        with open(os.path.join(args.data, "meetings", short, "meeting.json"), encoding="utf-8") as f:
            meeting = json.load(f)
        rows = data.rows_with_claims(short)
        folder = os.path.join(args.data, "labels", short)
        by_person = {}
        for name in PEOPLE:
            path = os.path.join(folder, name + ".json")
            labels = data.load(short, name)
            if labels:
                by_person[name] = labels
        truth = {"meeting": meeting["session"], "source": "team_label", **merge(rows, by_person, data.content_units(short))}
        out = os.path.join(ROOT, "evidence", meeting["session"], "truth.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(truth, f, ensure_ascii=False, indent=1)
        print(f"{short}: 标注人 {truth['labelers']}，任务 {len(truth['tasks'])}，决定 {len(truth['decisions'])}，"
              f"分歧 {len(truth['disputes'])} → {out}")
        print(json.dumps(dji_to_eval.fold_truth(short), ensure_ascii=False))


def serve(args):
    secret = secret_from_env()
    data = Data(args.data)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(data, secret))
    print(f"团队标注：127.0.0.1:{args.port}，{len(data.meetings)} 场", flush=True)
    server.serve_forever()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bundle"); b.add_argument("meetings", nargs="+"); b.add_argument("--out", required=True)
    s = sub.add_parser("serve"); s.add_argument("--data", required=True); s.add_argument("--port", type=int, default=8798)
    lk = sub.add_parser("links"); lk.add_argument("--base", required=True)
    m = sub.add_parser("merge"); m.add_argument("meetings", nargs="+"); m.add_argument("--data", required=True)
    args = parser.parse_args(argv)
    {"bundle": bundle, "serve": serve, "links": links, "merge": merge_cmd}[args.cmd](args)


with open(os.path.join(os.path.dirname(__file__), 'team_label_ui.html'), encoding='utf-8') as _ui_source:
    PAGE = _ui_source.read()


if __name__ == "__main__":
    main()
