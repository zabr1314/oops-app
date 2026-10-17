"""Server-owned collaboration tasks and checked references to Oops business tasks.

Manual collaboration tasks are real persisted records, not Feishu tasks. Source
references resolve only through the trusted backend's existing operation and
meeting stores. This module never invokes a model, sends a message, creates a
Feishu task, or marks business work complete. Source proofs and meeting text are
not copied into this database or the Raft message.
"""

import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import uuid

from raft_outbox import OutboxError
from raft_source_access import SourceAccess, reference as personal_reference, locator as source_locator, source_version, CANDIDATE_DOMAIN


TASK_ID = re.compile(r"raft-task:[a-f0-9]{32}")
REQUEST_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
SOURCE_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")


def task_id(value):
    if not isinstance(value, str) or not TASK_ID.fullmatch(value):
        raise OutboxError(400, "BAD_REQUEST", "协作任务编号无效")
    return value


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _fields(body, allowed):
    if not isinstance(body, dict):
        raise OutboxError(400, "BAD_REQUEST", "请求必须为 JSON 对象")
    if set(body) - set(allowed):
        raise OutboxError(400, "UNSUPPORTED_FIELDS", "仅接受明确填写的任务与真实对象引用，不接受会议正文、材料或凭据")


def _text(value, field, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise OutboxError(400, "BAD_REQUEST", f"{field} 为空、格式无效或过长")
    return value.strip()


def _request(value):
    value = _text(value, "request_id", 128)
    if not REQUEST_ID.fullmatch(value):
        raise OutboxError(400, "BAD_REQUEST", "request_id 格式无效")
    return value


def _source_id(value, field):
    value = _text(value, field, 100)
    if not SOURCE_ID.fullmatch(value):
        raise OutboxError(400, "BAD_REQUEST", f"{field} 格式无效")
    return value


def _reference(value):
    if not isinstance(value, dict):
        raise OutboxError(400, "TASK_SOURCE_REQUIRED", "已选择来源时须携带真实任务引用，不能降为手工任务")
    if value.get("kind") == "feishu_operation":
        _fields(value, ("kind", "op_id"))
        return dict(kind="feishu_operation", op_id=_source_id(value.get("op_id"), "op_id"))
    if value.get("kind") == "meeting_item":
        _fields(value, ("kind", "session_id", "item_id", "fingerprint"))
        fingerprint = _text(value.get("fingerprint"), "fingerprint", 64)
        if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
            raise OutboxError(400, "BAD_REQUEST", "事项 fingerprint 必须来自当前真实回包")
        return dict(kind="meeting_item", session_id=_source_id(value.get("session_id"), "session_id"),
                    item_id=_source_id(value.get("item_id"), "item_id"), fingerprint=fingerprint)
    if value.get("kind") == "label_review":
        return personal_reference(value)
    raise OutboxError(400, "TASK_SOURCE_UNSUPPORTED", "该任务引用尚未接入可信来源核对")


class RaftTaskBindings:
    def __init__(self, directory, backend=None):
        self.backend = backend
        self.sources = SourceAccess(backend)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        self.path = os.path.join(os.path.abspath(directory), "collaboration-tasks.sqlite3")
        with self._transaction() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
                    payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
                    kind TEXT NOT NULL, source_ref_json TEXT, source_hash TEXT,
                    source_status TEXT NOT NULL, permitted INTEGER NOT NULL,
                    state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS handoffs (
                    handoff_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
                    outbox_id TEXT, linked_at TEXT NOT NULL,
                    FOREIGN KEY(task_id) REFERENCES tasks(id)
                );
                CREATE TABLE IF NOT EXISTS reply_reviews (
                    review_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL,
                    recorded_at TEXT NOT NULL,
                    FOREIGN KEY(task_id) REFERENCES tasks(id)
                );
                CREATE INDEX IF NOT EXISTS handoffs_task ON handoffs(task_id);
                CREATE INDEX IF NOT EXISTS reply_reviews_task ON reply_reviews(task_id);
            """)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(tasks)")}
            if "source_receipt_json" not in columns:
                db.execute("ALTER TABLE tasks ADD COLUMN source_receipt_json TEXT")
            if "source_version_key" not in columns:
                db.execute("ALTER TABLE tasks ADD COLUMN source_version_key TEXT")
                for task in db.execute("SELECT id,source_receipt_json FROM tasks WHERE source_receipt_json IS NOT NULL").fetchall():
                    receipt = json.loads(task["source_receipt_json"])
                    db.execute("UPDATE tasks SET source_version_key=? WHERE id=?", (source_version(receipt), task["id"]))
            # Preserve any historical duplicates while serializing new creates
            # under BEGIN IMMEDIATE. Never delete an old delivery record.
            db.execute("CREATE INDEX IF NOT EXISTS tasks_source_version ON tasks(source_version_key)")
        os.chmod(self.path, 0o600)

    @contextlib.contextmanager
    def _transaction(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA busy_timeout=10000")
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @contextlib.contextmanager
    def _reading(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA busy_timeout=10000")
            db.execute("BEGIN")
            yield db
        finally:
            db.close()

    @staticmethod
    def _row(db, stable_id):
        row = db.execute("SELECT * FROM tasks WHERE id=?", (stable_id,)).fetchone()
        if row is None:
            raise OutboxError(404, "TASK_NOT_FOUND", "没有这条服务端协作任务")
        return row

    def _source(self, reference):
        backend = self.backend
        if backend is None:
            raise OutboxError(503, "TASK_SOURCE_SERVICE_UNAVAILABLE", "当前服务未接入真实业务任务库，不能核对来源")
        try:
            if reference["kind"] == "feishu_operation":
                # The original operation retains its signed evidence and GUID.
                # Do not reconstruct a proof from an App-provided text/hash.
                with backend.ops.lock:
                    operation = backend.ops.load(reference["op_id"])
                guid = (operation or {}).get("feishu_task", {}).get("guid")
                if (not operation or operation.get("status") != "created" or operation.get("archived_at")
                        or not isinstance(guid, str) or not guid or guid.startswith("dry-run-")):
                    raise OutboxError(409, "TASK_SOURCE_UNAVAILABLE", "来源不是当前可用的真实任务创建回执")
                request = operation.get("request")
                if not isinstance(request, dict):
                    raise OutboxError(409, "TASK_SOURCE_UNAVAILABLE", "原任务缺少可信创建请求")
                checked = backend.action_source(request, operation.get("source_snapshot"))
                if checked.get("status") not in ("current", "retained", "manual"):
                    raise OutboxError(409, "TASK_SOURCE_UNAVAILABLE", "原任务来源当前不可用于协作")
                shape = dict(kind="feishu_operation", op_id=reference["op_id"], guid=guid,
                             request_hash=_hash(request), source_hash=checked.get("fingerprint"))
                return _hash(shape), checked["status"]
            if reference["kind"] == "meeting_item":
                import minutes_items
                from action_sources import binding_for, last_raw_revision
                if not callable(getattr(backend, "item_action_binding", None)):
                    raise OutboxError(503, "TASK_SOURCE_CONTRACT_UNAVAILABLE", "当前后端没有已核对事项的真实来源合同，不能使用旧结构代替")
                with backend.meetings.lock:
                    if backend.meeting_deleted(reference["session_id"]):
                        raise OutboxError(409, "TASK_SOURCE_UNAVAILABLE", "会议来源已删除")
                    row = backend.meetings.load(reference["session_id"])
                    item = next((entry for entry in minutes_items.confirmed(row, "task") if entry["id"] == reference["item_id"]), None)
                    if item is None or item["fingerprint"] != reference["fingerprint"]:
                        raise OutboxError(409, "TASK_SOURCE_CHANGED", "原会后事项已变化、未确认或不可用")
                    if not item.get("owner"):
                        raise OutboxError(409, "TASK_SOURCE_UNAVAILABLE", "原事项尚未人工确认负责人")
                    ids = item.get("ids") or [line["id"] for line in item.get("evidence", [])]
                    item_binding = backend.item_action_binding(row, item)
                    expected = ("item_id", "item_fingerprint", "item_review_fingerprint", "item_owner", "item_title", "item_due")
                    if (not isinstance(item_binding, dict) or set(item_binding) != set(expected)
                            or item_binding.get("item_id") != reference["item_id"] or item_binding.get("item_fingerprint") != reference["fingerprint"]):
                        raise OutboxError(503, "TASK_SOURCE_CONTRACT_UNAVAILABLE", "真实事项来源合同未匹配，不能继续关联")
                    binding = backend.sign_action_binding(dict(binding_for(row, ids), **item_binding))
                    evidence = dict(source_binding=binding, utterance_ids=list(ids), quote=" ".join(source["quote"] for source in binding["sources"]))
                    # Reuse export withdrawal, HMAC and current source checks.
                    backend.validate_action_source(dict(session_id=reference["session_id"], evidence=evidence))
                    shape = dict(kind="meeting_item", session_id=reference["session_id"], item_id=item["id"],
                                 fingerprint=item["fingerprint"], item_binding=item_binding,
                                 source_revisions={uid: last_raw_revision(row, uid) for uid in ids})
                    return _hash(shape), item["source_status"]
        except OutboxError:
            raise
        except Exception:
            # Backend errors may contain provider details. Persist/report a
            # stable reason, never a raw exception or its credentials.
            raise OutboxError(409, "TASK_SOURCE_UNAVAILABLE", "来源读取或当前核对失败，已停止协作授权") from None
        raise OutboxError(400, "TASK_SOURCE_UNSUPPORTED", "该来源类型尚未接入")

    def create(self, body, personal=""):
        _fields(body, ("request_id", "title", "text", "confirm", "task_ref", "source_contract", "source_confirm"))
        if body.get("confirm") is not True:
            raise OutboxError(400, "CONFIRM_REQUIRED", "请明确确认登记本次协作任务")
        payload = dict(request_id=_request(body.get("request_id")), title=_text(body.get("title"), "title", 200),
                       text=_text(body.get("text"), "text", 12000))
        reference = _reference(body["task_ref"]) if "task_ref" in body else None
        if reference is not None:
            payload["task_ref"] = reference
            payload["source_confirm"] = body.get("source_confirm") is True
        elif "source_contract" in body or "source_confirm" in body:
            raise OutboxError(400, "TASK_SOURCE_REQUIRED", "来源核对字段不能降为手工任务")
        encoded, fingerprint = _json(payload), _hash(payload)
        with self._reading() as db:
            row = db.execute("SELECT * FROM tasks WHERE request_id=?", (payload["request_id"],)).fetchone()
        if row is not None:
            if row["payload_hash"] != fingerprint:
                raise OutboxError(409, "REQUEST_ID_CONFLICT", "同一任务登记请求已绑定另一正文或来源")
            self._check_reader(row, personal)
            return self.get(row["id"])
        guard = (self.sources.prepare(reference, body.get("source_contract"), personal, body.get("source_confirm"))
                 if reference is not None else contextlib.nullcontext(None))
        # Source/network work happens before taking the task write lock. The
        # prepare guard remains authoritative through this short insert.
        with guard as receipt:
            with self._transaction() as db:
                row = db.execute("SELECT * FROM tasks WHERE request_id=?", (payload["request_id"],)).fetchone()
                if row is not None:
                    if row["payload_hash"] != fingerprint:
                        raise OutboxError(409, "REQUEST_ID_CONFLICT", "同一任务登记请求已绑定另一正文或来源")
                    self._check_reader(row, personal)
                    stable_id = row["id"]
                else:
                    source_hash, source_status = (receipt["snapshot_hash"], receipt["source_status"]) if receipt else (None, "manual")
                    version_key = source_version(receipt) if receipt else None
                    if version_key is not None and db.execute("SELECT id FROM tasks WHERE source_version_key=? LIMIT 1", (version_key,)).fetchone():
                        raise OutboxError(409, "SOURCE_TASK_EXISTS", "本人的这条来源版本已有协作任务，请读取原任务与线程；补充内容在原线程明确续发")
                    stable_id, now = "raft-task:" + uuid.uuid4().hex, _now()
                    db.execute("INSERT INTO tasks(id,request_id,payload_hash,payload_json,kind,source_ref_json,source_hash,source_status,permitted,state,created_at,updated_at,source_receipt_json,source_version_key) VALUES(?,?,?,?,?,?,?,?,1,'open',?,?,?,?)",
                               (stable_id, payload["request_id"], fingerprint, encoded,
                                "candidate_collaboration" if receipt and receipt.get("domain") == CANDIDATE_DOMAIN else "source_collaboration" if reference else "manual_collaboration",
                                _json(reference) if reference else None, source_hash, source_status, now, now,
                                _json(receipt) if receipt else None, version_key))
        return self.get(stable_id)

    def _checked(self, stable_id, checker):
        stable_id = task_id(stable_id)
        error = None
        with self._reading() as db:
            row = self._row(db, stable_id)
        if not row["permitted"]:
            raise OutboxError(409, row["error"] or "TASK_AUTH_WITHDRAWN", "任务派工授权已撤回，请重新核对")
        receipt_json, status = row["source_receipt_json"], row["source_status"]
        if row["source_ref_json"] is not None:
            try:
                if not receipt_json:
                    raise OutboxError(409, "TASK_PERSONAL_CONFIRM_REQUIRED", "旧来源任务缺少本人本次派工核对")
                status = checker(json.loads(receipt_json))
            except OutboxError as failure:
                error = failure
        # Never hold this database's writer lock while checking an account or
        # waiting for a source HTTP response. CAS also prevents an old success
        # from restoring permission withdrawn by another request.
        with self._transaction() as db:
            latest = self._row(db, stable_id)
            if not latest["permitted"]:
                raise OutboxError(409, latest["error"] or "TASK_AUTH_WITHDRAWN", "任务派工授权已撤回，请重新核对")
            if latest["source_receipt_json"] != receipt_json:
                raise OutboxError(409, "TASK_SOURCE_CHANGED", "任务来源授权版本已变化，请重新读取")
            if row["source_ref_json"] is not None:
                args = (stable_id, receipt_json)
                if error is not None and error.http_status >= 500:
                    db.execute("UPDATE tasks SET source_status='temporarily_unavailable',error=?,updated_at=? WHERE id=? AND source_receipt_json IS ? AND permitted=1", (error.code, _now(), *args))
                elif error is not None:
                    db.execute("UPDATE tasks SET permitted=0,state='source_invalidated',source_status='unavailable',error=?,updated_at=? WHERE id=? AND source_receipt_json IS ? AND permitted=1", (error.code, _now(), *args))
                else:
                    db.execute("UPDATE tasks SET source_status=?,error=NULL WHERE id=? AND source_receipt_json IS ? AND permitted=1", (status, *args))
        # Commit withdrawal before raising, so a later read cannot revive it.
        if error is not None:
            raise error
        return True

    def validate(self, stable_id):
        return self._checked(stable_id, self.sources.validate)

    @staticmethod
    def _public(db, row):
        payload = json.loads(row["payload_json"])
        readable = bool(row["permitted"] and row["source_status"] not in ("temporarily_unavailable", "unavailable"))
        receipt = json.loads(row["source_receipt_json"]) if row["source_receipt_json"] else None
        value = dict(id=row["id"], request_id=row["request_id"], kind=row["kind"], status=row["state"],
                     title=payload["title"] if readable else None, text=payload["text"] if readable else None,
                     version=1, permitted=bool(row["permitted"]), source_status=row["source_status"], source_error=row["error"],
                     task_ref=json.loads(row["source_ref_json"]) if row["source_ref_json"] else None,
                     created_at=row["created_at"], updated_at=row["updated_at"], feishu_task_created=False, business_complete=False)
        value["body_unavailable"] = not readable
        candidate = bool(receipt and receipt.get("domain") == CANDIDATE_DOMAIN)
        value["source_confirmed_at"] = receipt.get("confirmed_at") if receipt and not candidate else None
        value["dispatch_confirmed_at"] = receipt.get("confirmed_at") if receipt else None
        value["source_version"] = row["source_version_key"]
        value["source_policy"] = "candidate_dispatch" if candidate else "confirmed_source" if receipt else "manual"
        value["review_status"] = "unreviewed" if candidate else "confirmed" if receipt else "manual"
        value["source_mode"] = "delegate" if candidate else "confirmed" if receipt else "manual"
        value["handoffs"] = [dict(link) for link in db.execute("SELECT handoff_id,outbox_id,linked_at FROM handoffs WHERE task_id=? ORDER BY linked_at", (row["id"],))]
        value["reply_reviews"] = ([dict(json.loads(review["payload_json"]), recorded_at=review["recorded_at"]) for review in db.execute(
            "SELECT * FROM reply_reviews WHERE task_id=? ORDER BY recorded_at", (row["id"],))] if readable else [])
        return value

    def get(self, stable_id, read_context=None):
        stable_id = task_id(stable_id)
        if read_context is not None and read_context.access is not self.sources:
            raise OutboxError(403, "TASK_SOURCE_FORBIDDEN", "任务读取上下文不匹配")
        failure = None
        try:
            self._checked(stable_id, read_context.validate if read_context is not None else self.sources.validate)
        except OutboxError as error:
            if error.http_status == 404:
                raise
            failure = error
        with self._reading() as db:
            value = self._public(db, self._row(db, stable_id))
        if failure is not None:
            value.update(title=None, text=None, body_unavailable=True, reply_reviews=[], source_error=failure.code,
                         source_status="temporarily_unavailable" if failure.http_status >= 500 else "unavailable")
        return value

    def _check_reader(self, row, personal):
        if row["source_ref_json"] is None:
            return True
        receipt = json.loads(row["source_receipt_json"]) if row["source_receipt_json"] else {}
        if not self.sources.same_reader(receipt, personal):
            raise OutboxError(403, "TASK_SOURCE_FORBIDDEN", "这条来源派工不属于当前手机身份")
        return True

    def require_reader(self, stable_id, personal):
        with self._reading() as db:
            return self._check_reader(self._row(db, task_id(stable_id)), personal)

    def can_read(self, stable_id, personal):
        try:
            return self.require_reader(stable_id, personal)
        except OutboxError:
            return False

    def read_task(self, stable_id, personal, read_context=None):
        self.require_reader(stable_id, personal)
        return self.get(stable_id, read_context=read_context)

    def find_request(self, request_id, personal=None, external=False, read_context=None):
        request_id = _request(request_id)
        with self._reading() as db:
            row = db.execute("SELECT id FROM tasks WHERE request_id=?", (request_id,)).fetchone()
        if row and external and not self.can_read(row["id"], personal):
            row = None
        return {"items": [self.get(row["id"], read_context=read_context)] if row else []}

    def list(self, limit=30, personal=None, external=False, read_context=None):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise OutboxError(400, "BAD_REQUEST", "limit 应为1至100")
        with self._reading() as db:
            ids = [row["id"] for row in db.execute("SELECT id FROM tasks ORDER BY created_at DESC,id DESC LIMIT ?", (limit,))]
        return {"items": [self.get(stable_id, read_context=read_context) for stable_id in ids if not external or self.can_read(stable_id, personal)]}

    def find_source(self, supplied, personal, read_context=None):
        ref = personal_reference(supplied)
        self.sources.history_principal(personal)
        with self._reading() as db:
            rows = db.execute("SELECT * FROM tasks WHERE source_ref_json IS NOT NULL ORDER BY created_at DESC,id DESC").fetchall()
            ids = [row["id"] for row in rows if source_locator(json.loads(row["source_ref_json"])) == source_locator(ref)
                   and self.sources.same_reader(json.loads(row["source_receipt_json"]) if row["source_receipt_json"] else {}, personal)]
        return {"items": [self.get(stable_id, read_context=read_context) for stable_id in ids[:100]]}

    @staticmethod
    def _family(db, ref, binding):
        """All versions of the same source owned by the same phone/account."""
        account_fields = ("principal_id", "account_open_id", "tenant_key")
        ids = []
        for row in db.execute("SELECT id,source_ref_json,source_receipt_json FROM tasks WHERE source_receipt_json IS NOT NULL"):
            receipt = json.loads(row["source_receipt_json"])
            actor = receipt.get("actor_binding") or {}
            if (source_locator(json.loads(row["source_ref_json"])) == source_locator(ref)
                    and all(actor.get(key) == binding.get(key) for key in account_fields)):
                ids.append(row["id"])
        return ids

    def source_family(self, stable_id):
        with self._reading() as db:
            row = self._row(db, task_id(stable_id))
            if row["source_ref_json"] is None or not row["source_receipt_json"]:
                return []
            receipt = json.loads(row["source_receipt_json"])
            return self._family(db, json.loads(row["source_ref_json"]), receipt["actor_binding"])

    def dispatch_family(self, supplied, personal):
        ref, binding = personal_reference(supplied), self.sources.identity(personal)
        with self._reading() as db:
            return self._family(db, ref, binding)

    def link_handoff(self, stable_id, handoff_id, outbox_id):
        """Internal delivery mapping only; never grants task permission."""
        stable_id = task_id(stable_id)
        if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value) for value in (handoff_id, outbox_id)):
            raise OutboxError(400, "BAD_REQUEST", "交接与发送编号无效")
        with self._transaction() as db:
            self._row(db, stable_id)
            existing = db.execute("SELECT * FROM handoffs WHERE handoff_id=?", (handoff_id,)).fetchone()
            if existing and (existing["task_id"] != stable_id or existing["outbox_id"] != outbox_id):
                raise OutboxError(409, "TASK_HANDOFF_CONFLICT", "此交接已绑定另一任务或发送")
            if existing is None:
                db.execute("INSERT INTO handoffs(handoff_id,task_id,outbox_id,linked_at) VALUES(?,?,?,?)", (handoff_id, stable_id, outbox_id, _now()))
        return None

    def bind_handoff(self, stable_id, handoff_id, outbox_id):
        self.link_handoff(stable_id, handoff_id, outbox_id)
        return self.get(stable_id)

    def record_review(self, stable_id, annotation):
        """Internal: annotation must be the Collaboration's saved reply review."""
        stable_id = task_id(stable_id)
        self.validate(stable_id)
        if not isinstance(annotation, dict) or annotation.get("kind") not in ("progress", "artifact"):
            raise OutboxError(400, "BAD_REQUEST", "仅记录人工核对的进展或成果注记")
        review_id = annotation.get("id")
        if not isinstance(review_id, str) or not re.fullmatch(r"[a-f0-9]{32}", review_id):
            raise OutboxError(400, "BAD_REQUEST", "缺少真实回复核对编号")
        payload = {key: annotation[key] for key in ("id", "request_id", "handoff_id", "reply_id", "kind", "note", "reply_hash", "confirmed_at") if key in annotation}
        if not all(isinstance(payload.get(key), str) and payload[key] for key in ("request_id", "handoff_id", "reply_id", "reply_hash", "confirmed_at")):
            raise OutboxError(400, "BAD_REQUEST", "回复核对来源缺失")
        fingerprint = _hash(payload)
        with self._transaction() as db:
            link = db.execute("SELECT task_id FROM handoffs WHERE handoff_id=?", (payload["handoff_id"],)).fetchone()
            if link is None or link["task_id"] != stable_id:
                raise OutboxError(409, "TASK_HANDOFF_REQUIRED", "回复核对没有绑定这条任务的真实交接")
            prior = db.execute("SELECT * FROM reply_reviews WHERE review_id=?", (review_id,)).fetchone()
            if prior and (prior["task_id"] != stable_id or prior["payload_hash"] != fingerprint):
                raise OutboxError(409, "TASK_REVIEW_CONFLICT", "同一核对编号已绑定另一任务结果")
            if prior is None:
                db.execute("INSERT INTO reply_reviews(review_id,task_id,payload_json,payload_hash,recorded_at) VALUES(?,?,?,?,?)",
                           (review_id, stable_id, _json(payload), fingerprint, _now()))
        return self.get(stable_id)

    def revoke(self, stable_id):
        stable_id = task_id(stable_id)
        with self._transaction() as db:
            self._row(db, stable_id)
            db.execute("UPDATE tasks SET permitted=0,state='authorization_withdrawn',error='TASK_AUTH_WITHDRAWN',updated_at=? WHERE id=?", (_now(), stable_id))
        return self.get(stable_id)
