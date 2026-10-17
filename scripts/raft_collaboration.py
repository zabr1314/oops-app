"""Private Raft group snapshots and explicit-text task handoff mappings.

The configured server/channel IDs identify one group. Names never select or
replace it. A prototype task reference is a return link only, not backend
evidence, and is never included in the text sent to Raft. Delivery and human
reply annotations remain separate from any Oops task's business state.
"""

import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import time
import uuid

from raft_outbox import OutboxError
from raft_task_binding import task_id as checked_task_id


CANDIDATE_PREFIX = "未人工确认的会议候选事项。请先在本线程澄清范围、负责人和时间，明确后执行；进展与成果回复本线程。此派工不修改原事项核对或业务完成状态。"


GROUP_FRESH_SECONDS = 90
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", re.I)
REQUEST = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
HANDLE = re.compile(r"@[^\s@:]{1,100}")


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _fields(value, allowed):
    if not isinstance(value, dict):
        raise OutboxError(400, "BAD_REQUEST", "请求必须是 JSON 对象")
    if set(value) - set(allowed):
        raise OutboxError(400, "UNSUPPORTED_FIELDS", "协作仅接收本次明确填写的文本，不接收来源、会议、资料或凭据字段")


def _text(value, field, limit, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise OutboxError(400, "BAD_REQUEST", f"{field} 为空、格式无效或过长")
    return value.strip()


def _uuid(value, field):
    value = _text(value, field, 36)
    if not UUID.fullmatch(value):
        raise OutboxError(400, "BAD_REQUEST", f"{field} 必须是实际稳定 ID")
    return value.lower()


def _request(value):
    value = _text(value, "request_id", 128)
    if not REQUEST.fullmatch(value):
        raise OutboxError(400, "BAD_REQUEST", "request_id 格式无效")
    return value


def _handoff_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        raise OutboxError(400, "BAD_REQUEST", "协作编号无效")
    return value


class Collaboration:
    """One trusted group binding with a durable, recoverable outbox mapping.

    `directory` is normally state-dir/raft. `outbox_target` is a configured
    stable transport token, never a channel name taken from an API response.
    """

    def __init__(self, directory, expected_server_id, expected_channel_id, outbox_target=None, task_bindings=None):
        self.server_id = _uuid(expected_server_id, "expected_server_id")
        self.channel_id = _uuid(expected_channel_id, "expected_channel_id")
        self.target = _text(outbox_target or "channel:" + self.channel_id, "outbox_target", 200)
        self.task_bindings = task_bindings
        os.makedirs(directory, mode=0o700, exist_ok=True)
        self.path = os.path.join(os.path.abspath(directory), "collaboration.sqlite3")
        with self._transaction() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS group_state (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    server_id TEXT NOT NULL, channel_id TEXT NOT NULL, target TEXT NOT NULL,
                    status TEXT NOT NULL, version INTEGER NOT NULL,
                    snapshot_hash TEXT, snapshot_json TEXT, read_at TEXT,
                    read_epoch REAL, error TEXT
                );
                CREATE TABLE IF NOT EXISTS group_history (
                    version INTEGER PRIMARY KEY, status TEXT NOT NULL,
                    snapshot_hash TEXT, snapshot_json TEXT, at TEXT NOT NULL, error TEXT
                );
                CREATE TABLE IF NOT EXISTS handoffs (
                    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
                    payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
                    wire_json TEXT NOT NULL, group_snapshot_json TEXT NOT NULL,
                    outbox_request_id TEXT NOT NULL UNIQUE, outbox_id TEXT UNIQUE,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    last_error TEXT
                );
                CREATE TABLE IF NOT EXISTS reviews (
                    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
                    handoff_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
                    payload_json TEXT NOT NULL, reply_hash TEXT NOT NULL,
                    confirmed_at TEXT NOT NULL,
                    FOREIGN KEY(handoff_id) REFERENCES handoffs(id)
                );
                CREATE TABLE IF NOT EXISTS communications (
                    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
                    handoff_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
                    payload_json TEXT NOT NULL, wire_json TEXT NOT NULL,
                    outbox_request_id TEXT NOT NULL UNIQUE, outbox_id TEXT UNIQUE,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    last_error TEXT,
                    FOREIGN KEY(handoff_id) REFERENCES handoffs(id)
                );
                CREATE TABLE IF NOT EXISTS task_roots (
                    task_id TEXT PRIMARY KEY, handoff_id TEXT NOT NULL UNIQUE,
                    FOREIGN KEY(handoff_id) REFERENCES handoffs(id)
                );
                CREATE INDEX IF NOT EXISTS handoffs_created ON handoffs(created_at);
                CREATE INDEX IF NOT EXISTS reviews_handoff ON reviews(handoff_id);
                CREATE INDEX IF NOT EXISTS communications_handoff ON communications(handoff_id);
            """)
            for handoff in db.execute("SELECT id,payload_json FROM handoffs ORDER BY created_at,id").fetchall():
                stable_id = json.loads(handoff["payload_json"]).get("task_id")
                if stable_id is not None:
                    checked_task_id(stable_id)
                    db.execute("INSERT OR IGNORE INTO task_roots(task_id,handoff_id) VALUES(?,?)", (stable_id, handoff["id"]))
            row = db.execute("SELECT * FROM group_state WHERE singleton=1").fetchone()
            if row is not None and (row["server_id"], row["channel_id"], row["target"]) != (self.server_id, self.channel_id, self.target):
                raise OutboxError(409, "GROUP_BINDING_CONFLICT", "已有协作历史绑定另一实际群组，不能迁到同名群")
            if row is None:
                db.execute("INSERT INTO group_state(singleton,server_id,channel_id,target,status,version) VALUES(1,?,?,?,'unavailable',0)",
                           (self.server_id, self.channel_id, self.target))
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

    @staticmethod
    def _state(db):
        return db.execute("SELECT * FROM group_state WHERE singleton=1").fetchone()

    @staticmethod
    def _unavailable(db, reason):
        row, now = Collaboration._state(db), _now()
        if row["status"] == "unavailable" and row["error"] == reason:
            return
        version = row["version"] + 1
        db.execute("UPDATE group_state SET status='unavailable',version=?,error=? WHERE singleton=1", (version, reason))
        db.execute("INSERT INTO group_history(version,status,snapshot_hash,snapshot_json,at,error) VALUES(?,'unavailable',?,?,?,?)",
                   (version, row["snapshot_hash"], row["snapshot_json"], now, reason))

    @staticmethod
    def _expire(db):
        row = Collaboration._state(db)
        if row["status"] == "available" and (row["read_epoch"] is None or time.time() - row["read_epoch"] > GROUP_FRESH_SECONDS):
            Collaboration._unavailable(db, "GROUP_READ_EXPIRED")

    def group_failed(self, reason="GROUP_READ_FAILED"):
        # Persist only an error code, never exception messages containing URLs,
        # headers or provider credentials.
        if not isinstance(reason, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", reason):
            reason = "GROUP_READ_FAILED"
        with self._transaction() as db:
            self._unavailable(db, reason)
        return self.overview()

    def _group_shape(self, body):
        _fields(body, ("id", "name", "server_id", "url", "visibility", "joined", "archived", "members", "bridge_agent_id"))
        channel_id, server_id = _uuid(body.get("id"), "id"), _uuid(body.get("server_id"), "server_id")
        if (server_id, channel_id) != (self.server_id, self.channel_id):
            raise OutboxError(409, "GROUP_IDENTITY_MISMATCH", "读取结果不属于已绑定的实际群组")
        if type(body.get("joined")) is not bool or type(body.get("archived")) is not bool:
            raise OutboxError(400, "BAD_REQUEST", "群组加入与归档状态缺失")
        members = body.get("members")
        if not isinstance(members, list) or len(members) > 100:
            raise OutboxError(400, "BAD_REQUEST", "群成员列表无效")
        clean, seen = [], set()
        for member in members:
            _fields(member, ("id", "handle", "name", "type"))
            stable_id = _uuid(member.get("id"), "member.id")
            if stable_id in seen:
                raise OutboxError(400, "BAD_REQUEST", "群成员 ID 重复")
            seen.add(stable_id)
            kind = _text(member.get("type"), "member.type", 30)
            if kind not in ("agent", "human", "user"):
                raise OutboxError(400, "BAD_REQUEST", "群成员类型无效")
            handle = _text(member.get("handle"), "member.handle", 101, optional=kind != "agent")
            if handle is not None and not HANDLE.fullmatch(handle):
                raise OutboxError(400, "BAD_REQUEST", "成员 handle 必须来自真实群成员")
            clean.append(dict(id=stable_id, handle=handle, name=_text(member.get("name"), "member.name", 200), type=kind))
        bridge_agent_id = _uuid(body.get("bridge_agent_id"), "bridge_agent_id")
        if not any(member["id"] == bridge_agent_id and member["type"] == "agent" for member in clean):
            raise OutboxError(409, "BRIDGE_GROUP_MEMBERSHIP_MISSING", "当前群成员没有已核对的 Oops 桥接身份")
        url = _text(body.get("url"), "url", 1000, optional=True)
        if url is not None:
            from urllib.parse import urlsplit
            parsed = urlsplit(url)
            if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise OutboxError(400, "BAD_REQUEST", "群组链接必须是不含凭据的 HTTPS 地址")
        return dict(id=channel_id, server_id=server_id, name=_text(body.get("name"), "name", 200), url=url,
                    visibility=_text(body.get("visibility"), "visibility", 30), joined=body["joined"], archived=body["archived"],
                    members=sorted(clean, key=lambda item: item["id"]), bridge_agent_id=bridge_agent_id)

    def update_group(self, body):
        try:
            group = self._group_shape(body)
        except OutboxError as error:
            self.group_failed(error.code)
            raise
        snapshot, encoded, now = _hash(group), _json(group), _now()
        available = group["joined"] and not group["archived"]
        with self._transaction() as db:
            self._expire(db)
            row = self._state(db)
            status = "available" if available else "unavailable"
            changed = row["snapshot_hash"] != snapshot or row["status"] != status
            version = row["version"] + (1 if changed else 0)
            error = None if available else "GROUP_NOT_JOINED" if not group["joined"] else "GROUP_ARCHIVED"
            db.execute("UPDATE group_state SET status=?,version=?,snapshot_hash=?,snapshot_json=?,read_at=?,read_epoch=?,error=? WHERE singleton=1",
                       (status, version, snapshot, encoded, now, time.time(), error))
            if changed:
                db.execute("INSERT INTO group_history(version,status,snapshot_hash,snapshot_json,at,error) VALUES(?,?,?,?,?,?)",
                           (version, status, snapshot, encoded, now, error))
        return self.overview()

    @staticmethod
    def _row(db, handoff_id):
        row = db.execute("SELECT * FROM handoffs WHERE id=?", (handoff_id,)).fetchone()
        if row is None:
            raise OutboxError(404, "NOT_FOUND", "没有这条协作交接")
        return row

    @staticmethod
    def _public(db, row):
        value = dict(json.loads(row["payload_json"]), id=row["id"], payload_hash=row["payload_hash"], outbox_id=row["outbox_id"],
                     outbox_request_id=row["outbox_request_id"], created_at=row["created_at"], updated_at=row["updated_at"],
                     group_snapshot=json.loads(row["group_snapshot_json"]), last_error=row["last_error"],
                     preview=json.loads(row["wire_json"])["text"], business_status_changed=False)
        value["reviews"] = [dict(json.loads(review["payload_json"]), id=review["id"], reply_hash=review["reply_hash"], confirmed_at=review["confirmed_at"])
                            for review in db.execute("SELECT * FROM reviews WHERE handoff_id=? ORDER BY confirmed_at", (row["id"],))]
        value["communications"] = [Collaboration._communication_public(item) for item in db.execute(
            "SELECT * FROM communications WHERE handoff_id=? ORDER BY created_at,id", (row["id"],))]
        return value

    @staticmethod
    def _communication_public(row):
        return dict(json.loads(row["payload_json"]), id=row["id"], outbox_id=row["outbox_id"], outbox_request_id=row["outbox_request_id"],
                    preview=json.loads(row["wire_json"])["text"], created_at=row["created_at"], updated_at=row["updated_at"], last_error=row["last_error"])

    @staticmethod
    def _transport(value, outbox):
        value.update(transport_status="preparing" if value["outbox_id"] is None else "unavailable", replies=[])
        if value["outbox_id"] is not None and outbox is not None:
            try:
                message = outbox.get(value["outbox_id"])
            except OutboxError as error:
                value.update(transport_status="unavailable", transport_error=error.code)
            else:
                value.update(transport_status=message["status"], raft_message_id=message.get("raft_message_id"),
                             receipt=message.get("response"), transport_error=message.get("error"), replies=message.get("replies", []),
                             attempt_history=message.get("attempt_history", []))
        value["status"] = value["transport_status"]
        if "communications" in value:
            value["communications"] = [Collaboration._transport(item, outbox) for item in value["communications"]]
            # Root thread replies are authoritative. A continuation is a send
            # within this thread, not another root to read or another task.
            value["replies"] = list({item["reply_id"]: item for item in value["replies"]}.values())
            value["outbox_ids"] = ([value["outbox_id"]] if value["outbox_id"] else []) + [item["outbox_id"] for item in value["communications"] if item["outbox_id"]]
        return value

    @staticmethod
    def _delivery_facts(value, outbox):
        result = {key: value[key] for key in ("id", "request_id", "outbox_id", "outbox_request_id", "task_id", "created_at", "updated_at") if key in value}
        result.update(status="preparing" if value.get("outbox_id") is None else "unavailable",
                      transport_status="preparing" if value.get("outbox_id") is None else "unavailable")
        if value.get("outbox_id") and outbox is not None:
            try:
                message = outbox.get(value["outbox_id"])
            except OutboxError:
                pass
            else:
                result.update(status=message["status"], transport_status=message["status"], raft_message_id=message.get("raft_message_id"))
        result["communications"] = [Collaboration._delivery_facts(item, outbox) for item in value.get("communications", [])]
        return result

    def overview(self, outbox=None, personal=None, read_context=None):
        with self._transaction() as db:
            self._expire(db)
            state = self._state(db)
            group = json.loads(state["snapshot_json"]) if state["status"] == "available" else None
            if group is not None:
                group.update(snapshot_hash=state["snapshot_hash"], version=state["version"], read_at=state["read_at"])
            items = ([self._public(db, row) for row in db.execute("SELECT * FROM handoffs ORDER BY created_at DESC,id DESC LIMIT 50")]
                     if state["status"] == "available" else [])
            result = dict(group=group, group_status=state["status"], group_version=state["version"], group_error=state["error"], items=items)
        result["items"] = [self._task_transport(item, outbox, read_context=read_context) for item in items if self._reader_allowed(item, personal)]
        return result

    def _reader_allowed(self, payload, personal):
        if personal is None or payload.get("task_id") is None:
            return True
        return self.task_bindings is not None and self.task_bindings.can_read(payload["task_id"], personal)

    def require_reader(self, handoff_id, personal):
        with self._transaction() as db:
            payload = json.loads(self._row(db, _handoff_id(handoff_id))["payload_json"])
        if not self._reader_allowed(payload, personal):
            raise OutboxError(403, "TASK_SOURCE_FORBIDDEN", "这条来源交接不属于当前手机身份")
        return True

    def get(self, handoff_id, outbox=None, personal=None, read_context=None):
        self.require_reader(handoff_id, personal)
        with self._transaction() as db:
            self._expire(db)
            row, state = self._row(db, _handoff_id(handoff_id)), self._state(db)
            readable = state["status"] == "available"
            if readable:
                value = self._public(db, row)
            else:
                # Preserve receipt identity while withdrawing old names,
                # handoff text, reply text and annotations from the API.
                value = dict(id=row["id"], request_id=row["request_id"], outbox_id=row["outbox_id"],
                             outbox_request_id=row["outbox_request_id"], created_at=row["created_at"], updated_at=row["updated_at"],
                             group_status="unavailable", body_unavailable=True, business_status_changed=False,
                             replies=[], reviews=[], communications=[self._communication_public(item) for item in db.execute(
                                 "SELECT * FROM communications WHERE handoff_id=? ORDER BY created_at,id", (row["id"],))])
                stable_task_id = json.loads(row["payload_json"]).get("task_id")
                if stable_task_id is not None:
                    value["task_id"] = stable_task_id
        if not readable:
            return dict(self._delivery_facts(value, outbox), group_status="unavailable", body_unavailable=True,
                        business_status_changed=False, replies=[], reviews=[])
        return self._task_transport(value, outbox, read_context=read_context)

    def _task_transport(self, value, outbox, read_context=None):
        stable_id = value.get("task_id")
        if stable_id is None:
            return self._transport(value, outbox)
        try:
            if self.task_bindings is None:
                raise OutboxError(503, "TASK_SOURCE_SERVICE_UNAVAILABLE", "协作任务库尚未接入")
            if read_context is None:
                # Mutation/internal paths retain their authoritative checks.
                self.task_bindings.validate(stable_id)
                if value.get("outbox_id"):
                    self.task_bindings.bind_handoff(stable_id, value["id"], value["outbox_id"])
                for annotation in value.get("reviews", []):
                    self.task_bindings.record_review(stable_id, annotation)
            else:
                # Repair only a frozen delivery mapping during GET. Reviews
                # already stored in either database are kept; GET does not
                # replay review writes or derive another execution grant.
                if value.get("outbox_id"):
                    self.task_bindings.link_handoff(stable_id, value["id"], value["outbox_id"])
            task = self.task_bindings.get(stable_id, read_context=read_context)
            if not task["permitted"] or task.get("body_unavailable"):
                raise OutboxError(503 if task["source_status"] == "temporarily_unavailable" else 409,
                                  task["source_error"] or "TASK_AUTH_WITHDRAWN", "任务来源当前不可使用")
        except OutboxError as error:
            # Retain identifiers and delivery facts, but do not expose stale
            # source-derived instructions or replies as current usable work.
            result = self._delivery_facts(value, outbox)
            result.update(body_unavailable=True, source_status="temporarily_unavailable" if error.http_status >= 500 else "unavailable",
                          source_error=error.code, business_status_changed=False, replies=[], reviews=[])
            return result
        value["task"] = task
        return self._transport(value, outbox)

    @staticmethod
    def _request_owner(db, request_id):
        row = db.execute("SELECT id,outbox_id FROM handoffs WHERE request_id=?", (request_id,)).fetchone()
        if row is not None:
            return dict(kind="handoff", handoff_id=row["id"], id=row["id"], outbox_id=row["outbox_id"])
        for table, kind in (("communications", "continuation"), ("reviews", "review")):
            row = db.execute(f"SELECT * FROM {table} WHERE request_id=?", (request_id,)).fetchone()
            if row is not None:
                return dict(kind=kind, handoff_id=row["handoff_id"], id=row["id"],
                            **({"outbox_id": row["outbox_id"]} if kind == "continuation" else {"reply_id": json.loads(row["payload_json"])["reply_id"]}))
        return None

    def find_request(self, request_id, outbox=None, personal=None, read_context=None):
        request_id = _request(request_id)
        with self._transaction() as db:
            operation = self._request_owner(db, request_id)
            if operation is not None and not self._reader_allowed(json.loads(self._row(db, operation["handoff_id"])["payload_json"]), personal):
                operation = None
            if operation and operation["kind"] in ("handoff", "continuation") and operation["outbox_id"] is None and outbox is not None:
                table = "handoffs" if operation["kind"] == "handoff" else "communications"
                row = db.execute(f"SELECT * FROM {table} WHERE id=?", (operation["id"],)).fetchone()
                found = outbox.find_request(row["outbox_request_id"])["items"]
                if found:
                    wire, message = json.loads(row["wire_json"]), found[0]
                    if any(message.get(key) != wire[key] for key in ("kind", "target", "text")):
                        raise OutboxError(409, "OUTBOX_MAPPING_CONFLICT", "既有发送请求与冻结交接不一致")
                    db.execute(f"UPDATE {table} SET outbox_id=?,updated_at=?,last_error=NULL WHERE id=?", (message["id"], _now(), operation["id"]))
                    operation["outbox_id"] = message["id"]
        if operation is None:
            return {"items": [], "operation_request_id": request_id, "operation": None}
        value = self.get(operation["handoff_id"], outbox, personal=personal, read_context=read_context)
        value.update(operation_request_id=request_id, operation=operation)
        return {"items": [value], "operation_request_id": request_id, "operation": operation}

    def for_task(self, stable_id, outbox=None, personal=None, read_context=None):
        """Read the saved root intent, including a crash before outbox linking.

        This may adopt an already-existing exact outbox request, but never
        creates an outbox message or changes its delivery authorization.
        """
        stable_id = checked_task_id(stable_id)
        if self.task_bindings is None:
            raise OutboxError(503, "TASK_SOURCE_SERVICE_UNAVAILABLE", "协作任务库尚未接入")
        if personal is not None:
            self.task_bindings.require_reader(stable_id, personal)
        with self._transaction() as db:
            row = db.execute("SELECT h.request_id FROM task_roots t JOIN handoffs h ON h.id=t.handoff_id WHERE t.task_id=?", (stable_id,)).fetchone()
        return self.find_request(row["request_id"], outbox, personal=personal, read_context=read_context) if row else {"items": []}

    def _family_dispatch(self, db, task_ids, outbox):
        """Delivery-only barrier across source versions; no network writes."""
        selected = set(task_ids)
        roots = [row for row in db.execute("SELECT * FROM handoffs ORDER BY created_at,id")
                 if json.loads(row["payload_json"]).get("task_id") in selected]
        facts = []
        for root in roots:
            stable_id = json.loads(root["payload_json"])["task_id"]
            records = [("handoffs", root, "handoff")]
            records.extend(("communications", row, "continuation") for row in db.execute(
                "SELECT * FROM communications WHERE handoff_id=? ORDER BY created_at,id", (root["id"],)))
            for table, row, kind in records:
                outbox_id = row["outbox_id"]
                if outbox_id is None:
                    found = outbox.find_request(row["outbox_request_id"])["items"]
                    if found:
                        wire, message = json.loads(row["wire_json"]), found[0]
                        if any(message.get(key) != wire[key] for key in ("kind", "target", "text")):
                            raise OutboxError(409, "OUTBOX_MAPPING_CONFLICT", "既有发送请求与冻结派工不一致")
                        outbox_id = message["id"]
                        db.execute(f"UPDATE {table} SET outbox_id=?,updated_at=? WHERE id=?", (outbox_id, _now(), row["id"]))
                fact = self._delivery_facts(dict(id=row["id"], request_id=row["request_id"], task_id=stable_id,
                    outbox_id=outbox_id, outbox_request_id=row["outbox_request_id"], created_at=row["created_at"], updated_at=row["updated_at"]), outbox)
                fact.pop("communications", None)
                fact.update(handoff_id=root["id"], operation_kind=kind)
                facts.append(fact)
        blockers = [fact for fact in facts if fact["transport_status"] in ("unknown", "dispatching", "preparing", "unavailable")]
        return dict(blocking_dispatch=bool(blockers), blocking_dispatches=blockers, prior_dispatches=facts)

    def source_dispatch_status(self, supplied, personal, outbox):
        task_ids = self.task_bindings.dispatch_family(supplied, personal)
        with self._transaction() as db:
            return self._family_dispatch(db, task_ids, outbox)

    def task_dispatch_status(self, task_ids, outbox, personal=None):
        family = set()
        for stable_id in task_ids:
            if personal is not None:
                self.task_bindings.require_reader(stable_id, personal)
            family.update(self.task_bindings.source_family(stable_id))
        with self._transaction() as db:
            return self._family_dispatch(db, family, outbox)

    @staticmethod
    def _handoff_shape(body):
        _fields(body, ("request_id", "title", "text", "confirm", "group_channel_id", "group_version", "member_ids", "local_task_ref", "task_id"))
        if body.get("confirm") is not True:
            raise OutboxError(400, "CONFIRM_REQUIRED", "请核对群组、参与者和本次正文后明确确认")
        version = body.get("group_version")
        if type(version) is not int or version < 1:
            raise OutboxError(400, "BAD_REQUEST", "group_version 无效")
        members = body.get("member_ids")
        if not isinstance(members, list) or not 1 <= len(members) <= 16:
            raise OutboxError(400, "BAD_REQUEST", "请明确选择本次协作的 Agent")
        ids = [_uuid(item, "member_ids") for item in members]
        if len(set(ids)) != len(ids):
            raise OutboxError(400, "BAD_REQUEST", "所选 Agent ID 重复")
        payload = dict(request_id=_request(body.get("request_id")), title=_text(body.get("title"), "title", 200),
                       text=_text(body.get("text"), "text", 12000), group_channel_id=_uuid(body.get("group_channel_id"), "group_channel_id"),
                       group_version=version, member_ids=ids)
        if body.get("local_task_ref") is not None:
            ref = body["local_task_ref"]
            _fields(ref, ("kind", "id", "version", "space_key"))
            if ref.get("kind") != "prototype" or type(ref.get("version")) is not int or ref["version"] < 1:
                raise OutboxError(400, "BAD_REQUEST", "本地任务关联仅支持 prototype 与明确版本，不是来源证明")
            payload["local_task_ref"] = dict(kind="prototype", id=_text(ref.get("id"), "local_task_ref.id", 200),
                                              version=ref["version"], space_key=_text(ref.get("space_key"), "local_task_ref.space_key", 200))
        if "task_id" in body:
            if "local_task_ref" in payload:
                raise OutboxError(400, "TASK_REFERENCE_CONFLICT", "真实协作任务与原型返回关联不能混用")
            payload["task_id"] = checked_task_id(body["task_id"])
        return payload

    def _require_group(self, db, payload):
        self._expire(db)
        row = self._state(db)
        if row["status"] != "available":
            raise OutboxError(409, "GROUP_UNAVAILABLE", "协作群当前不可核对，不能继续发送")
        if payload["group_channel_id"] != self.channel_id or payload["group_version"] != row["version"]:
            raise OutboxError(409, "GROUP_CHANGED", "群组或成员已变化，请重新读取并核对本次交接")
        group = json.loads(row["snapshot_json"])
        agents = {member["id"]: member for member in group["members"] if member["type"] == "agent" and member["id"] != group["bridge_agent_id"]}
        if any(member_id not in agents for member_id in payload["member_ids"]):
            raise OutboxError(409, "MEMBER_CHANGED", "选定 Agent 已不在当前群组，不能按同名成员发送")
        task = None
        if payload.get("task_id") is not None:
            if self.task_bindings is None:
                raise OutboxError(503, "TASK_SOURCE_SERVICE_UNAVAILABLE", "真实协作任务库尚未接入")
            self.task_bindings.validate(payload["task_id"])
            task = self.task_bindings.get(payload["task_id"])
            if not task["permitted"] or task.get("body_unavailable"):
                raise OutboxError(503 if task["source_status"] == "temporarily_unavailable" else 409,
                                  task["source_error"] or "TASK_AUTH_WITHDRAWN", "任务派工来源当前不可使用")
            if "title" in payload and (task["title"] != payload["title"] or task["text"] != payload["text"]):
                raise OutboxError(409, "TASK_DRAFT_CHANGED", "任务登记内容与本次派工不同，请按原请求核对")
        return group, [agents[member_id] for member_id in payload["member_ids"]], task

    @staticmethod
    def _instruction_preview(payload, agents, task):
        prefix = " ".join(agent["handle"] for agent in agents) + "\n\n"
        if task and task["kind"] == "candidate_collaboration":
            return prefix + CANDIDATE_PREFIX + "\n" + payload["text"]
        return prefix + (payload["title"] + "\n\n" if "title" in payload else "") + payload["text"]

    def validate_dispatch(self, job):
        """Check a real leased outbox job immediately before its network send.

        The caller verifies the lease. This method binds job ID and immutable
        transport payload to the current group snapshot and selected Agent IDs.
        It never claims work or sends anything itself.
        """
        if not isinstance(job, dict) or not isinstance(job.get("id"), str):
            raise OutboxError(400, "BAD_REQUEST", "缺少实际发送尝试")
        with self._transaction() as db:
            row = db.execute("SELECT * FROM handoffs WHERE outbox_id=?", (job["id"],)).fetchone()
            table = "handoffs"
            if row is None:
                row = db.execute("SELECT * FROM communications WHERE outbox_id=?", (job["id"],)).fetchone()
                table = "communications"
            if row is None:
                # The outbox can commit immediately before a crash prevented
                # recording its ID here. A real leased job may repair only its
                # matching frozen intent, never create or resend one.
                for candidate in ("handoffs", "communications"):
                    row = db.execute(f"SELECT * FROM {candidate} WHERE outbox_request_id=?", (job.get("request_id"),)).fetchone()
                    if row is not None:
                        table = candidate
                        break
            if row is None:
                raise OutboxError(409, "HANDOFF_MAPPING_REQUIRED", "发送尝试没有可信协作交接映射")
            if row["outbox_id"] not in (None, job["id"]):
                raise OutboxError(409, "OUTBOX_MAPPING_CONFLICT", "冻结交接已绑定另一发送尝试")
            wire, payload = json.loads(row["wire_json"]), json.loads(row["payload_json"])
            if any(job.get(key) != wire[key] for key in ("request_id", "kind", "target", "text")):
                raise OutboxError(409, "HANDOFF_PAYLOAD_CHANGED", "发送尝试与冻结交接不一致")
            self._require_group(db, payload)
            if row["outbox_id"] is None:
                db.execute(f"UPDATE {table} SET outbox_id=?,updated_at=?,last_error=NULL WHERE id=?", (job["id"], _now(), row["id"]))
        return True

    def submit_handoff(self, body, outbox, personal=None):
        payload = self._handoff_shape(body)
        if not self._reader_allowed(payload, personal):
            raise OutboxError(403, "TASK_SOURCE_FORBIDDEN", "这条来源任务不属于当前手机身份")
        payload_hash, encoded = _hash(payload), _json(payload)
        with self._transaction() as db:
            owner = self._request_owner(db, payload["request_id"])
            if owner is not None and owner["kind"] != "handoff":
                raise OutboxError(409, "REQUEST_ID_CONFLICT", "该 request_id 已用于另一协作操作")
            existing = db.execute("SELECT * FROM handoffs WHERE request_id=?", (payload["request_id"],)).fetchone()
            if existing is not None:
                if existing["payload_hash"] != payload_hash:
                    raise OutboxError(409, "REQUEST_ID_CONFLICT", "同一 request_id 已绑定另一群组、任务关联或正文")
                handoff_id = existing["id"]
            else:
                if payload.get("task_id") is not None and db.execute("SELECT handoff_id FROM task_roots WHERE task_id=?", (payload["task_id"],)).fetchone():
                    raise OutboxError(409, "TASK_HANDOFF_EXISTS", "这条任务已有独立线程，请读取原线程后明确续发；未知送达不能另开线程")
                if payload.get("task_id") is not None and self._family_dispatch(
                        db, self.task_bindings.source_family(payload["task_id"]), outbox)["blocking_dispatch"]:
                    raise OutboxError(409, "SOURCE_DISPATCH_UNRESOLVED", "原事项仍有未知或正在发送的派工，请查询原线程，不能另派")
                group, agents, task = self._require_group(db, payload)
                preview = self._instruction_preview(payload, agents, task)
                if len(preview) > 12000:
                    raise OutboxError(400, "BAD_REQUEST", "本次标题、Agent 与正文合计不得超过12000字")
                outbox_request_id = "handoff:" + hashlib.sha256(payload["request_id"].encode()).hexdigest()
                wire = dict(request_id=outbox_request_id, kind="instruction", target=self.target, text=preview, confirm=True)
                handoff_id, now = uuid.uuid4().hex, _now()
                db.execute("INSERT INTO handoffs(id,request_id,payload_hash,payload_json,wire_json,group_snapshot_json,outbox_request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                           (handoff_id, payload["request_id"], payload_hash, encoded, _json(wire), _json(group), outbox_request_id, now, now))
                if payload.get("task_id") is not None:
                    db.execute("INSERT INTO task_roots(task_id,handoff_id) VALUES(?,?)", (payload["task_id"], handoff_id))
        # The intent is committed first. If the second database commits but
        # linking fails, the original request can discover and adopt it. Never
        # allocate a new external request ID to recover this handoff.
        try:
            with self._transaction() as db:
                row = self._row(db, handoff_id)
                if row["outbox_id"] is None:
                    wire = json.loads(row["wire_json"])
                    found = outbox.find_request(row["outbox_request_id"])["items"]
                    if found:
                        message = found[0]
                        if any(message.get(key) != wire[key] for key in ("kind", "target", "text")):
                            raise OutboxError(409, "OUTBOX_MAPPING_CONFLICT", "既有发送请求与冻结交接不一致")
                    else:
                        self._require_group(db, payload)
                        message = outbox.submit(wire)
                    db.execute("UPDATE handoffs SET outbox_id=?,updated_at=?,last_error=NULL WHERE id=?", (message["id"], _now(), handoff_id))
        except OutboxError as error:
            with self._transaction() as db:
                db.execute("UPDATE handoffs SET last_error=?,updated_at=? WHERE id=?", (error.code, _now(), handoff_id))
            raise
        value = self.get(handoff_id, outbox)
        value.update(operation_request_id=payload["request_id"], operation=dict(kind="handoff", id=handoff_id, handoff_id=handoff_id, outbox_id=value["outbox_id"]))
        return value

    def continue_handoff(self, body, outbox, personal=None):
        _fields(body, ("request_id", "handoff_id", "text", "group_version", "member_ids", "confirm"))
        if body.get("confirm") is not True:
            raise OutboxError(400, "CONFIRM_REQUIRED", "请明确确认本次线程续发正文及 Agent")
        version, members = body.get("group_version"), body.get("member_ids")
        if type(version) is not int or version < 1 or not isinstance(members, list) or not 1 <= len(members) <= 16:
            raise OutboxError(400, "BAD_REQUEST", "请核对当前群版本并明确选择 Agent")
        ids = [_uuid(item, "member_ids") for item in members]
        if len(set(ids)) != len(ids):
            raise OutboxError(400, "BAD_REQUEST", "所选 Agent ID 重复")
        handoff_id = _handoff_id(body.get("handoff_id"))
        self.require_reader(handoff_id, personal)
        payload = dict(request_id=_request(body.get("request_id")), handoff_id=handoff_id,
                       text=_text(body.get("text"), "text", 12000), group_channel_id=self.channel_id,
                       group_version=version, member_ids=ids)
        with self._transaction() as db:
            root = self._row(db, handoff_id)
            root_payload = json.loads(root["payload_json"])
            if root_payload.get("task_id") is not None:
                payload["task_id"] = root_payload["task_id"]
            payload_hash, encoded = _hash(payload), _json(payload)
            owner = self._request_owner(db, payload["request_id"])
            if owner is not None and owner["kind"] != "continuation":
                raise OutboxError(409, "REQUEST_ID_CONFLICT", "该 request_id 已用于另一协作操作")
            existing = db.execute("SELECT * FROM communications WHERE request_id=?", (payload["request_id"],)).fetchone()
            if existing is not None:
                if existing["payload_hash"] != payload_hash:
                    raise OutboxError(409, "REQUEST_ID_CONFLICT", "同一续发请求已绑定另一交接、Agent 或正文")
                communication_id = existing["id"]
            else:
                _, agents, task = self._require_group(db, payload)
                if root["outbox_id"] is None:
                    raise OutboxError(409, "ROOT_SENT_REQUIRED", "首条交接仍待核对，不能另造线程发送")
                sent = outbox.get(root["outbox_id"])
                if sent["status"] != "sent" or sent["target"] != self.target:
                    raise OutboxError(409, "ROOT_SENT_REQUIRED", "须先取得本次群交接的明确送达回执")
                root_message_id = _uuid(sent.get("raft_message_id"), "raft_message_id")
                preview = self._instruction_preview(payload, agents, task)
                if len(preview) > 12000:
                    raise OutboxError(400, "BAD_REQUEST", "本次 Agent 与正文合计不得超过12000字")
                outbox_request_id = "handoff-continue:" + hashlib.sha256(payload["request_id"].encode()).hexdigest()
                wire = dict(request_id=outbox_request_id, kind="instruction", target=f"thread:{self.channel_id}:{root_message_id}", text=preview, confirm=True)
                communication_id, now = uuid.uuid4().hex, _now()
                db.execute("INSERT INTO communications(id,request_id,handoff_id,payload_hash,payload_json,wire_json,outbox_request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                           (communication_id, payload["request_id"], handoff_id, payload_hash, encoded, _json(wire), outbox_request_id, now, now))
        try:
            with self._transaction() as db:
                row = db.execute("SELECT * FROM communications WHERE id=?", (communication_id,)).fetchone()
                if row["outbox_id"] is None:
                    wire = json.loads(row["wire_json"])
                    found = outbox.find_request(row["outbox_request_id"])["items"]
                    if found:
                        message = found[0]
                        if any(message.get(key) != wire[key] for key in ("kind", "target", "text")):
                            raise OutboxError(409, "OUTBOX_MAPPING_CONFLICT", "既有发送请求与冻结续发不一致")
                    else:
                        self._require_group(db, payload)
                        message = outbox.submit(wire)
                    db.execute("UPDATE communications SET outbox_id=?,updated_at=?,last_error=NULL WHERE id=?", (message["id"], _now(), communication_id))
                resolved_outbox_id = db.execute("SELECT outbox_id FROM communications WHERE id=?", (communication_id,)).fetchone()[0]
        except OutboxError as error:
            with self._transaction() as db:
                db.execute("UPDATE communications SET last_error=?,updated_at=? WHERE id=?", (error.code, _now(), communication_id))
            raise
        value = self.get(handoff_id, outbox)
        value.update(operation_request_id=payload["request_id"], operation=dict(kind="continuation", id=communication_id, handoff_id=handoff_id, outbox_id=resolved_outbox_id))
        return value

    def review(self, body, outbox, personal=None):
        _fields(body, ("request_id", "handoff_id", "reply_id", "kind", "note", "confirm"))
        if body.get("confirm") is not True:
            raise OutboxError(400, "CONFIRM_REQUIRED", "请明确确认核对这条 Agent 回复")
        kind = body.get("kind")
        if kind not in ("progress", "artifact"):
            raise OutboxError(400, "BAD_REQUEST", "回复核对仅支持 progress 或 artifact")
        handoff_id = _handoff_id(body.get("handoff_id"))
        self.require_reader(handoff_id, personal)
        payload = dict(request_id=_request(body.get("request_id")), handoff_id=handoff_id,
                       reply_id=_text(body.get("reply_id"), "reply_id", 200), kind=kind)
        if body.get("note") is not None:
            note = body["note"]
            if not isinstance(note, str) or len(note) > 1000 or "\x00" in note:
                raise OutboxError(400, "BAD_REQUEST", "note 格式无效或过长")
            payload["note"] = note.strip()
        encoded, payload_hash = _json(payload), _hash(payload)
        with self._transaction() as db:
            prior = db.execute("SELECT * FROM reviews WHERE request_id=?", (payload["request_id"],)).fetchone()
            if prior is not None:
                if prior["payload_hash"] != payload_hash:
                    raise OutboxError(409, "REVIEW_REQUEST_CONFLICT", "同一核对请求已绑定另一回复或核对意见")
                prior_id = prior["id"]
            else:
                prior_id = None
        if prior_id is not None:
            # Repeating an acknowledged annotation is safe even after its
            # reply leaves the bounded live reply window. Do not re-confirm it.
            value = self.get(handoff_id, outbox)
            value.update(operation_request_id=payload["request_id"], operation=dict(kind="review", id=prior_id, handoff_id=handoff_id, reply_id=payload["reply_id"]))
            return value
        value = self.get(handoff_id, outbox)
        reply = next((item for item in value["replies"] if item["reply_id"] == payload["reply_id"]), None)
        if reply is None:
            raise OutboxError(409, "REPLY_UNAVAILABLE", "请先读取并选择这条交接的实际 Raft 回复")
        reply_hash = _hash(reply)
        with self._transaction() as db:
            self._expire(db)
            if self._state(db)["status"] != "available":
                raise OutboxError(409, "GROUP_UNAVAILABLE", "群组权限已不可核对，不能继续使用旧回复正文")
            self._row(db, handoff_id)
            owner = self._request_owner(db, payload["request_id"])
            if owner is not None and owner["kind"] != "review":
                raise OutboxError(409, "REQUEST_ID_CONFLICT", "该 request_id 已用于另一协作操作")
            prior = db.execute("SELECT * FROM reviews WHERE request_id=?", (payload["request_id"],)).fetchone()
            if prior is not None:
                if prior["payload_hash"] != payload_hash or prior["reply_hash"] != reply_hash:
                    raise OutboxError(409, "REVIEW_REQUEST_CONFLICT", "同一核对请求已绑定另一回复或核对意见")
                review_id = prior["id"]
            else:
                review_id = uuid.uuid4().hex
                db.execute("INSERT INTO reviews(id,request_id,handoff_id,payload_hash,payload_json,reply_hash,confirmed_at) VALUES(?,?,?,?,?,?,?)",
                           (review_id, payload["request_id"], handoff_id, payload_hash, encoded, reply_hash, _now()))
                db.execute("UPDATE handoffs SET updated_at=? WHERE id=?", (_now(), handoff_id))
        value = self.get(handoff_id, outbox)
        value.update(operation_request_id=payload["request_id"], operation=dict(kind="review", id=review_id, handoff_id=handoff_id, reply_id=payload["reply_id"]))
        return value

    def cancel(self, handoff_id, outbox, personal=None):
        handoff_id = _handoff_id(handoff_id)
        self.require_reader(handoff_id, personal)
        with self._transaction() as db:
            row = self._row(db, handoff_id)
            outbox_id = row["outbox_id"]
            if outbox_id is None:
                found = outbox.find_request(row["outbox_request_id"])["items"]
                if not found:
                    raise OutboxError(409, "OUTBOX_MAPPING_PENDING", "交接映射尚未恢复，请按原请求读取结果")
                outbox_id = found[0]["id"]
            outbox.cancel(outbox_id)
            db.execute("UPDATE handoffs SET outbox_id=?,updated_at=? WHERE id=?", (outbox_id, _now(), handoff_id))
        return self.get(handoff_id, outbox)
