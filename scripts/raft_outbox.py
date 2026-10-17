"""Durable, explicit-text Oops -> Raft outbox.

This queue is independent of the existing Mac assistant jobs. It never reads
meetings or assembles instructions from a transcript. A worker claims each
message once; a missing Raft receipt becomes unknown and is never re-sent.
Raft credentials belong to the worker, not this database or its API responses.
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


STATUSES = frozenset(("queued", "dispatching", "sent", "unknown", "failed", "cancelled"))
SETTLED = frozenset(("sent", "unknown", "failed"))
LEASE_SECONDS = 120
MAX_TEXT = 12000
MAX_RESPONSE = 20000


class OutboxError(ValueError):
    def __init__(self, http_status, code, message):
        super().__init__(message)
        self.http_status = http_status
        self.code = code


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")


def _text(value, field, limit, required=True):
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > limit or "\x00" in value:
        raise OutboxError(400, "BAD_REQUEST", f"{field} 为空、格式不正确或过长")
    return value.strip()


def _fields(body, allowed):
    if not isinstance(body, dict):
        raise OutboxError(400, "BAD_REQUEST", "请求必须为 JSON 对象")
    if set(body) - set(allowed):
        raise OutboxError(400, "UNSUPPORTED_FIELDS", "首版仅接受本人明确填写的文本，不接收会议、任务、来源材料或凭据字段")


def _safe_error(value):
    if value is None:
        return None
    value = _text(value, "error", 1000, required=False)
    value = re.sub(r"(?i)bearer\s+[^\s,;]+", "Bearer [redacted]", value)
    return re.sub(r"(?i)((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*)[^\s,;]+", r"\1[redacted]", value)


def _response(value):
    """Keep a small receipt contract; never persist raw SDK response objects."""
    if value is None:
        return None
    if isinstance(value, str):
        value = _text(value, "response", MAX_RESPONSE, required=False)
    elif isinstance(value, dict):
        _fields(value, ("provider", "message_seq", "target", "channel_id", "sender_id", "receiver_id", "thread_id", "root_message_id", "root_channel_id"))
        clean = {}
        for key, item in value.items():
            if key == "message_seq":
                if isinstance(item, bool) or not isinstance(item, (str, int)):
                    raise OutboxError(400, "BAD_REQUEST", "message_seq 格式无效")
                clean[key] = _text(str(item), key, 200)
            else:
                clean[key] = _text(item, key, 200)
        if clean.get("provider") not in (None, "raft"):
            raise OutboxError(400, "BAD_REQUEST", "回执 provider 必须为 raft")
        value = clean
    else:
        raise OutboxError(400, "BAD_REQUEST", "response 必须为文本或规范回执对象")
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Outbox:
    """SQLite-backed queue. `directory` should be the backend's state-dir/raft.

    Public jobs omit leases. Only claim() returns the current worker lease.
    settle() accepts {status, raft_message_id?, response?, error?}; `sent`
    requires an actual provider message ID. No method retries an unknown send.
    """

    def __init__(self, directory, allowed_targets):
        self.directory = os.path.abspath(directory)
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        self.path = os.path.join(self.directory, "outbox.sqlite3")
        targets = [allowed_targets] if isinstance(allowed_targets, str) else allowed_targets
        self.allowed_targets = frozenset(_text(t, "target", 200) for t in (targets or []))
        with self._transaction() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
                    fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL,
                    status TEXT NOT NULL, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                    lease TEXT, lease_until REAL, worker TEXT,
                    raft_message_id TEXT, response TEXT, error TEXT
                );
                CREATE TABLE IF NOT EXISTS attempts (
                    lease TEXT PRIMARY KEY, message_id TEXT NOT NULL,
                    number INTEGER NOT NULL, worker TEXT NOT NULL,
                    payload_json TEXT NOT NULL, started_at TEXT NOT NULL,
                    lease_until REAL NOT NULL, finished_at TEXT, status TEXT NOT NULL,
                    raft_message_id TEXT, response TEXT, error TEXT,
                    FOREIGN KEY(message_id) REFERENCES messages(id)
                );
                CREATE TABLE IF NOT EXISTS replies (
                    reply_id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
                    payload_json TEXT NOT NULL, received_at TEXT NOT NULL,
                    FOREIGN KEY(message_id) REFERENCES messages(id)
                );
                CREATE INDEX IF NOT EXISTS messages_status_created ON messages(status, created_at);
                CREATE INDEX IF NOT EXISTS replies_message ON replies(message_id);
                CREATE INDEX IF NOT EXISTS messages_raft_receipt ON messages(raft_message_id);
            """)
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
    def _id(value):
        if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
            raise OutboxError(400, "BAD_REQUEST", "消息编号无效")
        return value

    @staticmethod
    def _row(db, message_id):
        row = db.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if row is None:
            raise OutboxError(404, "NOT_FOUND", "没有这条消息")
        return row

    def _target(self, target):
        uuid_pattern = r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
        thread = re.fullmatch(r"thread:(" + uuid_pattern + r"):(" + uuid_pattern + r")", target or "")
        if target not in self.allowed_targets and not (thread and "channel:" + thread.group(1) in self.allowed_targets):
            raise OutboxError(403, "TARGET_NOT_ALLOWED", "Raft 目标未获准，请先配置明确的目标")

    @staticmethod
    def _expire(db):
        # A worker may have sent before crashing. Preserve its lease, and allow
        # a late definite receipt for that attempt, but never dispatch it again.
        now = _now()
        rows = db.execute("SELECT id, lease FROM messages WHERE status='dispatching' AND lease_until<=?", (time.time(),)).fetchall()
        for row in rows:
            db.execute("UPDATE messages SET status='unknown',updated_at=?,error=? WHERE id=?",
                       (now, "未收到 Raft 回执；为避免重复发送，已停止自动重试", row["id"]))
            db.execute("UPDATE attempts SET status='unknown',finished_at=?,error=? WHERE lease=?",
                       (now, "receipt_timeout", row["lease"]))

    @staticmethod
    def _public(db, row):
        payload = json.loads(row["payload_json"])
        value = {k: row[k] for k in ("id", "request_id", "status", "created_at", "updated_at", "attempts", "raft_message_id", "response", "error")}
        value["response"] = json.loads(row["response"]) if row["response"] is not None else None
        if isinstance(value["response"], dict) and value["response"].get("channel_id"):
            value["channel_id"] = value["response"]["channel_id"]
        if isinstance(value["response"], dict):
            for key in ("thread_id", "root_message_id", "root_channel_id"):
                if value["response"].get(key):
                    value[key] = value["response"][key]
        value.update(payload)
        value["replies"] = [dict(json.loads(r["payload_json"]), received_at=r["received_at"])
                            for r in db.execute("SELECT payload_json,received_at FROM (SELECT payload_json,received_at FROM replies WHERE message_id=? ORDER BY received_at DESC,reply_id DESC LIMIT 50) ORDER BY received_at", (row["id"],))]
        value["attempt_history"] = [dict(a) for a in db.execute(
            "SELECT number,worker,started_at,finished_at,status,raft_message_id,error FROM attempts WHERE message_id=? ORDER BY number", (row["id"],))]
        return value

    def submit(self, body):
        _fields(body, ("request_id", "kind", "target", "text", "confirm"))
        if body.get("confirm") is not True:
            raise OutboxError(400, "CONFIRM_REQUIRED", "请明确确认发送本次文本")
        request_id = _text(body.get("request_id"), "request_id", 128)
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request_id):
            raise OutboxError(400, "BAD_REQUEST", "request_id 格式无效")
        kind = body.get("kind")
        if kind not in ("message", "instruction"):
            raise OutboxError(400, "BAD_REQUEST", "kind 仅支持 message 或 instruction")
        payload = dict(kind=kind, target=_text(body.get("target"), "target", 200), text=_text(body.get("text"), "text", MAX_TEXT))
        self._target(payload["target"])
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
        with self._transaction() as db:
            self._expire(db)
            existing = db.execute("SELECT * FROM messages WHERE request_id=?", (request_id,)).fetchone()
            if existing is not None:
                if existing["fingerprint"] != fingerprint:
                    raise OutboxError(409, "REQUEST_ID_CONFLICT", "同一 request_id 已绑定另一条文本或目标")
                return self._public(db, existing)
            message_id, now = uuid.uuid4().hex, _now()
            db.execute("INSERT INTO messages(id,request_id,fingerprint,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                       (message_id, request_id, fingerprint, encoded, "queued", now, now))
            return self._public(db, self._row(db, message_id))

    def get(self, message_id):
        message_id = self._id(message_id)
        with self._transaction() as db:
            self._expire(db)
            return self._public(db, self._row(db, message_id))

    def lease_view(self, message_id, lease):
        """Worker-only pre-send check; a known or expired attempt is never sent again."""
        message_id, lease = self._id(message_id), self._id(lease)
        with self._transaction() as db:
            self._expire(db)
            row = self._row(db, message_id)
            if row["lease"] != lease or row["status"] != "dispatching":
                raise OutboxError(409, "LEASE_CONFLICT", "本次发送租约已失效，停止发送")
            return self._public(db, row)

    def find_request(self, request_id):
        request_id = _text(request_id, "request_id", 128)
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request_id):
            raise OutboxError(400, "BAD_REQUEST", "request_id 格式无效")
        with self._transaction() as db:
            self._expire(db)
            row = db.execute("SELECT * FROM messages WHERE request_id=?", (request_id,)).fetchone()
            return {"items": [] if row is None else [self._public(db, row)]}

    def list(self, limit=30, status=None):
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
            raise OutboxError(400, "BAD_REQUEST", "limit 应为 1 至 100")
        if status is not None and (not isinstance(status, str) or status not in STATUSES):
            raise OutboxError(400, "BAD_REQUEST", "status 无效")
        with self._transaction() as db:
            self._expire(db)
            query, values = "SELECT * FROM messages", []
            if status is not None:
                query += " WHERE status=?"
                values.append(status)
            query += " ORDER BY created_at DESC,id DESC LIMIT ?"
            values.append(limit)
            return {"items": [self._public(db, row) for row in db.execute(query, values)]}

    def claim(self, worker):
        worker = _text(worker, "worker", 80)
        with self._transaction() as db:
            self._expire(db)
            row = None
            for candidate in db.execute("SELECT * FROM messages WHERE status='queued' ORDER BY created_at,id"):
                try:
                    self._target(json.loads(candidate["payload_json"])["target"])
                    row = candidate
                    break
                except OutboxError:
                    pass
                db.execute("UPDATE messages SET status='failed',updated_at=?,error=? WHERE id=?",
                           (_now(), "目标许可已撤回，未发送到 Raft", candidate["id"]))
            if row is None:
                return {"job": None}
            payload = json.loads(row["payload_json"])
            self._target(payload["target"])
            lease, now, until = uuid.uuid4().hex, _now(), time.time() + LEASE_SECONDS
            attempt = row["attempts"] + 1
            db.execute("UPDATE messages SET status='dispatching',updated_at=?,attempts=?,lease=?,lease_until=?,worker=? WHERE id=?",
                       (now, attempt, lease, until, worker, row["id"]))
            db.execute("INSERT INTO attempts(lease,message_id,number,worker,payload_json,started_at,lease_until,status) VALUES(?,?,?,?,?,?,?,?)",
                       (lease, row["id"], attempt, worker, row["payload_json"], now, until, "dispatching"))
            value = self._public(db, self._row(db, row["id"]))
            value.update(lease=lease, lease_until=dt.datetime.fromtimestamp(until, dt.timezone.utc).isoformat(), attempt=attempt)
            return {"job": value}

    def settle(self, message_id, lease, body):
        message_id, lease = self._id(message_id), self._id(lease)
        _fields(body, ("status", "raft_message_id", "response", "error"))
        status = body.get("status")
        if not isinstance(status, str) or status not in SETTLED:
            raise OutboxError(400, "BAD_REQUEST", "回执 status 仅支持 sent、unknown 或 failed")
        receipt = _text(body.get("raft_message_id"), "raft_message_id", 200, required=status == "sent")
        response = _response(body.get("response"))
        error = _safe_error(body.get("error"))
        if status == "sent" and error:
            raise OutboxError(400, "BAD_REQUEST", "成功回执不能同时报告发送失败")
        with self._transaction() as db:
            self._expire(db)
            row = self._row(db, message_id)
            if receipt:
                other = db.execute("SELECT id FROM messages WHERE raft_message_id=? AND id<>?", (receipt, message_id)).fetchone()
                if other is not None:
                    raise OutboxError(409, "RECEIPT_ID_CONFLICT", "同一 Raft 消息回执已绑定另一条发送")
            if row["lease"] != lease:
                raise OutboxError(409, "LEASE_CONFLICT", "回执不属于当前发送尝试")
            if row["status"] in ("sent", "failed"):
                if all(row[k] == value for k, value in (("status", status), ("raft_message_id", receipt), ("response", response), ("error", error))):
                    return self._public(db, row)
                raise OutboxError(409, "RECEIPT_CONFLICT", "本次发送已经有明确回执，不能覆盖")
            if row["status"] not in ("dispatching", "unknown"):
                raise OutboxError(409, "INVALID_STATE", "此消息不在等待发送回执")
            now = _now()
            db.execute("UPDATE messages SET status=?,updated_at=?,raft_message_id=?,response=?,error=? WHERE id=?",
                       (status, now, receipt, response, error, message_id))
            db.execute("UPDATE attempts SET status=?,finished_at=?,raft_message_id=?,response=?,error=? WHERE lease=?",
                       (status, now, receipt, response, error, lease))
            return self._public(db, self._row(db, message_id))

    def by_raft_message(self, raft_message_id):
        """Worker-only lookup used to bind an actual thread reply to its send."""
        receipt = _text(raft_message_id, "raft_message_id", 200)
        with self._transaction() as db:
            self._expire(db)
            row = db.execute("SELECT * FROM messages WHERE raft_message_id=?", (receipt,)).fetchone()
            if row is None:
                raise OutboxError(404, "NOT_FOUND", "没有对应的 Oops 发送回执")
            return self._public(db, row)

    def cancel(self, message_id):
        message_id = self._id(message_id)
        with self._transaction() as db:
            self._expire(db)
            row = self._row(db, message_id)
            if row["status"] == "cancelled":
                return self._public(db, row)
            if row["status"] != "queued":
                raise OutboxError(409, "CANNOT_CANCEL", "消息已经开始发送，无法把本地取消当作 Raft 撤回")
            db.execute("UPDATE messages SET status='cancelled',updated_at=? WHERE id=?", (_now(), message_id))
            return self._public(db, self._row(db, message_id))

    def record_reply(self, message_id, body):
        message_id = self._id(message_id)
        _fields(body, ("reply_id", "text", "sender", "created_at", "sender_id", "sender_type"))
        reply = dict(reply_id=_text(body.get("reply_id"), "reply_id", 200), text=_text(body.get("text"), "text", MAX_RESPONSE))
        if body.get("sender") is not None:
            reply["sender"] = _text(body["sender"], "sender", 200)
        if body.get("sender_id") is not None:
            reply["sender_id"] = _text(body["sender_id"], "sender_id", 200)
        if body.get("sender_type") is not None:
            if body["sender_type"] not in ("human", "agent"):
                raise OutboxError(400, "BAD_REQUEST", "回复身份类型不正确")
            reply["sender_type"] = body["sender_type"]
        if body.get("created_at") is not None:
            created = _text(body["created_at"], "created_at", 80)
            try:
                parsed = dt.datetime.fromisoformat(created.replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    raise ValueError()
            except ValueError:
                raise OutboxError(400, "BAD_REQUEST", "回复 created_at 必须包含时区") from None
            reply["created_at"] = parsed.astimezone(dt.timezone.utc).isoformat()
        encoded = json.dumps(reply, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with self._transaction() as db:
            self._expire(db)
            row = self._row(db, message_id)
            if row["status"] != "sent":
                raise OutboxError(409, "RECEIPT_REQUIRED", "须先核对发送回执，才能绑定 Raft 回复")
            prior = db.execute("SELECT * FROM replies WHERE reply_id=?", (reply["reply_id"],)).fetchone()
            if prior is not None:
                if prior["message_id"] != message_id or prior["payload_json"] != encoded:
                    raise OutboxError(409, "REPLY_ID_CONFLICT", "同一 Raft 回复编号已绑定另一条回复")
            else:
                db.execute("INSERT INTO replies(reply_id,message_id,payload_json,received_at) VALUES(?,?,?,?)", (reply["reply_id"], message_id, encoded, _now()))
                db.execute("UPDATE messages SET updated_at=? WHERE id=?", (_now(), message_id))
            return self._public(db, self._row(db, message_id))

    def status(self):
        with self._transaction() as db:
            self._expire(db)
            counts = {status: 0 for status in sorted(STATUSES)}
            counts.update({row["status"]: row["n"] for row in db.execute("SELECT status,COUNT(*) AS n FROM messages GROUP BY status")})
            return {"enabled": bool(self.allowed_targets), "allowed_targets": sorted(self.allowed_targets), "counts": counts,
                    "manual_text_only": True, "automatic_retry": False, "lease_seconds": LEASE_SECONDS}
