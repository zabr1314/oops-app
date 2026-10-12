#!/usr/bin/env python3
"""Team labelling site for the discussion recordings: each person labels with a personal link, blind to the model
and to each other.

    team_label.py bundle 0235 0236 0238 --out build/label-data     # Mac: pack sentences + audio for the server
    team_label.py serve --data /var/lib/oops-label --port 8798     # server, behind nginx; LABEL_SECRET in the env
    team_label.py links --base https://giftedprofessor.xyz/oops-meeting/label/   # personal links (LABEL_SECRET)
    team_label.py merge --data <pulled data> 0236                   # → evidence/<session>/truth.json + disagreements

A person confirms voice groups, labels continuous expressions, and corrects individual sentences.
Identity linkage and content labels keep separate provenance and undo histories; tasks also need an owner. Labels are stored per person (labels/<meeting>/<name>.json) and merged into one
truth file afterwards; sentences on which labellers disagree are listed instead of silently picking one.
Listens on 127.0.0.1 only. Audio is served in single-sentence clips, only with a valid personal key.
"""
import argparse
import base64
import hashlib
import hmac
import hashlib
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
KINDS = ("task", "decision", "info", "noise")
# How the live tags (local_backend.TAGS) line up with the labels, for scoring the sentence triage itself.
LIVE_TAG = {"commitment": "task", "decision": "decision", "idea": "info", "constraint": "info", "chitchat": "noise"}
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


def merge(rows, by_person):
    """One truth from several labellers. A field counts when everyone who set it agrees; otherwise it is a dispute."""
    units = {uid: unit for unit in expressions(rows) for uid in unit['ids']}
    linked = {}
    reviewed = {}
    for person, labels in by_person.items():
        reviewed[person] = {}
        for row in rows:
            label = current_label(row, labels.get(row['id'], {}), units[row['id']])
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
        elif "kind" not in row_disputes and kind in ("info", "noise"):  # hard negatives for task finding
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
    return {"tasks": tasks, "decisions": decisions, "non_tasks": non_tasks, "kinds": kinds, "speakers": speakers,
            "voice_prefill_unreviewed": voice_only, "role_claim_unreviewed": role_only, "voice_prefill_overruled": voice_overruled,
            "voice_group_linked": linked,
            "duplicates": [list(g) for g in dup_sets], "disputes": disputes, "labelers": sorted(by_person)}


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
            doc[field] = doc['history'].pop()
        else:
            doc['history'] = (doc['history'] + [json.loads(json.dumps(doc[field]))])[-30:]
        doc['revision'] += 1
        doc['seen'][request] = fingerprint
        doc['seen'] = dict(list(doc['seen'].items())[-100:])
        return True

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

    def meeting_payload(self, mid, name):
        rows = self.rows_with_claims(mid)
        doc = self._document(mid, name)
        labels = self.load(mid, name)
        audit = content_audit(rows, {name: labels})
        units = expressions(rows)
        by_id = {uid: e for e in units for uid in e['ids']}
        current = {u['id']: current_label(u, labels.get(u['id'], {}), by_id[u['id']]) for u in rows}
        current = {uid: label for uid, label in current.items() if label}
        return dict(id=mid, rows=[dict(u, chars=chars(u), fingerprint=row_fingerprint(u)) for u in rows], labels=current,
            stale_ids=list(set(audit['stale_kind_ids'] + audit['stale_speaker_ids'])),
            expressions=audit['expressions'], revision=doc['revision'], can_undo=bool(doc['history']),
            content_progress={k: audit[k] for k in ('required_expression_count', 'complete_required_expressions',
                'context_expression_count', 'ready_for_content')})

    def review(self, mid, name, body):
        with self.lock:
            doc = self._document(mid, name)
            if not self._begin(doc, body, 'labels'):
                return self.meeting_payload(mid, name)
            if body.get('action') != 'undo':
                rows = self.rows_with_claims(mid)
                field, value = body.get('field'), body.get('value')
                if field not in ('kind', 'speaker', 'owner', 'dup'):
                    raise ValueError('unknown field')
                expression = None
                if body.get('scope') == 'expression':
                    if field == 'speaker':
                        raise ValueError('expression cannot establish speaker identity')
                    expression = next((e for e in expressions(rows) if e['id'] == body.get('expression')), None)
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
                allowed = {'kind': KINDS, 'speaker': PEOPLE + list(SPEAKER_OTHER),
                    'owner': PEOPLE + list(OWNER_OTHER), 'dup': list(DUPS)}
                if value is not None and value not in allowed[field]:
                    raise ValueError('unknown value')
                for uid in ids:
                    label = doc['labels'].setdefault(uid, {})
                    # Whole-expression changes preserve deliberate single-row exceptions.
                    row = next(u for u in rows if u['id'] == uid)
                    if expression and current_label(row, label, expression).get('kind') \
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
                        label['kind_source'] = dict(mode='single', id=uid, fingerprint=row_fingerprint(row))
                doc['labels'] = clean(doc['labels'], rows)
            doc.update(meeting=mid, labeler=name)
            self._write(self.labels_path(mid, name), doc)
            return self.meeting_payload(mid, name)

    def labels_path(self, mid, name):
        return os.path.join(self.folder, "labels", mid, name + ".json")

    def load(self, mid, name):
        labels = self._document(mid, name)['labels']
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
                return self.send(200, json.dumps(data.meeting_payload(mid, name), ensure_ascii=False).encode())
            m = re.fullmatch(r"/clip/([0-9]{4})/([A-Za-z0-9_-]{1,40})\.wav", url.path)
            if m and m.group(2) in index.get(m.group(1), {}):
                u = index[m.group(1)][m.group(2)]
                pad = 0 if (query.get("pad") or [""])[0] == "0" else 300
                end_ms = u['end_ms']
                through = (query.get('through') or [''])[0]
                if through:
                    expr = next((e for e in expressions(data.rows_with_claims(m.group(1)))
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
                if not 0 < size <= 10000:
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
        truth = {"meeting": meeting["session"], "source": "team_label", **merge(rows, by_person)}
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


PAGE = r"""<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Oops 讨论标注</title>
<style>
:root{color-scheme:light;--bg:#f7f6fb;--fg:#1d1b26;--mut:#6f6b80;--line:#e4e1ee;--card:#fff;--brand:#6d5be8;--brand-soft:#ece9ff;--ok:#16a34a;--dec:#d97706;--cur:#fff8d6}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#16151c;--fg:#f2f1f7;--mut:#a29fb3;--line:#34313f;--card:#211f2a;--brand:#8f80ff;--brand-soft:#2d2850;--cur:#3a3420}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 16px}
.hrow{display:flex;gap:8px 14px;align-items:center;flex-wrap:wrap;max-width:1000px;margin:0 auto}
h1{font-size:16px;margin:0}.mut{color:var(--mut);font-size:13px}
.tabs{display:flex;gap:6px;flex-wrap:wrap}.tabs button,.tool{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}
.tabs button.on{background:var(--brand);border-color:var(--brand);color:#fff}.tool.on{background:var(--brand-soft);border-color:var(--brand)}
select.tool{padding:4px 8px}
main{max-width:1000px;margin:0 auto;padding:8px 16px 120px}
details.help{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px 14px;margin:10px 0;font-size:14px}
details.help summary{cursor:pointer;font-weight:600}details.help li{margin:3px 0}kbd{border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:12px;background:var(--bg)}
.row{background:var(--card);border:1px solid var(--line);border-left:4px solid transparent;border-radius:12px;padding:8px 12px;margin:6px 0;scroll-margin:120px 0 160px}
.row.mini{padding:2px 12px;margin:2px 0;background:none;border-color:transparent}.row.mini .txt{font-size:14px;color:var(--mut)}.row.mini .c{min-height:24px;padding:0 8px;font-size:12px;color:var(--mut)}.row.mini.cur{box-shadow:0 0 0 1px var(--line)}
.row.done{border-left-color:var(--ok)}.row.k-task{border-left-color:var(--brand)}.row.k-decision{border-left-color:var(--dec)}.row.k-info{border-left-color:#0e9f8e}
.row.cur{box-shadow:0 0 0 2px var(--brand)}.row.playing{background:var(--cur)}
.top{display:flex;gap:10px;align-items:flex-start}.t{color:var(--mut);font-variant-numeric:tabular-nums;min-width:42px;font-size:12px;padding-top:4px}
.txt{flex:1;font-size:16px;cursor:pointer}.play{border:1px solid var(--line);background:none;color:var(--fg);border-radius:8px;padding:3px 10px;cursor:pointer;font:inherit;font-size:13px;flex:none}
.ctl{display:flex;gap:6px 12px;flex-wrap:wrap;margin-top:6px;align-items:center}
.grp{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}.grp>span{color:var(--mut);font-size:12px;margin-right:2px}
.c{border:1px solid var(--line);background:none;color:var(--fg);border-radius:8px;padding:3px 9px;font:inherit;font-size:13px;cursor:pointer;min-height:30px}
.role{display:grid;gap:6px;padding:10px 0;border-top:1px solid var(--line)}.role:first-child{border-top:0}.role .clip{display:flex;gap:8px;align-items:baseline;font-size:14px}.role .clip span{color:var(--mut)}
.c.on{background:var(--brand);border-color:var(--brand);color:#fff}.c.on.dec{background:var(--dec);border-color:var(--dec)}.c.on.vp{background:var(--brand-soft);color:var(--fg);border-style:dashed;border-color:var(--brand)}.vpnote{font-style:normal;font-size:12px;color:var(--mut);margin-left:4px}
.c.on.neg{background:var(--mut);border-color:var(--mut)}.c.on.inf{background:#0e9f8e;border-color:#0e9f8e}
.sep{width:1px;height:20px;background:var(--line)}
#state.err{color:#dc2626;font-weight:600}
.empty{padding:40px 0;text-align:center;color:var(--mut)}
#gate{max-width:420px;margin:15vh auto;padding:0 16px;text-align:center}
@media(max-width:640px){header{padding:6px 12px}main{padding:4px 10px 120px}h1{display:none}.t{display:none}.txt{font-size:15px}
.row{padding:8px 10px}.ctl{gap:6px}.grp>span{display:none}.c{padding:2px 7px;min-height:32px}.hide-s{display:none}.tool{padding:3px 9px}
.grp+.grp{padding-left:8px;border-left:1px solid var(--line)}}
.child{padding:12px 0;border-top:1px solid var(--line)}.corrections{margin-top:10px}.corrections summary,.members{font-size:13px}.members{max-height:360px;overflow:auto}.members>div{padding:8px 0;border-top:1px solid var(--line)}button:disabled,select:disabled{opacity:.5;cursor:wait}.role{padding:16px 0}.role .clip{align-items:flex-start}.role details summary{cursor:pointer}.child .txt{font-size:14px}
</style>
<div id="gate" hidden><h1>请用个人链接打开</h1><p class="mut">这个页面只对团队成员开放。请使用发给你的完整链接（包含 #k= 的那一段）。</p></div>
<div id="pick" hidden style="max-width:420px;margin:15vh auto;padding:0 16px;text-align:center"><h1>你是谁？</h1>
<p class="mut">选一次就记住，每个人的标注分开保存。</p><div class="tabs" id="pickers" style="justify-content:center;margin-top:16px"></div></div>
<div id="app" hidden>
<header><div class="hrow"><h1>Oops 讨论标注</h1><div class="tabs" id="tabs"></div><span class="mut" id="me"></span><span class="mut" id="state">已保存</span></div>
<div class="hrow" style="margin-top:6px"><span class="mut" id="prog"></span>
<button class="tool" id="cont" title="从当前表达开始连续播放，边听边标">▶ 连续播放</button>
<select class="tool" id="rate" title="播放速度"><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option></select>
<select class="tool" id="filter"><option value="all">全部表达</option><option value="todo">内容待核对</option><option value="who">身份待核对</option><option value="marked">任务 / 决定</option></select><button class="tool" id="undo-content">撤销本场上一步标注</button><button class="tool" id="undo-identity">撤销上一步音色组操作</button><button class="tool" id="reload">重新读取</button><button class="tool" id="retry" hidden>重试保存</button></div></header>
<main><details class="help" id="roles" hidden><summary id="roles-sum">认领声音</summary><p class="mut" style="margin:6px 0 0">同音色的片段放在一组。先听代表录音，查看关联范围，再确认是谁；单句纠错优先，整组可撤销。身份确认只作用于“谁说的”。</p><div id="roles-list"></div></details>
<details class="help" id="help"><summary>怎么标</summary><ul>
<li>先在音色组里核对身份，一次关联多句；代表录音不能保证整组都正确，可以展开范围逐句移出或纠正。</li>
<li>连续表达合起来听、合起来标。整段按钮只改内容，不改说话人。已有单句内容纠错会保留；不同内容请展开逐句标。</li>
<li>短句上下文可以跳过，不会自动记成无效。若“你来”“就这么定”本身有任务或决定，请展开标注。</li>
<li>任务要核对负责人；有效包括观点、问题、方案、事实与限制；无效包括口头禅、闲聊和无意义重复。</li>
<li>内容和身份分别统计。每次操作收到服务器回执才显示已保存；失败可重试。本场标注和音色组确认分别恢复上一操作，刷新后仍可撤销。</li>
<li>你看不到模型内容分类，也看不到别人的逐句答案。快捷键：↑↓换表达，空格听整段，T任务、D决定、I有效、N无效。</li>
</ul></details><div id="list"></div></main></div>
<script>
const PEOPLE=__PEOPLE__, DUPS="__DUPS__";
const SHORTN={"林春源":"春源","洪玉麟":"玉麟","江古月":"古月","黄丽萍":"丽萍",other:'其他人',multi:'多人',unclear:'听不清',collective:'大家',unknown:'不确定'};
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=ms=>{const s=Math.floor(ms/1000);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};
const store={get(k){try{return localStorage.getItem(k)}catch(e){return null}},set(k,v){try{localStorage.setItem(k,v)}catch(e){}},remove(k){try{localStorage.removeItem(k)}catch(e){}}};
let KEY='', WHO=store.get('oops-label-who')||'', ME=null, M=null, U=[], L={}, E=[], DOC=null, IDENTITY=null, cur=0, audio=new Audio(), cont=false, busy=false, pending=null;
const OPEN=new Set(), hash=new URLSearchParams(location.hash.slice(1));
if(hash.get('k')){KEY=hash.get('k');store.set('oops-label-key',KEY);history.replaceState(null,'',location.pathname+location.search)}else KEY=store.get('oops-label-key')||'';
const api=(p,o={})=>fetch(p.replace(/^\//,''),{...o,headers:{...(o.headers||{}),Authorization:'Bearer '+KEY,...(WHO?{'X-Labeler':encodeURIComponent(WHO)}:{})}});
const pendingKey=()=>`oops-label-pending:${ME.name}`;
const status=(message,error=false)=>{$('#state').textContent=message;$('#state').className=error?'err':'mut'};
function lock(){document.querySelectorAll('#app button,#app select').forEach(b=>b.disabled=busy||!!pending);$('#retry').hidden=!pending;$('#retry').disabled=busy;$('#undo-content').disabled=busy||!!pending||!DOC?.can_undo;$('#undo-identity').disabled=busy||!!pending||!IDENTITY?.can_undo}
async function get(path){const r=await api(path);if(!r.ok)throw new Error(r.status);return r.json()}
function adopt(doc){DOC=doc;U=doc.rows;L=doc.labels;E=doc.expressions;cur=Math.min(cur,Math.max(0,E.length-1));renderList();lock()}
async function mutate(url,body){if(busy||pending)return;pending={url,body:{...body,request_id:crypto.randomUUID()}};store.set(pendingKey(),JSON.stringify(pending));await submit()}
async function submit(){if(busy||!pending)return;busy=true;lock();status('保存中…');const request=pending;
 try{const r=await api(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request.body)});
  if(r.status===409){pending=null;store.remove(pendingKey());IDENTITY=await get('/api/identity');renderGroups();if(M)adopt(await get('/api/meeting/'+M));status('另一页面或来源已更新，请核对后重新操作',true);return}
  if(!r.ok)throw new Error(r.status);const doc=await r.json();pending=null;store.remove(pendingKey());
  if(request.url==='/api/identity'){IDENTITY=doc;renderGroups();if(M)adopt(await get('/api/meeting/'+M))}else if(request.url===`/api/meeting/${M}/review`)adopt(doc);
  status('已保存');
 }catch(e){status(pending?'保存未确认，请重试；本次操作已留在这台设备':'操作已保存，页面刷新失败，请点重新读取',true)}finally{busy=false;lock()}}
function expressionAction(i,field,value){cur=i;const e=E[i];mutate(`/api/meeting/${M}/review`,{action:'set',scope:'expression',expression:e.id,fingerprint:e.fingerprint,field,value,revision:DOC.revision})}
function rowAction(id,field,value){cur=E.findIndex(e=>e.ids.includes(id));const row=U.find(u=>u.id===id);mutate(`/api/meeting/${M}/review`,{action:'set',scope:'row',id,field,value,fingerprint:row.fingerprint,revision:DOC.revision})}
function chips(field,values,label,active,attrs){return `<span class="grp"><span>${label}</span>${values.map(v=>`<button class="c ${active===v?'on':''}" aria-pressed="${active===v}" ${attrs} data-field="${field}" data-value="${esc(v)}">${esc(SHORTN[v]||({task:'任务',decision:'决定',info:'有效',noise:'无效'}[v])||v)}</button>`).join('')}</span>`}
function childHTML(u){const l=L[u.id]||{},batch=l.speaker_source?.mode==='voice_group';
 const note=l.speaker?`${SHORTN[l.speaker]||l.speaker} · ${batch?'音色组关联':'单句核对'}`:l.speaker_excluded?'已移出整组，待核对':u.voice?`候选：${u.voice}，未确认`:'身份待核对';
 return `<div class="child" data-row="${esc(u.id)}"><div class="top"><span class="t">${clock(u.start_ms)}</span><div class="txt">${esc(u.text)}</div><button class="play" data-row-play="${esc(u.id)}">▶</button></div><div class="mut">${esc(note)}${DOC.stale_ids?.includes(u.id)?' · 原话来源已变，旧标签待重核':''}${l.kind&&l.kind_source?.mode!=='expression'?' · 已单句纠错，整段标注会保留':''}</div>
 <div class="ctl">${chips('speaker',[...PEOPLE,'other','multi','unclear'],'谁说的',l.speaker,`data-row-id="${esc(u.id)}"`)}<button class="c" data-row-id="${esc(u.id)}" data-field="speaker" data-clear="1">移出关联 / 清空</button></div>
 <div class="ctl">${chips('kind',['task','decision','info','noise'],'内容',l.kind,`data-row-id="${esc(u.id)}"`)}<button class="c" data-row-id="${esc(u.id)}" data-field="kind" data-clear="1">清空内容</button></div>
 ${l.kind==='task'?`<div class="ctl">${chips('owner',[...PEOPLE,'collective','unknown'],'负责人',l.owner,`data-row-id="${esc(u.id)}"`)}</div>`:''}</div>`}
function exprState(e){const labels=e.ids.map(id=>L[id]||{}),kinds=[...new Set(labels.map(l=>l.kind||''))];return {done:labels.every(l=>l.kind&&(l.kind!=='task'||l.owner)),kind:kinds.length===1?kinds[0]:'mixed',needsOwner:labels.some(l=>l.kind==='task'&&!l.owner)}}
function visible(e){const s=exprState(e),f=$('#filter').value;return f==='all'||f==='todo'&&(!s.done&&(e.required_for_content||e.required||e.ids.some(id=>L[id]?.kind)||e.ids.some(id=>DOC.stale_ids?.includes(id))))||f==='who'&&e.ids.some(id=>!L[id]?.speaker)||f==='marked'&&e.ids.some(id=>['task','decision'].includes(L[id]?.kind))}
function renderList(){if(!DOC)return;$('#list').innerHTML=E.map((e,i)=>{if(!visible(e))return '';const s=exprState(e),rows=e.ids.map(id=>U.find(u=>u.id===id));
 return `<section class="row ${s.done?'done':''} ${i===cur?'cur':''}" data-i="${i}" id="expr-${i}"><div class="top"><span class="t">${clock(e.start_ms)}</span><div class="txt">${esc(e.text)}</div><button class="play" data-expr-play="${i}">▶ 整段</button></div>
 <div class="mut">${e.ids.length} 个原话片段 · ${e.required?'连续表达':'短句上下文，可跳过'}${s.kind==='mixed'?' · 含不同内容标签':''}${s.needsOwner?' · 任务负责人待核对':''}</div>
 <div class="ctl">${chips('kind',['task','decision','info','noise'],'整段标注',s.kind,`data-expr="${i}"`)}</div>
 ${e.ids.some(id=>L[id]?.kind==='task')?`<div class="ctl">${chips('owner',[...PEOPLE,'collective','unknown'],'整段任务负责人','',`data-expr="${i}"`)}</div>`:''}
 ${e.ids.some(id=>['task','decision'].includes(L[id]?.kind))?`<div class="ctl"><label class="mut">同一件事 <select class="tool" data-expr="${i}" data-field="dup"><option value="">选择分组</option>${DUPS.split('').map(x=>`<option>${x}</option>`).join('')}</select></label></div>`:''}
 <details class="corrections" data-expression="${esc(e.id)}" ${OPEN.has(e.id)?'open':''}><summary>展开 ${e.ids.length} 句纠错 / 不同内容分开标</summary>${rows.map(childHTML).join('')}</details></section>`}).join('')||'<div class="empty">没有符合条件的表达</div>';
 const p=DOC.content_progress;$('#prog').textContent=`内容已核对 ${p.complete_required_expressions}/${p.required_expression_count} 段 · 短句上下文 ${p.context_expression_count} 段可跳过 · 身份另行核对`;
 const tab=document.querySelector(`#tabs button[data-m="${M}"] small`);if(tab)tab.textContent=` ${p.complete_required_expressions}/${p.required_expression_count}`;lock()}
function setCur(i,scroll=true){if(i<0||i>=E.length)return;cur=i;renderList();if(scroll)document.getElementById('expr-'+i)?.scrollIntoView({block:'nearest'})}
function renderGroups(){if(!IDENTITY)return;$('#roles').hidden=!IDENTITY.groups.length;const open=IDENTITY.groups.filter(g=>!g.current).length;$('#roles-sum').textContent=`按音色确认身份 · ${open} 组待核对`;
 $('#roles-list').innerHTML=IDENTITY.groups.map((g,i)=>`<div class="role" data-group-index="${i}"><b>${esc(g.title)} · ${g.count} 句 / ${new Set(g.members.map(m=>m.meeting)).size} 场</b>
 <div class="mut">${g.current?`已由你批量关联为 ${esc(SHORTN[g.approval.speaker]||g.approval.speaker)}；单句纠错优先`:g.approval?'音色组已变化，请重新核对':g.suggested_person?`已有建议：${esc(g.suggested_person)}，请听录音后确认`:'听代表录音后选择身份'}。批量关联不代表逐句听过。</div>
 ${g.clips.map(c=>`<div class="clip"><button class="play" data-group-clip="${esc(c.meeting)}/${esc(c.id)}">▶</button><span>${esc(c.meeting)}</span>${esc(c.text)}</div>`).join('')}
 <div class="ctl"><select class="tool" data-group-speaker="${i}"><option value="">选择这组是谁</option>${[...PEOPLE,'other','multi','unclear'].map(p=>`<option value="${esc(p)}">${esc(SHORTN[p]||p)}</option>`).join('')}</select><button class="c" data-confirm-group="${i}">确认关联 ${g.count} 句</button>${g.approval?`<button class="c" data-revoke-group="${i}">撤销本组确认</button>`:''}</div>
 <details><summary>查看关联范围 / 单句纠错</summary><div class="members">${g.members.map(m=>`<div><span class="mut">${esc(m.meeting)} ${clock(m.start_ms)}</span> ${esc(m.text)} <button class="c" data-jump-meeting="${esc(m.meeting)}" data-jump-row="${esc(m.id)}">纠错</button></div>`).join('')}</div></details></div>`).join('');lock()}
async function openMeeting(mid,jump){if(busy||pending)return;busy=true;lock();stopCont();audio.pause();status('读取中…');try{const doc=await get('/api/meeting/'+mid);M=mid;store.set('oops-label-meeting',mid);document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('on',b.dataset.m===mid));adopt(doc);if(jump){$('#filter').value='all';const i=E.findIndex(e=>e.ids.includes(jump));if(i>=0){OPEN.add(E[i].id);cur=i;renderList();document.getElementById('expr-'+i)?.scrollIntoView({block:'center'})}}status('已保存')}catch(e){status('读取失败，请重试',true)}finally{busy=false;lock()}}
function stopCont(){cont=false;$('#cont').textContent='▶ 连续播放'}
function playClip(mid,first,last,ended){audio.pause();audio=new Audio(`clip/${mid}/${first}.wav?pad=0${last?'&through='+encodeURIComponent(last):''}&k=${encodeURIComponent(KEY)}`);audio.playbackRate=+$('#rate').value;audio.onended=ended||null;audio.play().catch(()=>{stopCont();status('音频读取失败，请重试',true)})}
function playExpression(i){const e=E[i];playClip(M,e.ids[0],e.ids[e.ids.length-1],()=>{if(cont&&i+1<E.length){setCur(i+1);playExpression(i+1)}else stopCont()})}
$('#list').addEventListener('toggle',e=>{if(e.target.matches('details.corrections')){const id=e.target.dataset.expression;if(e.target.open)OPEN.add(id);else OPEN.delete(id)}},true);
$('#list').addEventListener('click',e=>{const section=e.target.closest('section.row');if(section){cur=+section.dataset.i;document.querySelectorAll('#list .row').forEach(row=>row.classList.toggle('cur',row===section))}const b=e.target.closest('button');if(!b)return;if(b.dataset.exprPlay!==undefined){cur=+b.dataset.exprPlay;stopCont();playExpression(cur);return}if(b.dataset.rowPlay){stopCont();playClip(M,b.dataset.rowPlay);return}if(b.dataset.field){if(b.dataset.rowId)rowAction(b.dataset.rowId,b.dataset.field,b.dataset.clear?null:b.dataset.value);else if(b.dataset.expr!==undefined)expressionAction(+b.dataset.expr,b.dataset.field,b.dataset.value)}});
$('#list').addEventListener('change',e=>{if(e.target.dataset.field==='dup'&&e.target.value)expressionAction(+e.target.dataset.expr,'dup',e.target.value)});
$('#roles-list').addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.groupClip){stopCont();const [mid,id]=b.dataset.groupClip.split('/');playClip(mid,id);return}if(b.dataset.jumpMeeting){await openMeeting(b.dataset.jumpMeeting,b.dataset.jumpRow);return}const i=b.dataset.confirmGroup??b.dataset.revokeGroup;if(i===undefined)return;const g=IDENTITY.groups[+i],speaker=$(`[data-group-speaker="${i}"]`).value;if(b.dataset.confirmGroup!==undefined&&!speaker){status('先听代表片段，再选择这组是谁',true);return}await mutate('/api/identity',{action:b.dataset.confirmGroup!==undefined?'confirm':'revoke',group:g.id,fingerprint:g.fingerprint,speaker,revision:IDENTITY.revision})});
$('#reload').onclick=async()=>{try{IDENTITY=await get('/api/identity');renderGroups();if(M)await openMeeting(M)}catch(e){status('读取失败，请重试',true)}};$('#undo-content').onclick=()=>mutate(`/api/meeting/${M}/review`,{action:'undo',revision:DOC.revision});$('#undo-identity').onclick=()=>mutate('/api/identity',{action:'undo',revision:IDENTITY.revision});$('#retry').onclick=submit;
$('#filter').onchange=renderList;$('#cont').onclick=()=>{if(cont){audio.pause();stopCont()}else if(E.length){cont=true;$('#cont').textContent='❚❚ 暂停';playExpression(cur)}};$('#rate').onchange=()=>{audio.playbackRate=+$('#rate').value;store.set('oops-label-rate',$('#rate').value)};
document.addEventListener('keydown',e=>{if(/SELECT|INPUT|TEXTAREA/.test(e.target.tagName)||e.metaKey||e.ctrlKey||e.altKey||busy||pending||!E.length)return;const k=e.key.toLowerCase();if(k==='arrowdown'||k==='arrowup'){e.preventDefault();setCur(cur+(k==='arrowdown'?1:-1))}else if(k===' '){e.preventDefault();stopCont();playExpression(cur)}else if({t:1,d:1,i:1,n:1}[k])expressionAction(cur,'kind',{t:'task',d:'decision',i:'info',n:'noise'}[k])});
(async()=>{if(!KEY){$('#gate').hidden=false;return}try{ME=await get('/api/me');if(!ME.name){if(WHO){WHO='';store.set('oops-label-who','')}$('#pick').hidden=false;$('#pickers').innerHTML=ME.people.map(p=>`<button data-p="${esc(p)}">${esc(p)}</button>`).join('');$('#pickers').onclick=e=>{const b=e.target.closest('button');if(b){store.set('oops-label-who',b.dataset.p);location.reload()}};return}
 $('#app').hidden=false;$('#me').innerHTML=esc(ME.name)+(WHO?' <button class="tool" id="switch">换人</button>':'');$('#switch')?.addEventListener('click',()=>{if(busy||pending)return;store.remove('oops-label-who');location.reload()});$('#rate').value=store.get('oops-label-rate')||'1';
 $('#tabs').innerHTML=ME.meetings.map(m=>`<button data-m="${esc(m.id)}">${esc(m.id)}<small></small></button>`).join('');$('#tabs').onclick=e=>{const b=e.target.closest('button');if(b&&b.dataset.m!==M)openMeeting(b.dataset.m)};
 IDENTITY=await get('/api/identity');renderGroups();$('#roles').open=IDENTITY.groups.some(g=>!g.current);const last=store.get('oops-label-meeting');await openMeeting(ME.meetings.some(m=>m.id===last)?last:ME.meetings[0].id);
 const saved=store.get(pendingKey());if(saved){pending=JSON.parse(saved);status('有一次保存尚未确认，请重试',true);lock()}
 }catch(e){$('#gate').hidden=false;$('#gate p').textContent='读取失败或链接已失效，请重新打开原来的完整链接。'}})();
window.addEventListener('hashchange',()=>{if(new URLSearchParams(location.hash.slice(1)).get('k'))location.reload()});
</script></html>"""


if __name__ == "__main__":
    main()
