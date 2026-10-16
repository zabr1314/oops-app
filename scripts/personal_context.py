#!/usr/bin/env python3
"""Private, revisioned assistant context; authentication stays with the caller.

``principal_guard(principal_id)`` must read the current authenticated phone
session and return ``principal_id``, a verified ``account_key``, and
``binding_revision``. It must reject revoked sessions. An operation compares this
snapshot again before committing/returning. Storage uses that verified account
key so two authenticated phones of the same account share personal context.
Unbound sessions cannot sync; display names/client account IDs are not identities.

``source_guard(principal_id, source, phase)`` is a local, read-only check of the
current service's meeting source. ``phase`` is ``write`` or ``read``. It returns
the canonical source (including service_id and fingerprint), False/None for a
definitively invalid source, or raises for temporarily unavailable verification.
The callback must enforce object access as well as source validity. On write,
the server, not the client, supplies the canonical fingerprint. On read that
fingerprint must still match. Explicit invalidation purges the derived text and
requires a new human confirmation; a temporary check failure only hides it.

All save/delete bodies require op_id and expected_revision (0 for a new entry).
Saves also require confirmed: true and a value dictionary. Profile fields are
name/role/context. Preference fields are enabled/tone/answer_length/focus/avoid/
context; enabled defaults to false. All values accept scenarios from SCENARIOS
(default: 通用), and snapshot takes the explicit target scenario. Memories
additionally require memory_id and source
(``{kind: manual}`` or a meeting source), and accept title/body/category.
Category person additionally requires a stable explicit person_id and a
person_kind (fact/preference/background/commitment); person_name is a label.
Those fields are forbidden on other categories. Person records currently only
accept manual sources: this backend has no trustworthy stable speaker IDs.
Snapshots require an explicit matching person_id to include any person record;
memory_ids alone never imply consent to use someone else's information.

Snapshots are server-built inputs, not execution or sharing permissions. Store
the returned snapshot with a task and call validate_snapshot again immediately
before use. Never accept its text directly from an HTTP client as trusted input.
The optional commit_guard fences account changes through SQLite commit; the
integration supplies it and a source_lock acquired before the context lock.
"""

import contextlib
import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone


class PersonalContextError(ValueError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def _fail(status, code, message):
    raise PersonalContextError(status, code, message)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _identifier(value, name):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value):
        _fail(400, "PERSONAL_CONTEXT_INVALID", f"{name}无效")
    return value


def _revision(value):
    if type(value) is not int or not 0 <= value <= 2**53 - 1:
        _fail(400, "PERSONAL_CONTEXT_INVALID", "请提供有效的 expected_revision")
    return value


class PersonalContext:
    MAX_MEMORIES = 200
    MAX_SNAPSHOT_MEMORIES = 20
    MAX_SNAPSHOT_CHARS = 12000
    _PROFILE = {"name": 80, "role": 160, "context": 800}
    _PREFERENCES = {"tone": 400, "answer_length": 80, "focus": 600, "avoid": 600}
    _MEMORY = {"title": 160, "body": 2000, "category": 30}
    PERSON_KINDS = ("fact", "preference", "background", "commitment")

    SCENARIOS = ("通用", "会议", "汇报", "写作", "研究")

    def __init__(self, state_dir, *, principal_guard, source_guard=None, commit_guard=None, source_lock=None, clock=None):
        if not callable(principal_guard):
            raise TypeError("a current authenticated principal_guard is required")
        self.principal_guard = principal_guard
        self.source_guard = source_guard
        self.commit_guard = commit_guard
        self.source_lock = source_lock
        self.clock = clock or time.time
        self.lock = threading.RLock()
        self.directory = os.path.join(os.fspath(state_dir), "personal-context")
        self.path = os.path.join(self.directory, "context.sqlite3")
        if os.path.islink(self.directory) or os.path.islink(self.path):
            _fail(503, "PERSONAL_CONTEXT_STORAGE_UNAVAILABLE", "个人上下文存储不可用")
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        os.chmod(self.directory, 0o700)
        with self._transaction() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS contexts (
                    subject TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS entries (
                    subject TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
                    revision INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
                    invalidated INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL,
                    source TEXT NOT NULL, updated_at TEXT NOT NULL,
                    PRIMARY KEY(subject,kind,id));
                CREATE TABLE IF NOT EXISTS operations (
                    subject TEXT NOT NULL, op_id TEXT NOT NULL, request_hash TEXT NOT NULL,
                    kind TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
                    PRIMARY KEY(subject,op_id));
            """)

    @contextlib.contextmanager
    def _transaction(self, identity=None):
        with contextlib.ExitStack() as locks:
            # The integration's source lock precedes this database lock, also
            # for background invalidation. Never invert meetings -> context.
            if self.source_lock is not None:
                locks.enter_context(self.source_lock)
            locks.enter_context(self.lock)
            if os.path.islink(self.directory) or os.path.islink(self.path):
                _fail(503, "PERSONAL_CONTEXT_STORAGE_UNAVAILABLE", "个人上下文存储不可用")
            db = sqlite3.connect(self.path, timeout=10)
            os.chmod(self.path, 0o600)
            db.row_factory = sqlite3.Row
            try:
                db.execute("PRAGMA secure_delete=ON")
                db.execute("BEGIN IMMEDIATE")
                yield db
                with self.commit_guard(identity) if identity and self.commit_guard else contextlib.nullcontext():
                    if identity:
                        self._recheck(identity)
                    db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

    def _identity(self, principal):
        _identifier(principal, "本人身份")
        value = self.principal_guard(principal)
        if not isinstance(value, dict) or value.get("active", True) is not True:
            _fail(401, "PERSONAL_CONTEXT_UNAUTHORIZED", "个人会话已失效，请重新连接")
        if value.get("principal_id") != principal:
            _fail(401, "PERSONAL_CONTEXT_UNAUTHORIZED", "个人身份不一致，请重新连接")
        account = value.get("account_key", "")
        rev = value.get("binding_revision")
        if not isinstance(account, str) or not account or len(account) > 300 or type(rev) is not int or rev < 0:
            _fail(401, "PERSONAL_CONTEXT_UNAUTHORIZED", "个人会话状态无效")
        return {"principal_id": principal, "account_key": account, "binding_revision": rev}

    @staticmethod
    def _subject(identity):
        return _hash(["verified-account", identity["account_key"]])

    def _recheck(self, identity):
        if self._identity(identity["principal_id"]) != identity:
            _fail(409, "PERSONAL_CONTEXT_IDENTITY_CHANGED", "个人账号已变化，请重新读取后操作")

    def _now(self):
        return datetime.fromtimestamp(self.clock(), timezone.utc).isoformat()

    @staticmethod
    def _bump(db, subject):
        db.execute("INSERT OR IGNORE INTO contexts(subject,revision) VALUES (?,0)", (subject,))
        db.execute("UPDATE contexts SET revision=revision+1 WHERE subject=?", (subject,))

    @staticmethod
    def _context_revision(db, subject):
        row = db.execute("SELECT revision FROM contexts WHERE subject=?", (subject,)).fetchone()
        return row[0] if row else 0

    @staticmethod
    def _row(db, subject, kind, identifier):
        return db.execute("SELECT * FROM entries WHERE subject=? AND kind=? AND id=?", (subject, kind, identifier)).fetchone()

    @staticmethod
    def _fields(kind, value):
        limits = PersonalContext._PROFILE if kind == "profile" else PersonalContext._PREFERENCES if kind == "preferences" else PersonalContext._MEMORY
        person = kind == 'memory' and isinstance(value, dict) and value.get('category') == 'person'
        allowed = (set(limits) | {"scenarios"} | ({"enabled", "context"} if kind == "preferences" else set()) |
                   ({"person_id", "person_name", "person_kind"} if person else set()))
        if not isinstance(value, dict) or set(value) - allowed:
            _fail(400, "PERSONAL_CONTEXT_INVALID", "个人上下文含不支持的字段")
        normalized = {}
        for field, limit in limits.items():
            text = value.get(field, "")
            if not isinstance(text, str) or len(text) > limit or "\x00" in text:
                _fail(400, "PERSONAL_CONTEXT_INVALID", f"{field}格式或长度无效")
            normalized[field] = text.strip()
        scenarios = value.get("scenarios", ["通用"])
        if (not isinstance(scenarios, list) or not 1 <= len(scenarios) <= len(PersonalContext.SCENARIOS) or
                any(item not in PersonalContext.SCENARIOS for item in scenarios)):
            _fail(400, "PERSONAL_CONTEXT_INVALID", "请选择明确的个人上下文适用场景")
        normalized["scenarios"] = sorted(set(scenarios), key=PersonalContext.SCENARIOS.index)
        if kind == "preferences":
            if type(value.get("enabled", False)) is not bool:
                _fail(400, "PERSONAL_CONTEXT_INVALID", "enabled 必须为布尔值")
            normalized["enabled"] = value.get("enabled", False)
            context = value.get("context", "")
            if not isinstance(context, str) or len(context) > 800 or "\x00" in context:
                _fail(400, "PERSONAL_CONTEXT_INVALID", "偏好适用背景格式或长度无效")
            normalized["context"] = context.strip()
        elif kind == "memory":
            if not normalized["title"] or not normalized["body"]:
                _fail(400, "PERSONAL_CONTEXT_INVALID", "请填写记忆标题与内容")
            normalized["category"] = normalized["category"] or "background"
            if normalized["category"] not in {"background", "goal", "fact", "preference", "person"}:
                _fail(400, "PERSONAL_CONTEXT_INVALID", "记忆类型无效")
            if person:
                normalized['person_id'] = _identifier(value.get('person_id'), '人物编号')
                label = value.get('person_name', '')
                if not isinstance(label, str) or len(label) > 80 or '\x00' in label:
                    _fail(400, 'PERSONAL_CONTEXT_INVALID', '人物显示名称格式或长度无效')
                if value.get('person_kind') not in PersonalContext.PERSON_KINDS:
                    _fail(400, 'PERSONAL_CONTEXT_INVALID', '请选择人物记忆类型')
                normalized['person_name'] = label.strip()
                normalized['person_kind'] = value['person_kind']
        return normalized

    @staticmethod
    def _source(value, canonical=False):
        if not isinstance(value, dict):
            _fail(400, "PERSONAL_CONTEXT_INVALID", "请明确记忆来源")
        kind = value.get("kind")
        if kind == "manual":
            if set(value) != {"kind"}:
                _fail(400, "PERSONAL_CONTEXT_INVALID", "手填记忆不接受伪造来源")
            return {"kind": "manual"}
        allowed = {"kind", "session_id", "utterance_ids", "service_id", "fingerprint", "origin_principal_id"}
        if kind != "meeting" or set(value) - allowed:
            _fail(400, "PERSONAL_CONTEXT_INVALID", "仅支持手填或当前服务的会议来源")
        sid = _identifier(value.get("session_id"), "来源会议")
        ids = value.get("utterance_ids")
        if not isinstance(ids, list) or not 1 <= len(ids) <= 20:
            _fail(400, "PERSONAL_CONTEXT_INVALID", "请选择 1 至 20 条明确原话")
        ids = sorted(set(_identifier(item, "原话编号") for item in ids))
        result = {"kind": "meeting", "session_id": sid, "utterance_ids": ids}
        for field in ("service_id", "fingerprint"):
            item = value.get(field)
            if item is not None:
                if not isinstance(item, str) or not item or len(item) > 300 or "\x00" in item:
                    _fail(400, "PERSONAL_CONTEXT_INVALID", "来源服务或指纹无效")
                result[field] = item
            elif canonical:
                _fail(503, "PERSONAL_CONTEXT_SOURCE_UNAVAILABLE", "来源校验未提供服务归属和指纹")
        if "origin_principal_id" in value:
            result["origin_principal_id"] = _identifier(value["origin_principal_id"], "来源身份")
        return result

    def _checked_source(self, principal, source, phase):
        if source["kind"] == "manual":
            return source
        if not callable(self.source_guard):
            _fail(503, "PERSONAL_CONTEXT_SOURCE_UNAVAILABLE", "当前服务尚未接通会议来源校验")
        checked = self.source_guard(principal, dict(source, utterance_ids=list(source["utterance_ids"])), phase)
        if checked is False or checked is None:
            return None
        checked = self._source(checked, canonical=True)
        if any(checked.get(key) != source[key] for key in ("kind", "session_id", "utterance_ids")):
            _fail(409, "PERSONAL_CONTEXT_SOURCE_CHANGED", "来源校验改变了所选原话，请重新选择")
        if phase == "read" and checked != source:
            return None
        return checked

    def _view(self, db, subject, principal, row):
        item = {"kind": row["kind"], "id": row["id"], "revision": row["revision"],
                "updated_at": row["updated_at"], "confirmed": False, "value": None, "source": None}
        if row["deleted"]:
            return dict(item, status="deleted")
        if row["invalidated"]:
            return dict(item, status="needs_review")
        source = json.loads(row["source"])
        value = json.loads(row['value'])
        try:
            checked = (None if value.get('category') == 'person' and source.get('kind') != 'manual' else
                       self._checked_source(principal, source, "read"))
        except Exception:
            # No source text is returned when verification cannot complete.
            return dict(item, status="source_unavailable")
        if checked is None:
            item.update(revision=row["revision"] + 1, updated_at=self._now())
            db.execute("UPDATE entries SET revision=?,invalidated=1,value='{}',source='{}',updated_at=? WHERE subject=? AND kind=? AND id=?",
                       (item["revision"], item["updated_at"], subject, row["kind"], row["id"]))
            self._bump(db, subject)
            return dict(item, status="needs_review")
        return dict(item, status="current", confirmed=True, value=value, source=source)

    def read(self, principal):
        identity = self._identity(principal)
        subject = self._subject(identity)
        with self._transaction(identity) as db:
            rows = db.execute("SELECT * FROM entries WHERE subject=? ORDER BY kind,id", (subject,)).fetchall()
            entries = [self._view(db, subject, principal, row) for row in rows]
            result = {"context_revision": self._context_revision(db, subject), "identity_revision": identity["binding_revision"],
                      "profile": None, "preferences": None, "memories": []}
            for item in entries:
                if item["kind"] == "memory":
                    result["memories"].append(item)
                else:
                    result[item["kind"]] = item
            self._recheck(identity)
        self._recheck(identity)
        return result

    def _mutate(self, principal, kind, body, delete=False):
        if not isinstance(body, dict):
            _fail(400, "PERSONAL_CONTEXT_INVALID", "请求必须是对象")
        allowed = {"op_id", "expected_revision", "memory_id"} if delete else {"op_id", "expected_revision", "confirmed", "value", "source", "memory_id"}
        if set(body) - allowed or kind != "memory" and ("memory_id" in body or "source" in body):
            _fail(400, "PERSONAL_CONTEXT_INVALID", "请求含不支持的字段")
        op_id = _identifier(body.get("op_id"), "操作编号")
        expected = _revision(body.get("expected_revision"))
        identifier = _identifier(body.get("memory_id"), "记忆编号") if kind == "memory" else "current"
        value, source = None, None
        if not delete:
            if body.get("confirmed") is not True:
                _fail(400, "PERSONAL_CONTEXT_CONFIRMATION_REQUIRED", "请本人明确核对后保存")
            value = self._fields(kind, body.get("value"))
            source = self._source(body.get("source")) if kind == "memory" else {"kind": "manual"}
            if kind == 'memory' and value.get('category') == 'person' and source['kind'] != 'manual':
                _fail(409, 'PERSON_IDENTITY_UNVERIFIED', '会议尚无可核实的稳定人物身份，请明确作为本人手工记录保存')
        request_hash = _hash({"kind": kind, "id": identifier, "expected_revision": expected, "delete": delete,
                              "value": value, "source": source})
        identity = self._identity(principal)
        subject = self._subject(identity)
        with self._transaction(identity) as db:
            operation = db.execute("SELECT * FROM operations WHERE subject=? AND op_id=?", (subject, op_id)).fetchone()
            if operation and operation["request_hash"] != request_hash:
                _fail(409, "PERSONAL_CONTEXT_OPERATION_CONFLICT", "该操作编号已用于另一项修改")
            row = self._row(db, subject, kind, identifier)
            if not operation:
                if expected != (row["revision"] if row else 0):
                    _fail(409, "PERSONAL_CONTEXT_REVISION_CONFLICT", "内容已在别处更新，请重新读取后修改")
                if delete and not row:
                    _fail(404, "PERSONAL_CONTEXT_NOT_FOUND", "没有这条记忆")
                if not delete:
                    source = self._checked_source(principal, source, "write")
                    if source is None:
                        _fail(409, "PERSONAL_CONTEXT_SOURCE_CHANGED", "原话已变化或不再可用，请重新核对")
                    if kind == "memory" and row is None:
                        count = db.execute("SELECT COUNT(*) FROM entries WHERE subject=? AND kind='memory'", (subject,)).fetchone()[0]
                        if count >= self.MAX_MEMORIES:
                            _fail(409, "PERSONAL_CONTEXT_LIMIT", "个人记忆数量已达本阶段上限")
                revision, updated = expected + 1, self._now()
                db.execute("""INSERT INTO entries(subject,kind,id,revision,deleted,invalidated,value,source,updated_at)
                    VALUES (?,?,?,?,?,0,?,?,?) ON CONFLICT(subject,kind,id) DO UPDATE SET
                    revision=excluded.revision,deleted=excluded.deleted,invalidated=0,value=excluded.value,
                    source=excluded.source,updated_at=excluded.updated_at""",
                           (subject, kind, identifier, revision, int(delete), _json({} if delete else value),
                            _json({} if delete else source), updated))
                db.execute("INSERT INTO operations(subject,op_id,request_hash,kind,id,revision) VALUES (?,?,?,?,?,?)",
                           (subject, op_id, request_hash, kind, identifier, revision))
                self._bump(db, subject)
                row = self._row(db, subject, kind, identifier)
            item = self._view(db, subject, principal, row)
            result = {"item": item, "context_revision": self._context_revision(db, subject), "replayed": bool(operation),
                      "identity_revision": identity["binding_revision"],
                      "operation_revision": operation["revision"] if operation else expected + 1}
            self._recheck(identity)
        self._recheck(identity)
        return result

    def save_profile(self, principal, body):
        return self._mutate(principal, "profile", body)

    def save_preferences(self, principal, body):
        return self._mutate(principal, "preferences", body)

    def save_memory(self, principal, body):
        return self._mutate(principal, "memory", body)

    def delete_memory(self, principal, body):
        return self._mutate(principal, "memory", body, delete=True)

    def invalidate_sources(self, session_id):
        """Server-only source change/expiry hook; it never consumes read grants.

        The existing meeting TTL cleaner calls this even when the user never
        opens their personal settings. Only that meeting's derived entries are
        purged. A second phone merely lacking a grant must not call this hook.
        """
        _identifier(session_id, "来源会议")
        count = 0
        with self._transaction() as db:
            rows = db.execute("SELECT * FROM entries WHERE kind='memory' AND deleted=0 AND invalidated=0").fetchall()
            for row in rows:
                source = json.loads(row["source"])
                if source.get("kind") != "meeting" or source.get("session_id") != session_id:
                    continue
                db.execute("UPDATE entries SET revision=revision+1,invalidated=1,value='{}',source='{}',updated_at=? WHERE subject=? AND kind=? AND id=?",
                           (self._now(), row["subject"], row["kind"], row["id"]))
                self._bump(db, row["subject"])
                count += 1
        return count

    @staticmethod
    def _ref(item):
        return {"kind": item["kind"], "id": item["id"], "revision": item["revision"],
                "source_fingerprint": _hash(item["source"])}

    @staticmethod
    def _content(items, scenario="通用", person_id=None):
        profile = next((item for item in items if item["kind"] == "profile"), None)
        preferences = next((item for item in items if item["kind"] == "preferences"), None)
        return {"profile": profile["value"] if profile and PersonalContext._scenario_matches(profile["value"], scenario) else None,
                "preferences": preferences["value"] if preferences and PersonalContext._scenario_matches(preferences["value"], scenario) else None,
                "memories": [{"id": item["id"], **item["value"]} for item in items
                             if item["kind"] == "memory" and PersonalContext._scenario_matches(item["value"], scenario)
                             and PersonalContext._person_matches(item['value'], person_id)]}

    @staticmethod
    def _scenario_matches(value, scenario):
        scopes = value.get("scenarios", ["通用"])
        return "通用" in scopes or scenario in scopes

    @staticmethod
    def _person_matches(value, person_id):
        return value.get('category') != 'person' or person_id is not None and value.get('person_id') == person_id

    def _snapshot_value(self, identity, items, context_revision, excluded, scenario="通用", person_id=None):
        profile = next((item for item in items if item["kind"] == "profile"), None)
        preferences = next((item for item in items if item["kind"] == "preferences"), None)
        enabled = bool(preferences and preferences["value"]["enabled"])
        if not enabled:
            items, profile, preferences = [], None, None
        content = self._content(items, scenario, person_id)
        refs = [self._ref(item) for item in items]
        result = {"version": 1, "enabled": enabled, "identity_revision": identity["binding_revision"],
                  "context_revision": context_revision, "entry_refs": refs, "context": content, "excluded": excluded,
                  "scenario": scenario, 'person_id': person_id}
        # Hash only the selected evidence, not unrelated personal records.
        result["snapshot_id"] = _hash({"subject": self._subject(identity), "identity_revision": result["identity_revision"],
                                       "enabled": enabled, "scenario": scenario, 'person_id': person_id,
                                       "entry_refs": refs, "context": content})
        return result

    def snapshot(self, principal, memory_ids=None, scenario="通用", person_id=None):
        if scenario not in self.SCENARIOS:
            _fail(400, "PERSONAL_CONTEXT_INVALID", "个人上下文场景无效")
        if person_id is not None:
            person_id = _identifier(person_id, '所选人物编号')
        if memory_ids is not None:
            if not isinstance(memory_ids, list) or len(memory_ids) > self.MAX_SNAPSHOT_MEMORIES:
                _fail(400, "PERSONAL_CONTEXT_INVALID", "一次最多选择 20 条私人记忆")
            memory_ids = sorted(set(_identifier(value, "记忆编号") for value in memory_ids))
        identity = self._identity(principal)
        subject = self._subject(identity)
        failure = None
        with self._transaction(identity) as db:
            rows = db.execute("SELECT * FROM entries WHERE subject=? ORDER BY CASE kind WHEN 'preferences' THEN 0 WHEN 'profile' THEN 1 ELSE 2 END,id", (subject,)).fetchall()
            selected, excluded, memory_count = [], [], 0
            found = set()
            for row in rows:
                if row["kind"] == "memory" and memory_ids is not None and row["id"] not in memory_ids:
                    continue
                if row["kind"] == "memory":
                    found.add(row["id"])
                item = self._view(db, subject, principal, row)
                if item["status"] != "current":
                    if item["kind"] == "memory" and memory_ids is not None:
                        failure = (409, "PERSONAL_CONTEXT_SOURCE_CHANGED", "所选私人记忆已变化或不可用，请重新核对")
                    excluded.append({"kind": item["kind"], "id": item["id"], "status": item["status"]})
                    continue
                if item['kind'] == 'memory' and not self._person_matches(item['value'], person_id):
                    status = 'person_selection_required' if person_id is None else 'person_mismatch'
                    if person_id is not None and memory_ids is not None:
                        failure = (409, 'PERSONAL_CONTEXT_PERSON_MISMATCH', '所选记忆属于另一位人物，请重新选择')
                    excluded.append({'kind': 'memory', 'id': item['id'], 'status': status})
                    continue
                if item["kind"] != "preferences" and not self._scenario_matches(item["value"], scenario):
                    if item["kind"] == "memory" and memory_ids is not None:
                        failure = (409, "PERSONAL_CONTEXT_SCENARIO_MISMATCH", "所选私人记忆不适用于本次场景")
                    excluded.append({"kind": item["kind"], "id": item["id"], "status": "scenario"})
                    continue
                if item["kind"] == "memory" and memory_count >= self.MAX_SNAPSHOT_MEMORIES:
                    excluded.append({"kind": "memory", "id": item["id"], "status": "limit"})
                    continue
                proposed = selected + [item]
                size = len(_json(self._content(proposed, scenario, person_id)))
                if size > self.MAX_SNAPSHOT_CHARS:
                    if memory_ids is not None:
                        failure = (400, "PERSONAL_CONTEXT_LIMIT", "所选上下文过长，请减少私人记忆")
                    excluded.append({"kind": item["kind"], "id": item["id"], "status": "limit"})
                    continue
                selected.append(item)
                memory_count += item["kind"] == "memory"
            if memory_ids is not None and found != set(memory_ids):
                failure = (404, "PERSONAL_CONTEXT_NOT_FOUND", "所选私人记忆不存在或不属于本人")
            result = self._snapshot_value(identity, selected, self._context_revision(db, subject), excluded, scenario, person_id)
            self._recheck(identity)
        self._recheck(identity)
        if failure:
            _fail(*failure)
        return result

    def validate_snapshot(self, principal, snapshot):
        if not isinstance(snapshot, dict) or snapshot.get("version") != 1 or not isinstance(snapshot.get("entry_refs"), list):
            _fail(400, "PERSONAL_CONTEXT_INVALID", "个人上下文快照无效")
        refs = snapshot["entry_refs"]
        scenario = snapshot.get("scenario")
        person_id = snapshot.get('person_id')
        if scenario not in self.SCENARIOS:
            _fail(400, "PERSONAL_CONTEXT_INVALID", "个人上下文场景无效")
        if person_id is not None:
            person_id = _identifier(person_id, '所选人物编号')
        if (len(refs) > self.MAX_SNAPSHOT_MEMORIES + 2 or
                sum(isinstance(ref, dict) and ref.get('kind') == 'memory' for ref in refs) > self.MAX_SNAPSHOT_MEMORIES):
            _fail(400, "PERSONAL_CONTEXT_INVALID", "个人上下文快照过长")
        identity = self._identity(principal)
        subject = self._subject(identity)
        changed = False
        with self._transaction(identity) as db:
            items, seen = [], set()
            for ref in refs:
                if not isinstance(ref, dict) or set(ref) != {"kind", "id", "revision", "source_fingerprint"}:
                    _fail(400, "PERSONAL_CONTEXT_INVALID", "个人上下文引用无效")
                kind, identifier = ref["kind"], _identifier(ref["id"], "引用编号")
                if not isinstance(kind, str) or kind not in {"profile", "preferences", "memory"} or kind != "memory" and identifier != "current" or (kind, identifier) in seen:
                    _fail(400, "PERSONAL_CONTEXT_INVALID", "个人上下文引用无效")
                seen.add((kind, identifier))
                row = self._row(db, subject, kind, identifier)
                if not row:
                    changed = True
                    continue
                item = self._view(db, subject, principal, row)
                if item["status"] != "current" or self._ref(item) != ref:
                    changed = True
                    continue
                if kind != "preferences" and not self._scenario_matches(item["value"], scenario):
                    changed = True
                if kind == 'memory' and not self._person_matches(item['value'], person_id):
                    changed = True
                items.append(item)
            preferences = self._row(db, subject, "preferences", "current")
            enabled = bool(preferences and not preferences["deleted"] and json.loads(preferences["value"]).get("enabled"))
            if enabled != snapshot.get("enabled") or identity["binding_revision"] != snapshot.get("identity_revision"):
                changed = True
            result = self._snapshot_value(identity, items, self._context_revision(db, subject), [], scenario, person_id)
            if result["snapshot_id"] != snapshot.get("snapshot_id") or len(_json(result['context'])) > self.MAX_SNAPSHOT_CHARS:
                changed = True
            self._recheck(identity)
        self._recheck(identity)
        if changed:
            _fail(409, "PERSONAL_CONTEXT_SNAPSHOT_CHANGED", "个人上下文快照不属于当前账号或已变化，请重新核对任务")
        return result
